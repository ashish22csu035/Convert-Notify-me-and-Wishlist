import assert from "node:assert/strict";
import test from "node:test";
import { persistAvailabilityObservation } from "./index.js";

const shopId = "shop-record-1";
const productShopifyId = "gid://shopify/Product/123";
const variantShopifyId = "gid://shopify/ProductVariant/456";
const checkedAt = new Date("2026-10-05T06:00:00.000Z");

function makeDatabase(existingRecord) {
  let record = existingRecord ? { ...existingRecord } : null;
  const events = [];

  return {
    events,
    async $transaction(callback) {
      const transactionDb = {
        variantAvailability: {
          async findUnique() {
            return record ? { ...record } : null;
          },
          async create({ data }) {
            record = { id: "availability-1", ...data };
            return { ...record };
          },
          async update({ where, data }) {
            assert.equal(where.id, record.id);
            record = {
              ...record,
              ...data,
              ...(data.restockCycle?.increment
                ? {
                    restockCycle:
                      record.restockCycle + data.restockCycle.increment,
                  }
                : {}),
            };
            return { ...record };
          },
        },
        analyticsEvent: {
          async create({ data }) {
            if (events.some((event) => event.shopId === data.shopId && event.eventKey === data.eventKey)) {
              const error = new Error("duplicate event");
              error.code = "P2002";
              throw error;
            }
            events.push(data);
            return data;
          },
        },
      };
      return callback(transactionDb);
    },
  };
}

function existingAvailability(latestAvailable, restockCycle = 0) {
  return {
    id: "availability-1",
    shopId,
    productShopifyId,
    variantShopifyId,
    previousAvailable: null,
    latestAvailable,
    lastCheckedAt: new Date("2026-10-04T06:00:00.000Z"),
    restockCycle,
  };
}

async function observe(db, available) {
  return persistAvailabilityObservation({
    db,
    shopId,
    productShopifyId,
    variantShopifyId,
    available,
    checkedAt,
  });
}

test("first check records state without treating it as a restock", async () => {
  const db = makeDatabase(null);
  const result = await observe(db, true);

  assert.equal(result.availability.previousAvailable, null);
  assert.equal(result.availability.latestAvailable, true);
  assert.equal(result.availability.restockCycle, 0);
  assert.equal(result.availability.lastCheckedAt, checkedAt);
  assert.equal(result.restockDetected, false);
  assert.equal(db.events.length, 0);
});

test("unavailable to unavailable is not a restock", async () => {
  const db = makeDatabase(existingAvailability(false));
  const result = await observe(db, false);

  assert.equal(result.availability.previousAvailable, false);
  assert.equal(result.availability.latestAvailable, false);
  assert.equal(result.availability.restockCycle, 0);
  assert.equal(result.restockDetected, false);
  assert.equal(db.events.length, 0);
});

test("unavailable to available detects a restock and increments its cycle", async () => {
  const db = makeDatabase(existingAvailability(false, 2));
  const result = await observe(db, true);

  assert.equal(result.availability.previousAvailable, false);
  assert.equal(result.availability.latestAvailable, true);
  assert.equal(result.availability.restockCycle, 3);
  assert.equal(result.restockDetected, true);
  assert.equal(db.events.length, 1);
  assert.deepEqual(db.events[0], {
    eventKey: `restock:${variantShopifyId}:3`,
    type: "RESTOCK_DETECTED",
    shopId,
    productShopifyId,
    variantShopifyId,
    sourceSurface: "AVAILABILITY_CHECK",
    restockCycle: 3,
    occurredAt: checkedAt,
  });

  const repeatedObservation = await observe(db, true);
  assert.equal(repeatedObservation.restockDetected, false);
  assert.equal(db.events.length, 1);
});

test("available to unavailable is not a restock", async () => {
  const db = makeDatabase(existingAvailability(true, 2));
  const result = await observe(db, false);

  assert.equal(result.availability.previousAvailable, true);
  assert.equal(result.availability.latestAvailable, false);
  assert.equal(result.availability.restockCycle, 2);
  assert.equal(result.restockDetected, false);
  assert.equal(db.events.length, 0);
});
