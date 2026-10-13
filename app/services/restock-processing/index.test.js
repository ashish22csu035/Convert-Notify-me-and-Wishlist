import assert from "node:assert/strict";
import test from "node:test";
import { processRestock } from "./index.js";

const shopId = "shop-record-1";
const otherShopId = "shop-record-2";
const variantShopifyId = "gid://shopify/ProductVariant/456";
const restockCycle = 1;

function makeDatabase({
  availability = {
    shopId,
    variantShopifyId,
    restockCycle,
    previousAvailable: false,
    latestAvailable: true,
  },
  requests = [],
  jobs = [],
} = {}) {
  const state = {
    availability,
    requests: requests.map((request) => ({ ...request })),
    jobs: jobs.map((job) => ({ ...job })),
  };

  return {
    state,
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
                state.jobs.push({ id: `job-${state.jobs.length + 1}`, ...job });
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

function pendingRequest(id, overrides = {}) {
  return {
    id,
    shopId,
    variantShopifyId,
    status: "PENDING",
    ...overrides,
  };
}

function process(db, overrides = {}) {
  return processRestock({
    db,
    shopId,
    variantShopifyId,
    restockCycle,
    restockDetected: true,
    ...overrides,
  });
}

test("restockDetected false creates no HandoffJob", async () => {
  const db = makeDatabase({ requests: [pendingRequest("request-1")] });

  const summary = await process(db, {
    restockDetected: false,
    restockCycle: 0,
  });

  assert.equal(summary.reason, "restock_not_detected");
  assert.equal(summary.createdCount, 0);
  assert.equal(db.state.jobs.length, 0);
});

test("first availability observation at cycle zero creates no HandoffJob", async () => {
  const db = makeDatabase({
    availability: {
      shopId,
      variantShopifyId,
      restockCycle: 0,
      previousAvailable: null,
      latestAvailable: true,
    },
    requests: [pendingRequest("request-1")],
  });

  const summary = await process(db, {
    restockDetected: false,
    restockCycle: 0,
  });

  assert.equal(summary.processed, false);
  assert.equal(db.state.jobs.length, 0);
});

test("a stored available to unavailable state cannot be processed as a restock", async () => {
  const db = makeDatabase({
    availability: {
      shopId,
      variantShopifyId,
      restockCycle,
      previousAvailable: true,
      latestAvailable: false,
    },
    requests: [pendingRequest("request-1")],
  });

  const summary = await process(db);

  assert.equal(summary.reason, "restock_not_confirmed");
  assert.equal(summary.createdCount, 0);
  assert.equal(db.state.jobs.length, 0);
});

test("confirmed unavailable to available creates one pending HandoffJob", async () => {
  const db = makeDatabase({ requests: [pendingRequest("request-1")] });

  const summary = await process(db);

  assert.equal(summary.createdCount, 1);
  assert.equal(summary.eligibleCount, 1);
  assert.deepEqual(db.state.jobs, [
    {
      id: "job-1",
      notifyRequestId: "request-1",
      idempotencyKey: "restock-cycle:1",
      status: "PENDING",
      attempts: 0,
    },
  ]);
});

test("processing the same restock cycle twice does not create duplicate jobs", async () => {
  const db = makeDatabase({ requests: [pendingRequest("request-1")] });

  const first = await process(db);
  const second = await process(db);

  assert.equal(first.createdCount, 1);
  assert.equal(second.createdCount, 0);
  assert.equal(second.alreadyProcessedCount, 1);
  assert.equal(db.state.jobs.length, 1);
});

test("each pending request for the variant gets one HandoffJob", async () => {
  const db = makeDatabase({
    requests: [
      pendingRequest("request-1"),
      pendingRequest("request-2"),
      pendingRequest("request-3"),
    ],
  });

  const summary = await process(db);

  assert.equal(summary.eligibleCount, 3);
  assert.equal(summary.createdCount, 3);
  assert.deepEqual(
    db.state.jobs.map((job) => job.notifyRequestId),
    ["request-1", "request-2", "request-3"],
  );
});

test("requests belonging to another shop are not processed", async () => {
  const db = makeDatabase({
    requests: [
      pendingRequest("request-local"),
      pendingRequest("request-other-shop", { shopId: otherShopId }),
    ],
  });

  const summary = await process(db);

  assert.equal(summary.eligibleCount, 1);
  assert.deepEqual(
    db.state.jobs.map((job) => job.notifyRequestId),
    ["request-local"],
  );
});

test("requests outside the PENDING lifecycle state are not processed", async () => {
  const db = makeDatabase({
    requests: [
      pendingRequest("request-pending"),
      pendingRequest("request-active", { status: "ACTIVE" }),
      pendingRequest("request-notified", { status: "NOTIFIED" }),
      pendingRequest("request-closed", { status: "CLOSED" }),
      pendingRequest("request-unsubscribed", { status: "UNSUBSCRIBED" }),
    ],
  });

  const summary = await process(db);

  assert.equal(summary.eligibleCount, 1);
  assert.deepEqual(
    db.state.jobs.map((job) => job.notifyRequestId),
    ["request-pending"],
  );
});

test("a later restock cycle can create a distinct job for a pending request", async () => {
  const db = makeDatabase({
    availability: {
      shopId,
      variantShopifyId,
      restockCycle: 2,
      previousAvailable: false,
      latestAvailable: true,
    },
    requests: [pendingRequest("request-1")],
    jobs: [
      {
        id: "job-previous-cycle",
        notifyRequestId: "request-1",
        idempotencyKey: "restock-cycle:1",
        status: "PENDING",
        attempts: 0,
      },
    ],
  });

  const summary = await process(db, { restockCycle: 2 });

  assert.equal(summary.createdCount, 1);
  assert.deepEqual(
    db.state.jobs.map((job) => job.idempotencyKey),
    ["restock-cycle:1", "restock-cycle:2"],
  );
});
