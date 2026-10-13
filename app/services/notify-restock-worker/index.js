import applicationDb from "../../application-db.server.js";
import { processRestock } from "../restock-processing/index.js";
import { checkVariantAvailability } from "../variant-availability/index.js";

let workerRunning = false;

function createSummary(status, startedAt) {
  return {
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    candidateCount: 0,
    pendingRequestCount: 0,
    checkedCount: 0,
    restockDetectedCount: 0,
    handoffJobsCreatedCount: 0,
    failures: [],
  };
}

function addFailure(summary, candidate, stage, code) {
  summary.failures.push({
    ...(candidate
      ? {
          shopId: candidate.shopId,
          shopifyShopId: candidate.shopifyShopId,
          variantShopifyId: candidate.variantShopifyId,
        }
      : {}),
    stage,
    code,
  });
}

async function runWorker({
  db,
  resolveAdmin,
  availabilityCheck,
  restockProcessor,
}) {
  const summary = createSummary("completed", new Date().toISOString());
  let candidateGroups;

  try {
    candidateGroups = await db.notifyRequest.groupBy({
      by: ["shopId", "variantShopifyId"],
      where: { status: "PENDING" },
      _count: { _all: true },
    });
  } catch {
    addFailure(summary, null, "candidate_lookup", "candidate_lookup_failed");
    summary.status = "failed";
    summary.completedAt = new Date().toISOString();
    return summary;
  }

  summary.candidateCount = candidateGroups.length;
  summary.pendingRequestCount = candidateGroups.reduce(
    (total, candidate) => total + candidate._count._all,
    0,
  );

  if (candidateGroups.length === 0) {
    summary.completedAt = new Date().toISOString();
    return summary;
  }

  let shops;
  try {
    const shopIds = [...new Set(candidateGroups.map(({ shopId }) => shopId))];
    shops = await db.shop.findMany({
      where: { id: { in: shopIds } },
      select: { id: true, shopifyShopId: true, domain: true },
    });
  } catch {
    for (const group of candidateGroups) {
      addFailure(
        summary,
        { ...group, shopifyShopId: null },
        "shop_lookup",
        "shop_lookup_failed",
      );
    }
    summary.status = "completed_with_errors";
    summary.completedAt = new Date().toISOString();
    return summary;
  }

  const shopsById = new Map(shops.map((shop) => [shop.id, shop]));
  const adminByShopId = new Map();

  for (const group of candidateGroups) {
    const shop = shopsById.get(group.shopId);
    const candidate = {
      shopId: group.shopId,
      shopifyShopId: shop?.shopifyShopId ?? null,
      variantShopifyId: group.variantShopifyId,
    };

    if (!shop) {
      addFailure(summary, candidate, "shop_lookup", "shop_not_found");
      continue;
    }

    let admin;
    try {
      let adminPromise = adminByShopId.get(shop.id);
      if (!adminPromise) {
        adminPromise = resolveAdmin(shop.domain).then(({ admin }) => admin);
        adminByShopId.set(shop.id, adminPromise);
      }
      admin = await adminPromise;
    } catch {
      addFailure(summary, candidate, "admin_context", "admin_context_failed");
      continue;
    }

    let observation;
    try {
      observation = await availabilityCheck({
        admin,
        shopifyShopId: shop.shopifyShopId,
        variantShopifyId: group.variantShopifyId,
      });
    } catch {
      addFailure(
        summary,
        candidate,
        "availability_check",
        "availability_check_failed",
      );
      continue;
    }

    if (
      typeof observation?.restockDetected !== "boolean" ||
      !Number.isSafeInteger(observation.availability?.restockCycle)
    ) {
      addFailure(
        summary,
        candidate,
        "availability_check",
        "availability_result_invalid",
      );
      continue;
    }

    summary.checkedCount += 1;
    if (!observation.restockDetected) {
      continue;
    }

    summary.restockDetectedCount += 1;
    try {
      const result = await restockProcessor({
        db,
        shopId: group.shopId,
        variantShopifyId: group.variantShopifyId,
        restockCycle: observation.availability.restockCycle,
        restockDetected: observation.restockDetected,
      });
      if (Number.isSafeInteger(result?.createdCount) && result.createdCount > 0) {
        summary.handoffJobsCreatedCount += result.createdCount;
      }
    } catch {
      addFailure(
        summary,
        candidate,
        "restock_processing",
        "restock_processing_failed",
      );
    }
  }

  if (summary.failures.length > 0) {
    summary.status = "completed_with_errors";
  }
  summary.completedAt = new Date().toISOString();
  return summary;
}

export async function runNotifyRestockWorker({
  db = applicationDb,
  resolveAdmin,
  availabilityCheck = checkVariantAvailability,
  restockProcessor = processRestock,
} = {}) {
  if (workerRunning) {
    return {
      ...createSummary("skipped", new Date().toISOString()),
      reason: "already_running",
    };
  }

  if (
    typeof resolveAdmin !== "function" ||
    typeof availabilityCheck !== "function" ||
    typeof restockProcessor !== "function"
  ) {
    throw new TypeError("Notify restock worker dependencies are invalid");
  }

  workerRunning = true;
  try {
    return await runWorker({
      db,
      resolveAdmin,
      availabilityCheck,
      restockProcessor,
    });
  } finally {
    workerRunning = false;
  }
}
