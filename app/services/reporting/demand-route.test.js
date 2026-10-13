import assert from "node:assert/strict";
import test from "node:test";
import {
  loadDemandAndRequests,
  loadOperationalContacts,
  retryDemandHandoff,
} from "./demand-route.js";

const shopGid = "gid://shopify/Shop/123";
const variantGid = "gid://shopify/ProductVariant/456";
const privateContact = "private-customer@example.com";

function adminFixture(domain = "merchant.myshopify.com") {
  const queries = [];
  return {
    queries,
    admin: {
      async graphql(query) {
        queries.push(query);
        return {
          ok: true,
          async json() {
            return { data: { shop: { id: shopGid, myshopifyDomain: domain } } };
          },
        };
      },
    },
  };
}

function dbFixture({ requestShopId = "internal-shop-1", jobStatus = "FAILED" } = {}) {
  const calls = [];
  const state = {
    job: {
      id: "job-123",
      notifyRequestId: "request-123",
      idempotencyKey: "restock-cycle:4",
      status: jobStatus,
      attempts: 3,
      retryAt: null,
      providerReference: null,
      sanitizedErrorCode: "retry_limit_reached",
      sanitizedErrorMessage: "Automatic retry limit reached.",
    },
    request: {
      id: "request-123",
      shopId: requestShopId,
      productShopifyId: "gid://shopify/Product/789",
      variantShopifyId: variantGid,
      status: "PENDING",
      normalizedContact: privateContact,
      channel: "EMAIL",
      contactDeduplicationKey: "private-digest",
      shop: { id: requestShopId, shopifyShopId: shopGid },
    },
  };
  const db = {
    calls,
    state,
    shop: {
      async upsert(args) {
        calls.push({ model: "shop.upsert", args });
        return { id: "internal-shop-1" };
      },
    },
    notifyRequest: {
      async groupBy(args) {
        calls.push({ model: "notifyRequest.groupBy", args });
        return [];
      },
      async findMany(args) {
        calls.push({ model: "notifyRequest.findMany", args });
        if (
          args.where.shopId !== requestShopId ||
          args.where.variantShopifyId !== variantGid ||
          args.where.status !== "PENDING"
        ) {
          return [];
        }
        return [
          {
            id: state.request.id,
            channel: state.request.channel,
            normalizedContact: state.request.normalizedContact,
            createdAt: new Date("2026-10-07T00:00:00Z"),
          },
        ];
      },
    },
    analyticsEvent: {
      async groupBy(args) {
        calls.push({ model: "analyticsEvent.groupBy", args });
        return [];
      },
      async findMany(args) {
        calls.push({ model: "analyticsEvent.findMany", args });
        return [];
      },
    },
    variantAvailability: {
      async findMany(args) {
        calls.push({ model: "variantAvailability.findMany", args });
        return [];
      },
    },
    handoffJob: {
      async findFirst(args) {
        calls.push({ model: "handoffJob.findFirst", args });
        if (
          args.where.id !== state.job.id ||
          args.where.notifyRequest.is.shopId !== state.request.shopId
        ) {
          return null;
        }
        return { id: state.job.id, status: state.job.status };
      },
      async findUnique(args) {
        calls.push({ model: "handoffJob.findUnique", args });
        if (args.where.id !== state.job.id) return null;
        return {
          ...state.job,
          notifyRequest: {
            ...state.request,
            shop: { ...state.request.shop },
          },
        };
      },
      async updateMany(args) {
        calls.push({ model: "handoffJob.updateMany", args });
        if (
          args.where.id !== state.job.id ||
          args.where.status !== state.job.status ||
          args.where.notifyRequest.is.shopId !== state.request.shopId ||
          args.where.notifyRequest.is.status !== state.request.status
        ) {
          return { count: 0 };
        }
        Object.assign(state.job, args.data);
        return { count: 1 };
      },
    },
  };
  return db;
}

function auth(admin, shop = "merchant.myshopify.com") {
  return async () => ({ admin, session: { shop } });
}

test("demand endpoint is merchant-authenticated and never returns contact details", async () => {
  const db = dbFixture();
  const { admin, queries } = adminFixture();
  const response = await loadDemandAndRequests(
    new Request("https://app.example/api/reporting/demand?shop=attacker.myshopify.com&customerId=123"),
    { authenticateAdmin: auth(admin), db, providerConfigured: true },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.rows.length, 0);
  assert.equal(JSON.stringify(body).includes(privateContact), false);
  assert.equal(JSON.stringify(body).includes("customerId"), false);
  assert.match(queries[0], /shop\s*\{/);
  assert.ok(db.calls.filter(({ args }) => args?.where?.shopId).every(({ args }) => args.where.shopId === "internal-shop-1"));
});

test("demand status filters reject invalid values before authentication", async () => {
  const response = await loadDemandAndRequests(
    new Request("https://app.example/api/reporting/demand?status=DELIVERED"),
    { authenticateAdmin: async () => assert.fail("invalid filter must be rejected first"), db: dbFixture() },
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_demand_filter");
});

test("operational contact endpoint authenticates, scopes the shop, and returns only current exact-variant contacts", async () => {
  const db = dbFixture();
  const { admin } = adminFixture();
  const response = await loadOperationalContacts(
    new Request(`https://app.example/api/reporting/demand/contacts?variantId=${encodeURIComponent(variantGid)}`),
    { authenticateAdmin: auth(admin), db },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.requests.length, 1);
  assert.equal(body.requests[0].contact, privateContact);
  assert.equal(JSON.stringify(body).includes("private-digest"), false);
  assert.equal(JSON.stringify(body).includes("shopify/Customer"), false);
  const query = db.calls.find(({ model }) => model === "notifyRequest.findMany");
  assert.deepEqual(query.args.where, {
    shopId: "internal-shop-1",
    variantShopifyId: variantGid,
    status: "PENDING",
  });
});

test("operational contacts cannot be read without merchant authentication", async () => {
  const response = await loadOperationalContacts(
    new Request(`https://app.example/api/reporting/demand/contacts?variantId=${encodeURIComponent(variantGid)}`),
    {
      authenticateAdmin: async () => ({ session: { shop: "merchant.myshopify.com" } }),
      db: dbFixture(),
    },
  );
  assert.equal(response.status, 401);
});

test("merchant retry resets the same eligible failed job and preserves its idempotency key", async () => {
  const db = dbFixture();
  const { admin } = adminFixture();
  const retryRequest = () =>
    new Request("https://app.example/api/reporting/demand", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "job-123" }),
    });
  const response = await retryDemandHandoff(retryRequest(), { authenticateAdmin: auth(admin), db });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "PENDING");
  assert.match(body.message, /queued/);
  assert.equal(db.state.job.status, "PENDING");
  assert.equal(db.state.job.idempotencyKey, "restock-cycle:4");
  assert.equal(db.state.job.attempts, 0);
  assert.equal(db.state.job.sanitizedErrorMessage, null);
  assert.equal(db.calls.filter(({ model }) => model === "handoffJob.updateMany").length, 1);

  const duplicate = await retryDemandHandoff(retryRequest(), { authenticateAdmin: auth(admin), db });
  assert.equal(duplicate.status, 409);
  assert.equal(db.calls.filter(({ model }) => model === "handoffJob.updateMany").length, 1);
});

test("retry is shop-scoped and rejects another shop, invalid IDs, and non-failed jobs", async () => {
  const { admin } = adminFixture();
  const body = JSON.stringify({ jobId: "job-123" });
  const otherShopDb = dbFixture({ requestShopId: "internal-shop-b" });
  const otherShop = await retryDemandHandoff(
    new Request("https://app.example/api/reporting/demand", { method: "POST", headers: { "Content-Type": "application/json" }, body }),
    { authenticateAdmin: auth(admin), db: otherShopDb },
  );
  assert.equal(otherShop.status, 404);
  assert.equal(otherShopDb.calls.some(({ model }) => model === "handoffJob.updateMany"), false);

  const successDb = dbFixture({ jobStatus: "SUCCEEDED" });
  const succeeded = await retryDemandHandoff(
    new Request("https://app.example/api/reporting/demand", { method: "POST", headers: { "Content-Type": "application/json" }, body }),
    { authenticateAdmin: auth(admin), db: successDb },
  );
  assert.equal(succeeded.status, 409);

  const invalid = await retryDemandHandoff(
    new Request("https://app.example/api/reporting/demand", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: "job-123", shopId: "internal-shop-1" }) }),
    { authenticateAdmin: auth(admin), db: dbFixture() },
  );
  assert.equal(invalid.status, 400);
});
