import assert from "node:assert/strict";
import test from "node:test";
import {
  manualRetryHandoffJob,
  processHandoffJob,
  processPendingHandoffJobs,
} from "./index.js";
import { providerAdapter } from "./provider-adapter.js";

const jobId = "handoff-job-1";
const notifyRequestId = "notify-request-1";
const idempotencyKey = "restock-cycle:4";
const emailSentinel = "private-customer@example.com";
const baseTime = new Date("2026-10-06T10:00:00.000Z");

function createFixture({
  job = {},
  request = {},
  jobs = null,
} = {}) {
  const state = {
    request: {
      id: notifyRequestId,
      shopId: "shop-record-1",
      productShopifyId: "gid://shopify/Product/123",
      variantShopifyId: "gid://shopify/ProductVariant/456",
      verifiedCustomerShopifyId: "gid://shopify/Customer/789",
      normalizedContact: emailSentinel,
      channel: "EMAIL",
      consentText: "I agree to receive a restock email.",
      consentVersion: "notify-email-v1",
      consentedAt: new Date("2026-10-05T10:00:00.000Z"),
      status: "PENDING",
      shop: {
        id: "shop-record-1",
        shopifyShopId: "gid://shopify/Shop/101",
      },
      ...request,
    },
    jobs:
      jobs?.map((existing) => ({ ...existing })) ?? [
        {
          id: jobId,
          notifyRequestId,
          idempotencyKey,
          status: "PENDING",
          attempts: 0,
          retryAt: null,
          providerReference: null,
          sanitizedErrorCode: null,
          sanitizedErrorMessage: null,
          createdAt: baseTime,
          ...job,
        },
      ],
    analyticsEvents: [],
  };

  const db = {
    state,
    handoffJob: {
      async findUnique({ where }) {
        const found = state.jobs.find(({ id }) => id === where.id);
        if (!found) {
          return null;
        }
        return {
          ...found,
          notifyRequest:
            found.notifyRequestId === state.request.id
              ? { ...state.request, shop: { ...state.request.shop } }
              : null,
        };
      },
      async findMany({ where }) {
        return state.jobs
          .filter((existing) => {
            if (existing.status !== where.status) {
              return false;
            }
            return where.OR.some(
              (condition) =>
                (condition.retryAt === null && existing.retryAt === null) ||
                (condition.retryAt?.lte &&
                  existing.retryAt instanceof Date &&
                  existing.retryAt <= condition.retryAt.lte),
            );
          })
          .map(({ id }) => ({ id }));
      },
      async updateMany({ where, data }) {
        const existing = state.jobs.find(({ id }) => id === where.id);
        if (!existing || existing.status !== where.status) {
          return { count: 0 };
        }
        if (
          where.notifyRequest?.is &&
          (state.request.shopId !== where.notifyRequest.is.shopId ||
            state.request.status !== where.notifyRequest.is.status)
        ) {
          return { count: 0 };
        }
        if (
          where.OR &&
          !where.OR.some(
            (condition) =>
              (condition.retryAt === null && existing.retryAt === null) ||
              (condition.retryAt?.lte &&
                existing.retryAt instanceof Date &&
                existing.retryAt <= condition.retryAt.lte),
          )
        ) {
          return { count: 0 };
        }
        const { attempts, ...fields } = data;
        Object.assign(existing, fields);
        if (attempts?.increment) {
          existing.attempts += attempts.increment;
        } else if (attempts !== undefined) {
          existing.attempts = attempts;
        }
        return { count: 1 };
      },
    },
    notifyRequest: {
      async updateMany({ where, data }) {
        if (
          state.request.id !== where.id ||
          state.request.status !== where.status
        ) {
          return { count: 0 };
        }
        Object.assign(state.request, data);
        return { count: 1 };
      },
    },
    analyticsEvent: {
      async create({ data }) {
        if (
          state.analyticsEvents.some(
            (event) =>
              event.shopId === data.shopId && event.eventKey === data.eventKey,
          )
        ) {
          const error = new Error("duplicate event");
          error.code = "P2002";
          throw error;
        }
        state.analyticsEvents.push(data);
        return data;
      },
    },
    async $transaction(callback) {
      return callback(db);
    },
  };

  return db;
}

test("no pending jobs returns an empty successful summary", async () => {
  let calls = 0;
  const db = createFixture({ jobs: [] });
  const summary = await processPendingHandoffJobs({
    db,
    adapter: {
      async sendRestockNotification() {
        calls += 1;
        return { outcome: "accepted" };
      },
    },
    now: baseTime,
  });

  assert.deepEqual(summary, {
    status: "completed",
    candidateCount: 0,
    processedCount: 0,
    acceptedCount: 0,
    retryingCount: 0,
    failedCount: 0,
    skippedCount: 0,
    failures: [],
  });
  assert.equal(calls, 0);
});

test("default provider adapter records not configured without accepting", async () => {
  const db = createFixture();
  const result = await processHandoffJob({ db, jobId, now: baseTime });

  assert.deepEqual(result, {
    jobId,
    status: "FAILED",
    errorCode: "provider_not_configured",
  });
  assert.equal(db.state.jobs[0].status, "FAILED");
  assert.equal(db.state.jobs[0].providerReference, null);
  assert.equal(
    db.state.jobs[0].sanitizedErrorCode,
    "provider_not_configured",
  );
  assert.equal(db.state.request.status, "PENDING");
  assert.equal(db.state.analyticsEvents.length, 0);
});

test("accepted adapter result records acceptance and de-eligibilizes the request", async () => {
  const db = createFixture();
  let payload;
  const result = await processHandoffJob({
    db,
    jobId,
    now: baseTime,
    adapter: {
      async sendRestockNotification(input) {
        payload = input;
        return {
          outcome: "accepted",
          providerReference: "provider-reference-123",
        };
      },
    },
  });

  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.outcome, "accepted_by_tool");
  assert.equal(db.state.jobs[0].providerReference, "provider-reference-123");
  assert.equal(db.state.request.status, "ACTIVE");
  assert.deepEqual(db.state.analyticsEvents, [
    {
      eventKey: `handoff:${jobId}:accepted`,
      type: "HANDOFF_ACCEPTED",
      shopId: "shop-record-1",
      productShopifyId: "gid://shopify/Product/123",
      variantShopifyId: "gid://shopify/ProductVariant/456",
      notifyRequestId,
      verifiedCustomerShopifyId: "gid://shopify/Customer/789",
      sourceSurface: "RESTOCK_WORKER",
      restockCycle: 4,
      occurredAt: baseTime,
    },
  ]);
  assert.equal(payload.idempotencyKey, idempotencyKey);
  assert.equal(payload.contact, emailSentinel);
  assert.equal(payload.consent.version, "notify-email-v1");
});

test("transient failure increments attempts and schedules exponential backoff", async () => {
  const db = createFixture();
  const result = await processHandoffJob({
    db,
    jobId,
    now: baseTime,
    adapter: {
      async sendRestockNotification() {
        return { outcome: "transient_failure" };
      },
    },
  });

  assert.equal(result.status, "PENDING");
  assert.equal(result.errorCode, "provider_transient_failure");
  assert.equal(db.state.jobs[0].attempts, 1);
  assert.equal(
    db.state.jobs[0].retryAt.toISOString(),
    "2026-10-06T10:01:00.000Z",
  );
});

test("three transient failures stop automatic retries", async () => {
  const db = createFixture();
  const adapter = {
    async sendRestockNotification() {
      return { outcome: "transient_failure" };
    },
  };

  const first = await processHandoffJob({ db, jobId, adapter, now: baseTime });
  const second = await processHandoffJob({
    db,
    jobId,
    adapter,
    now: new Date("2026-10-06T10:01:00.000Z"),
  });
  const third = await processHandoffJob({
    db,
    jobId,
    adapter,
    now: new Date("2026-10-06T10:03:00.000Z"),
  });

  assert.equal(first.status, "PENDING");
  assert.equal(second.status, "PENDING");
  assert.equal(third.status, "FAILED");
  assert.equal(third.errorCode, "retry_limit_reached");
  assert.equal(db.state.jobs[0].attempts, 3);
  assert.equal(db.state.jobs[0].retryAt, null);
  assert.equal(db.state.analyticsEvents.length, 1);
  assert.equal(db.state.analyticsEvents[0].type, "HANDOFF_FAILED");
  assert.equal(db.state.analyticsEvents[0].eventKey, `handoff:${jobId}:failed`);
  assert.equal(db.state.analyticsEvents[0].restockCycle, 4);
});

test("permanent adapter failure is not automatically retried", async () => {
  const db = createFixture();
  const result = await processHandoffJob({
    db,
    jobId,
    now: baseTime,
    adapter: {
      async sendRestockNotification() {
        return { outcome: "permanent_failure", errorCode: emailSentinel };
      },
    },
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.errorCode, "provider_rejected");
  assert.equal(db.state.jobs[0].attempts, 1);
  assert.equal(db.state.jobs[0].retryAt, null);
  assert.equal(db.state.jobs[0].sanitizedErrorMessage.includes(emailSentinel), false);
  assert.equal(db.state.analyticsEvents.length, 1);
  assert.equal(db.state.analyticsEvents[0].type, "HANDOFF_FAILED");
  assert.equal(db.state.analyticsEvents[0].eventKey, `handoff:${jobId}:failed`);
});

test("manual retries do not duplicate the final failed handoff fact", async () => {
  const db = createFixture();
  const adapter = {
    async sendRestockNotification() {
      return { outcome: "permanent_failure", errorCode: "rejected" };
    },
  };

  await processHandoffJob({ db, jobId, adapter, now: baseTime });
  const retry = await manualRetryHandoffJob({ db, jobId, shopId: "shop-record-1" });
  assert.equal(retry.status, "PENDING");
  await processHandoffJob({
    db,
    jobId,
    adapter,
    now: new Date(baseTime.getTime() + 1_000),
  });

  assert.equal(db.state.analyticsEvents.length, 1);
  assert.equal(db.state.analyticsEvents[0].eventKey, `handoff:${jobId}:failed`);
});

test("already accepted job is not handed off again", async () => {
  const db = createFixture({ job: { status: "SUCCEEDED" } });
  let calls = 0;
  const result = await processHandoffJob({
    db,
    jobId,
    adapter: {
      async sendRestockNotification() {
        calls += 1;
        return { outcome: "accepted" };
      },
    },
    now: baseTime,
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "job_not_pending");
  assert.equal(calls, 0);
  assert.equal(db.state.jobs[0].status, "SUCCEEDED");
});

test("same failed job can be manually retried without changing idempotency identity", async () => {
  const db = createFixture({
    job: {
      status: "FAILED",
      attempts: 3,
      sanitizedErrorCode: "retry_limit_reached",
      sanitizedErrorMessage: "Automatic retry limit reached.",
    },
  });
  const result = await manualRetryHandoffJob({ db, jobId, shopId: "shop-record-1" });

  assert.equal(result.status, "PENDING");
  assert.equal(result.idempotencyPreserved, true);
  assert.equal(db.state.jobs.length, 1);
  assert.equal(db.state.jobs[0].id, jobId);
  assert.equal(db.state.jobs[0].idempotencyKey, idempotencyKey);
  assert.equal(db.state.jobs[0].attempts, 0);
  assert.equal(db.state.jobs[0].retryAt, null);
  assert.equal(db.state.analyticsEvents.length, 0);
  assert.equal(db.state.jobs[0].sanitizedErrorCode, null);
});

test("manual retry cannot reopen a request that is no longer pending", async () => {
  const db = createFixture({
    job: { status: "FAILED" },
    request: { status: "ACTIVE" },
  });
  const result = await manualRetryHandoffJob({ db, jobId, shopId: "shop-record-1" });

  assert.equal(result.status, "FAILED");
  assert.equal(result.errorCode, "request_not_eligible");
  assert.equal(db.state.jobs[0].status, "FAILED");
});

test("manual retry cannot operate on another merchant's job", async () => {
  const db = createFixture({ job: { status: "FAILED" } });
  const result = await manualRetryHandoffJob({ db, jobId, shopId: "shop-record-b" });
  assert.equal(result.status, "FAILED");
  assert.equal(result.errorCode, "request_not_eligible");
  assert.equal(db.state.jobs[0].status, "FAILED");
});

test("invalid request-to-shop relationship is rejected before adapter handoff", async () => {
  const db = createFixture({
    request: {
      shop: {
        id: "different-shop-record",
        shopifyShopId: "gid://shopify/Shop/101",
      },
    },
  });
  let calls = 0;
  const result = await processHandoffJob({
    db,
    jobId,
    now: baseTime,
    adapter: {
      async sendRestockNotification() {
        calls += 1;
        return { outcome: "accepted" };
      },
    },
  });

  assert.equal(result.errorCode, "invalid_request");
  assert.equal(db.state.jobs[0].status, "FAILED");
  assert.equal(calls, 0);
});

test("future retry jobs are not selected or processed", async () => {
  const db = createFixture({
    job: { retryAt: new Date("2026-10-06T10:01:00.000Z") },
  });
  const summary = await processPendingHandoffJobs({
    db,
    now: baseTime,
    adapter: providerAdapter,
  });

  assert.equal(summary.candidateCount, 0);
  assert.equal(db.state.jobs[0].status, "PENDING");
});

test("provider errors and returned summaries never expose customer contact or consent", async () => {
  const db = createFixture();
  const summary = await processPendingHandoffJobs({
    db,
    now: baseTime,
    adapter: {
      async sendRestockNotification() {
        throw new Error(
          `${emailSentinel} consent text ${db.state.request.consentText}`,
        );
      },
    },
  });
  const serialized = JSON.stringify({
    summary,
    result: db.state.jobs[0],
  });

  assert.equal(serialized.includes(emailSentinel), false);
  assert.equal(serialized.includes(db.state.request.consentText), false);
  assert.equal(serialized.includes("notify-email-v1"), false);
  assert.equal(
    db.state.jobs[0].sanitizedErrorMessage,
    "Notification provider temporarily failed.",
  );
});

test("one job processing error does not stop the remaining candidates", async () => {
  const db = createFixture({
    jobs: [
      {
        id: "handoff-job-error",
        notifyRequestId,
        idempotencyKey: "restock-cycle:3",
        status: "PENDING",
        attempts: 0,
        retryAt: null,
        createdAt: baseTime,
      },
      {
        id: "handoff-job-next",
        notifyRequestId,
        idempotencyKey,
        status: "PENDING",
        attempts: 0,
        retryAt: null,
        createdAt: new Date(baseTime.getTime() + 1),
      },
    ],
  });
  const findUnique = db.handoffJob.findUnique;
  let failedFirstLookup = false;
  db.handoffJob.findUnique = async (input) => {
    if (input.where.id === "handoff-job-error" && !failedFirstLookup) {
      failedFirstLookup = true;
      throw new Error(emailSentinel);
    }
    return findUnique(input);
  };
  const summary = await processPendingHandoffJobs({
    db,
    adapter: providerAdapter,
    now: baseTime,
  });

  assert.equal(summary.candidateCount, 2);
  assert.equal(summary.failedCount, 2);
  assert.equal(summary.status, "completed_with_errors");
  assert.deepEqual(summary.failures, [
    { jobId: "handoff-job-error", errorCode: "processing_failed" },
    { jobId: "handoff-job-next", errorCode: "provider_not_configured" },
  ]);
});

test("only eligible pending jobs are claimed once under concurrent processing", async () => {
  const db = createFixture();
  let releaseAdapter;
  let signalAdapter;
  const adapterStarted = new Promise((resolve) => {
    signalAdapter = resolve;
  });
  const adapterGate = new Promise((resolve) => {
    releaseAdapter = resolve;
  });
  const firstRun = processHandoffJob({
    db,
    jobId,
    now: baseTime,
    adapter: {
      async sendRestockNotification() {
        signalAdapter();
        await adapterGate;
        return { outcome: "accepted" };
      },
    },
  });
  await adapterStarted;
  const concurrentResult = await processHandoffJob({
    db,
    jobId,
    now: baseTime,
    adapter: {
      async sendRestockNotification() {
        assert.fail("concurrent handoff must not invoke the adapter");
      },
    },
  });
  releaseAdapter();
  await firstRun;

  assert.equal(concurrentResult.status, "skipped");
  assert.equal(concurrentResult.reason, "job_not_pending");
  assert.equal(db.state.jobs[0].attempts, 1);
  assert.equal(db.state.jobs[0].status, "SUCCEEDED");
});
