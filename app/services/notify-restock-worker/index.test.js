import assert from "node:assert/strict";
import test from "node:test";
import { processRestock } from "../restock-processing/index.js";
import { runNotifyRestockWorker } from "./index.js";

const emailSentinel = "private-customer@example.com";
const shopOneId = "shop-record-1";
const shopTwoId = "shop-record-2";
const shopOneGid = "gid://shopify/Shop/101";
const shopTwoGid = "gid://shopify/Shop/202";
const variantOneGid = "gid://shopify/ProductVariant/456";
const variantTwoGid = "gid://shopify/ProductVariant/789";

function candidate(shopId, variantShopifyId, count = 1) {
  return {
    shopId,
    variantShopifyId,
    _count: { _all: count },
  };
}

function makeDatabase({
  candidates = [],
  shops = [
    {
      id: shopOneId,
      shopifyShopId: shopOneGid,
      domain: "one.myshopify.com",
    },
    {
      id: shopTwoId,
      shopifyShopId: shopTwoGid,
      domain: "two.myshopify.com",
    },
  ],
  availability = null,
  requests = [],
} = {}) {
  const state = {
    candidates,
    shops,
    availability,
    requests: requests.map((request) => ({ ...request })),
    jobs: [],
  };

  return {
    state,
    notifyRequest: {
      async groupBy({ where }) {
        assert.deepEqual(where, { status: "PENDING" });
        return state.candidates;
      },
    },
    shop: {
      async findMany({ where }) {
        return state.shops.filter((shop) => where.id.in.includes(shop.id));
      },
    },
    async $transaction(callback) {
      const transactionDb = {
        variantAvailability: {
          async findFirst({ where }) {
            const record = state.availability;
            if (
              !record ||
              record.shopId !== where.shopId ||
              record.variantShopifyId !== where.variantShopifyId ||
              record.restockCycle !== where.restockCycle ||
              record.previousAvailable !== where.previousAvailable ||
              record.latestAvailable !== where.latestAvailable
            ) {
              return null;
            }
            return { id: "availability-1" };
          },
        },
        notifyRequest: {
          async findMany({ where }) {
            return state.requests
              .filter(
                (request) =>
                  request.shopId === where.shopId &&
                  request.variantShopifyId === where.variantShopifyId &&
                  request.status === where.status,
              )
              .map(({ id }) => ({ id }));
          },
        },
        handoffJob: {
          async createMany({ data, skipDuplicates }) {
            assert.equal(skipDuplicates, true);
            let count = 0;
            for (const job of data) {
              const duplicate = state.jobs.some(
                (existing) =>
                  existing.notifyRequestId === job.notifyRequestId &&
                  existing.idempotencyKey === job.idempotencyKey,
              );
              if (!duplicate) {
                state.jobs.push({ ...job });
                count += 1;
              }
            }
            return { count };
          },
        },
      };
      return callback(transactionDb);
    },
  };
}

function makeWorker(db, overrides = {}) {
  return runNotifyRestockWorker({
    db,
    resolveAdmin: async (domain) => ({ admin: { domain } }),
    availabilityCheck: async () => ({
      availability: { restockCycle: 0 },
      restockDetected: false,
    }),
    ...overrides,
  });
}

test("no pending requests completes without checking availability", async () => {
  let checks = 0;
  const summary = await makeWorker(makeDatabase(), {
    availabilityCheck: async () => {
      checks += 1;
      throw new Error("should not run");
    },
  });

  assert.equal(summary.status, "completed");
  assert.equal(summary.candidateCount, 0);
  assert.equal(summary.checkedCount, 0);
  assert.equal(checks, 0);
});

test("unavailable variant is checked without restock processing or jobs", async () => {
  let processed = 0;
  const db = makeDatabase({
    candidates: [candidate(shopOneId, variantOneGid)],
  });
  const summary = await makeWorker(db, {
    availabilityCheck: async ({ admin, shopifyShopId, variantShopifyId }) => {
      assert.equal(admin.domain, "one.myshopify.com");
      assert.equal(shopifyShopId, shopOneGid);
      assert.equal(variantShopifyId, variantOneGid);
      return {
        availability: { restockCycle: 0 },
        restockDetected: false,
      };
    },
    restockProcessor: async () => {
      processed += 1;
      return { createdCount: 0 };
    },
  });

  assert.equal(summary.checkedCount, 1);
  assert.equal(summary.restockDetectedCount, 0);
  assert.equal(processed, 0);
  assert.equal(db.state.jobs.length, 0);
});

test("detected restock invokes the existing processor and creates a HandoffJob", async () => {
  const db = makeDatabase({
    candidates: [candidate(shopOneId, variantOneGid)],
    availability: {
      shopId: shopOneId,
      variantShopifyId: variantOneGid,
      restockCycle: 1,
      previousAvailable: false,
      latestAvailable: true,
    },
    requests: [
      {
        id: "request-1",
        shopId: shopOneId,
        variantShopifyId: variantOneGid,
        status: "PENDING",
        normalizedContact: emailSentinel,
      },
    ],
  });
  const summary = await makeWorker(db, {
    availabilityCheck: async () => ({
      availability: { restockCycle: 1 },
      restockDetected: true,
    }),
    restockProcessor: processRestock,
  });

  assert.equal(summary.restockDetectedCount, 1);
  assert.equal(summary.handoffJobsCreatedCount, 1);
  assert.deepEqual(db.state.jobs, [
    {
      notifyRequestId: "request-1",
      idempotencyKey: "restock-cycle:1",
      status: "PENDING",
      attempts: 0,
    },
  ]);
});

test("each distinct shop and variant combination is checked in its own shop context", async () => {
  const db = makeDatabase({
    candidates: [
      candidate(shopOneId, variantOneGid),
      candidate(shopOneId, variantTwoGid),
      candidate(shopTwoId, variantOneGid),
    ],
  });
  const checked = [];
  const summary = await makeWorker(db, {
    availabilityCheck: async (input) => {
      checked.push({
        domain: input.admin.domain,
        shopifyShopId: input.shopifyShopId,
        variantShopifyId: input.variantShopifyId,
      });
      return {
        availability: { restockCycle: 0 },
        restockDetected: false,
      };
    },
  });

  assert.equal(summary.candidateCount, 3);
  assert.equal(summary.checkedCount, 3);
  assert.deepEqual(checked, [
    {
      domain: "one.myshopify.com",
      shopifyShopId: shopOneGid,
      variantShopifyId: variantOneGid,
    },
    {
      domain: "one.myshopify.com",
      shopifyShopId: shopOneGid,
      variantShopifyId: variantTwoGid,
    },
    {
      domain: "two.myshopify.com",
      shopifyShopId: shopTwoGid,
      variantShopifyId: variantOneGid,
    },
  ]);
});

test("a failed variant is recorded without stopping later checks", async () => {
  const db = makeDatabase({
    candidates: [
      candidate(shopOneId, variantOneGid),
      candidate(shopTwoId, variantTwoGid),
    ],
  });
  const checked = [];
  const summary = await makeWorker(db, {
    availabilityCheck: async ({ variantShopifyId }) => {
      checked.push(variantShopifyId);
      if (variantShopifyId === variantOneGid) {
        throw new Error(`GraphQL failed for ${emailSentinel}`);
      }
      return {
        availability: { restockCycle: 0 },
        restockDetected: false,
      };
    },
  });

  assert.deepEqual(checked, [variantOneGid, variantTwoGid]);
  assert.equal(summary.status, "completed_with_errors");
  assert.equal(summary.checkedCount, 1);
  assert.deepEqual(summary.failures, [
    {
      shopId: shopOneId,
      shopifyShopId: shopOneGid,
      variantShopifyId: variantOneGid,
      stage: "availability_check",
      code: "availability_check_failed",
    },
  ]);
  assert.equal(JSON.stringify(summary).includes(emailSentinel), false);
});

test("repeated runs rely on the restock processor to avoid duplicate HandoffJobs", async () => {
  const db = makeDatabase({
    candidates: [candidate(shopOneId, variantOneGid)],
    availability: {
      shopId: shopOneId,
      variantShopifyId: variantOneGid,
      restockCycle: 3,
      previousAvailable: false,
      latestAvailable: true,
    },
    requests: [
      {
        id: "request-1",
        shopId: shopOneId,
        variantShopifyId: variantOneGid,
        status: "PENDING",
      },
    ],
  });
  const options = {
    db,
    resolveAdmin: async () => ({ admin: { graphql() {} } }),
    availabilityCheck: async () => ({
      availability: { restockCycle: 3 },
      restockDetected: true,
    }),
    restockProcessor: processRestock,
  };

  const first = await runNotifyRestockWorker(options);
  const second = await runNotifyRestockWorker(options);

  assert.equal(first.handoffJobsCreatedCount, 1);
  assert.equal(second.handoffJobsCreatedCount, 0);
  assert.equal(db.state.jobs.length, 1);
});

test("overlapping invocations in one process are skipped", async () => {
  let releaseLookup;
  let signalLookupStarted;
  const lookupGate = new Promise((resolve) => {
    releaseLookup = resolve;
  });
  const lookupStarted = new Promise((resolve) => {
    signalLookupStarted = resolve;
  });
  const db = makeDatabase();
  db.notifyRequest.groupBy = async () => {
    signalLookupStarted();
    await lookupGate;
    return [];
  };

  const firstRun = makeWorker(db);
  await lookupStarted;
  const overlappingRun = await makeWorker(makeDatabase());

  assert.equal(overlappingRun.status, "skipped");
  assert.equal(overlappingRun.reason, "already_running");
  releaseLookup();
  assert.equal((await firstRun).status, "completed");
});

test("customer contact and consent data are excluded from worker results", async () => {
  const db = makeDatabase({
    candidates: [candidate(shopOneId, variantOneGid)],
    requests: [
      {
        id: "request-1",
        shopId: shopOneId,
        variantShopifyId: variantOneGid,
        status: "PENDING",
        normalizedContact: emailSentinel,
        consentText: "consent-sentinel",
        consentVersion: "consent-version-sentinel",
      },
    ],
  });
  const summary = await makeWorker(db, {
    availabilityCheck: async () => {
      throw new Error(
        `${emailSentinel} normalizedContact contactDeduplicationKey consent`,
      );
    },
  });

  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes(emailSentinel), false);
  assert.equal(serialized.includes("consent-sentinel"), false);
  assert.equal(serialized.includes("consent-version-sentinel"), false);
  assert.equal(serialized.includes("contactDeduplicationKey"), false);
});
