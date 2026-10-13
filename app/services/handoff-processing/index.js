import applicationDb from "../../application-db.server.js";
import { createAnalyticsEventOnce } from "../analytics/index.js";
import { providerAdapter as defaultProviderAdapter } from "./provider-adapter.js";

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60_000, 120_000];
const SANITIZED_ERRORS = {
  invalid_request: "Notify request data is invalid or no longer eligible.",
  provider_not_configured: "Notification provider is not configured.",
  provider_rejected: "Notification provider permanently rejected the handoff.",
  provider_transient_failure: "Notification provider temporarily failed.",
  provider_result_invalid: "Notification provider returned an invalid result.",
  retry_limit_reached: "Automatic retry limit reached.",
};

function isShopifyGid(value, resourceType) {
  return (
    typeof value === "string" &&
    new RegExp(`^gid://shopify/${resourceType}/[0-9]{1,20}$`).test(value)
  );
}

function failureResult(jobId, status, code) {
  return {
    jobId,
    status,
    errorCode: code,
  };
}

function parseRestockCycle(idempotencyKey) {
  const match = /^restock-cycle:([1-9][0-9]*)$/.exec(idempotencyKey);
  if (!match) {
    return null;
  }
  const cycle = Number(match[1]);
  return Number.isSafeInteger(cycle) ? cycle : null;
}

function validateRequest(job) {
  const request = job.notifyRequest;
  const restockCycle = parseRestockCycle(job.idempotencyKey);
  if (
    !request ||
    request.id !== job.notifyRequestId ||
    request.status !== "PENDING" ||
    typeof request.shopId !== "string" ||
    !request.shop ||
    request.shop.id !== request.shopId ||
    !isShopifyGid(request.shop.shopifyShopId, "Shop") ||
    !isShopifyGid(request.productShopifyId, "Product") ||
    !isShopifyGid(request.variantShopifyId, "ProductVariant") ||
    (request.verifiedCustomerShopifyId !== null &&
      request.verifiedCustomerShopifyId !== undefined &&
      !isShopifyGid(request.verifiedCustomerShopifyId, "Customer")) ||
    typeof request.normalizedContact !== "string" ||
    request.normalizedContact.length === 0 ||
    !["EMAIL", "SMS"].includes(request.channel) ||
    typeof request.consentText !== "string" ||
    request.consentText.length === 0 ||
    typeof request.consentVersion !== "string" ||
    request.consentVersion.length === 0 ||
    !(request.consentedAt instanceof Date) ||
    Number.isNaN(request.consentedAt.getTime()) ||
    restockCycle === null
  ) {
    return null;
  }

  return {
    request,
    restockCycle,
  };
}

function makeProviderPayload(job, request, restockCycle) {
  return {
    idempotencyKey: job.idempotencyKey,
    shopId: request.shopId,
    shopifyShopId: request.shop.shopifyShopId,
    notifyRequestId: request.id,
    restockCycle,
    productShopifyId: request.productShopifyId,
    variantShopifyId: request.variantShopifyId,
    channel: request.channel,
    contact: request.normalizedContact,
    verifiedCustomerShopifyId: request.verifiedCustomerShopifyId,
    consent: {
      text: request.consentText,
      version: request.consentVersion,
      consentedAt: request.consentedAt,
    },
  };
}

async function updateFailedJob(
  db,
  jobId,
  code,
  retryAt = null,
  failureFact = null,
) {
  const terminal = retryAt === null;
  await db.$transaction(async (transactionDb) => {
    const updated = await transactionDb.handoffJob.updateMany({
      where: { id: jobId, status: "PROCESSING" },
      data: {
        status: terminal ? "FAILED" : "PENDING",
        retryAt,
        sanitizedErrorCode: code,
        sanitizedErrorMessage: SANITIZED_ERRORS[code],
      },
    });
    if (updated.count === 1 && terminal && failureFact) {
      await createAnalyticsEventOnce(transactionDb, {
        eventKey: `handoff:${jobId}:failed`,
        type: "HANDOFF_FAILED",
        shopId: failureFact.request.shopId,
        productShopifyId: failureFact.request.productShopifyId,
        variantShopifyId: failureFact.request.variantShopifyId,
        notifyRequestId: failureFact.request.id,
        verifiedCustomerShopifyId:
          failureFact.request.verifiedCustomerShopifyId,
        sourceSurface: "RESTOCK_WORKER",
        restockCycle: failureFact.restockCycle,
        occurredAt: failureFact.occurredAt,
      });
    }
  });

  return failureResult(jobId, terminal ? "FAILED" : "PENDING", code);
}

async function persistAccepted(
  db,
  jobId,
  request,
  providerReference,
  occurredAt,
) {
  return db.$transaction(async (transactionDb) => {
    const updated = await transactionDb.handoffJob.updateMany({
      where: { id: jobId, status: "PROCESSING" },
      data: {
        status: "SUCCEEDED",
        retryAt: null,
        providerReference: providerReference ?? null,
        sanitizedErrorCode: null,
        sanitizedErrorMessage: null,
      },
    });
    if (updated.count === 1) {
      await transactionDb.notifyRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: { status: "ACTIVE" },
      });
      await createAnalyticsEventOnce(transactionDb, {
        eventKey: `handoff:${jobId}:accepted`,
        type: "HANDOFF_ACCEPTED",
        shopId: request.shopId,
        productShopifyId: request.productShopifyId,
        variantShopifyId: request.variantShopifyId,
        notifyRequestId: request.id,
        verifiedCustomerShopifyId: request.verifiedCustomerShopifyId,
        sourceSurface: "RESTOCK_WORKER",
        restockCycle: request.restockCycle,
        occurredAt,
      });
    }
    return updated.count === 1;
  });
}

async function claimJob(db, jobId, now) {
  const job = await db.handoffJob.findUnique({
    where: { id: jobId },
    select: { id: true, status: true, retryAt: true },
  });
  if (!job) {
    return { result: failureResult(jobId, "not_found", "job_not_found") };
  }
  if (job.status !== "PENDING") {
    return {
      result: {
        jobId,
        status: "skipped",
        reason: "job_not_pending",
      },
    };
  }
  if (job.retryAt && job.retryAt > now) {
    return {
      result: {
        jobId,
        status: "skipped",
        reason: "retry_not_due",
      },
    };
  }

  const claimed = await db.handoffJob.updateMany({
    where: {
      id: jobId,
      status: "PENDING",
      OR: [{ retryAt: null }, { retryAt: { lte: now } }],
    },
    data: {
      status: "PROCESSING",
      attempts: { increment: 1 },
      retryAt: null,
    },
  });
  if (claimed.count !== 1) {
    return {
      result: {
        jobId,
        status: "skipped",
        reason: "job_claimed_elsewhere",
      },
    };
  }

  return { claimed: true };
}

export async function processHandoffJob({
  db = applicationDb,
  jobId,
  adapter = defaultProviderAdapter,
  now = new Date(),
} = {}) {
  if (
    typeof jobId !== "string" ||
    jobId.length === 0 ||
    !adapter ||
    typeof adapter.sendRestockNotification !== "function" ||
    !(now instanceof Date) ||
    Number.isNaN(now.getTime())
  ) {
    throw new TypeError("Handoff processing input is invalid");
  }

  const claim = await claimJob(db, jobId, now);
  if (!claim.claimed) {
    return claim.result;
  }

  const job = await db.handoffJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      notifyRequestId: true,
      idempotencyKey: true,
      attempts: true,
      notifyRequest: {
        select: {
          id: true,
          shopId: true,
          productShopifyId: true,
          variantShopifyId: true,
          verifiedCustomerShopifyId: true,
          normalizedContact: true,
          channel: true,
          consentText: true,
          consentVersion: true,
          consentedAt: true,
          status: true,
          shop: {
            select: {
              id: true,
              shopifyShopId: true,
            },
          },
        },
      },
    },
  });

  const valid = job && validateRequest(job);
  if (!valid) {
    return updateFailedJob(db, jobId, "invalid_request");
  }

  let providerResult;
  let providerResponded = false;
  try {
    providerResult = await adapter.sendRestockNotification(
      makeProviderPayload(job, valid.request, valid.restockCycle),
    );
    providerResponded = true;
  } catch {
    providerResult = { outcome: "transient_failure" };
  }

  if (providerResult?.outcome === "accepted") {
    const providerReference =
      typeof providerResult.providerReference === "string" &&
      providerResult.providerReference.length > 0 &&
      providerResult.providerReference.length <= 191
        ? providerResult.providerReference
        : undefined;

    const persisted = await persistAccepted(
      db,
      jobId,
      { ...valid.request, restockCycle: valid.restockCycle },
      providerReference,
      now,
    );
    if (!persisted) {
      return {
        jobId,
        status: "accepted_unrecorded",
        outcome: "accepted_by_tool",
        errorCode: "job_state_changed",
      };
    }
    return {
      jobId,
      status: "SUCCEEDED",
      outcome: "accepted_by_tool",
    };
  }

  if (providerResult?.outcome === "transient_failure") {
    if (job.attempts >= MAX_ATTEMPTS) {
      return updateFailedJob(
        db,
        jobId,
        "retry_limit_reached",
        null,
        providerResponded
          ? {
              request: { ...valid.request, restockCycle: valid.restockCycle },
              restockCycle: valid.restockCycle,
              occurredAt: now,
            }
          : null,
      );
    }
    const retryAt = new Date(
      now.getTime() + RETRY_DELAYS_MS[job.attempts - 1],
    );
    return updateFailedJob(
      db,
      jobId,
      "provider_transient_failure",
      retryAt,
    );
  }

  const errorCode =
    providerResult?.outcome === "permanent_failure" &&
    providerResult.errorCode === "provider_not_configured"
      ? "provider_not_configured"
      : providerResult?.outcome === "permanent_failure"
        ? "provider_rejected"
        : "provider_result_invalid";
  return updateFailedJob(
    db,
    jobId,
    errorCode,
    null,
    providerResponded && errorCode !== "provider_not_configured"
      ? {
          request: { ...valid.request, restockCycle: valid.restockCycle },
          restockCycle: valid.restockCycle,
          occurredAt: now,
        }
      : null,
  );
}

export async function processPendingHandoffJobs({
  db = applicationDb,
  adapter = defaultProviderAdapter,
  now = new Date(),
} = {}) {
  if (
    !adapter ||
    typeof adapter.sendRestockNotification !== "function" ||
    !(now instanceof Date) ||
    Number.isNaN(now.getTime())
  ) {
    throw new TypeError("Handoff processing input is invalid");
  }

  const jobs = await db.handoffJob.findMany({
    where: {
      status: "PENDING",
      OR: [{ retryAt: null }, { retryAt: { lte: now } }],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  const summary = {
    status: "completed",
    candidateCount: jobs.length,
    processedCount: 0,
    acceptedCount: 0,
    retryingCount: 0,
    failedCount: 0,
    skippedCount: 0,
    failures: [],
  };

  for (const { id } of jobs) {
    let result;
    try {
      result = await processHandoffJob({ db, jobId: id, adapter, now });
    } catch {
      summary.failedCount += 1;
      summary.failures.push({
        jobId: id,
        errorCode: "processing_failed",
      });
      summary.status = "completed_with_errors";
      continue;
    }
    if (result.status === "skipped") {
      summary.skippedCount += 1;
      continue;
    }
    summary.processedCount += 1;
    if (result.outcome === "accepted_by_tool") {
      summary.acceptedCount += 1;
      if (result.status === "accepted_unrecorded") {
        summary.failedCount += 1;
        summary.failures.push({
          jobId: id,
          errorCode: result.errorCode,
        });
        summary.status = "completed_with_errors";
      }
    } else if (result.status === "PENDING") {
      summary.retryingCount += 1;
    } else if (result.status === "FAILED" || result.status === "not_found") {
      summary.failedCount += 1;
      summary.failures.push({
        jobId: result.jobId,
        errorCode: result.errorCode,
      });
    }
  }

  return summary;
}

export async function manualRetryHandoffJob({
  db = applicationDb,
  jobId,
  shopId,
} = {}) {
  if (
    typeof jobId !== "string" ||
    jobId.length === 0 ||
    typeof shopId !== "string" ||
    shopId.length === 0
  ) {
    throw new TypeError("Handoff job ID and merchant shop ID are required");
  }

  const job = await db.handoffJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      status: true,
      notifyRequestId: true,
      idempotencyKey: true,
      notifyRequest: {
        select: {
          id: true,
          shopId: true,
          status: true,
          productShopifyId: true,
          variantShopifyId: true,
          shop: {
            select: {
              id: true,
              shopifyShopId: true,
            },
          },
        },
      },
    },
  });
  if (!job) {
    return failureResult(jobId, "not_found", "job_not_found");
  }
  if (job.status !== "FAILED") {
    return {
      jobId,
      status: "skipped",
      reason: "job_not_failed",
    };
  }
  if (
    !job.notifyRequest ||
    job.notifyRequest.id !== job.notifyRequestId ||
    job.notifyRequest.shopId !== shopId ||
    job.notifyRequest.status !== "PENDING" ||
    job.notifyRequest.shopId !== job.notifyRequest.shop?.id ||
    !isShopifyGid(job.notifyRequest.shop?.shopifyShopId, "Shop") ||
    !isShopifyGid(job.notifyRequest.productShopifyId, "Product") ||
    !isShopifyGid(job.notifyRequest.variantShopifyId, "ProductVariant") ||
    parseRestockCycle(job.idempotencyKey) === null
  ) {
    return failureResult(jobId, "FAILED", "request_not_eligible");
  }

  const updated = await db.handoffJob.updateMany({
    where: {
      id: jobId,
      status: "FAILED",
      notifyRequest: { is: { shopId, status: "PENDING" } },
    },
    data: {
      status: "PENDING",
      attempts: 0,
      retryAt: null,
      providerReference: null,
      sanitizedErrorCode: null,
      sanitizedErrorMessage: null,
    },
  });

  return updated.count === 1
    ? { jobId, status: "PENDING", idempotencyPreserved: true }
    : {
        jobId,
        status: "skipped",
        reason: "job_changed_elsewhere",
      };
}
