import assert from "node:assert/strict";
import test from "node:test";
import { loadMerchantReporting } from "./route.js";

const shopGid = "gid://shopify/Shop/123";

function dbFixture() {
  const calls = [];
  return {
    calls,
    shop: {
      async upsert(args) {
        calls.push({ model: "shop.upsert", args });
        return { id: "internal-shop-1" };
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
    notifyRequest: {
      async count(args) {
        calls.push({ model: "notifyRequest.count", args });
        return 0;
      },
    },
    wishlistEntry: {
      async count(args) {
        calls.push({ model: "wishlistEntry.count", args });
        return 0;
      },
    },
    orderMatch: {
      async findMany(args) {
        calls.push({ model: "orderMatch.findMany", args });
        return [];
      },
    },
  };
}

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

test("reporting uses authenticated Admin shop identity and scopes data to its internal shop", async () => {
  const db = dbFixture();
  const { admin, queries } = adminFixture();
  const response = await loadMerchantReporting(
    new Request(
      "https://app.example/api/reporting?shop=attacker.myshopify.com",
    ),
    {
      authenticateAdmin: async () => ({
        admin,
        session: { shop: "merchant.myshopify.com" },
      }),
      db,
      now: new Date("2026-10-07T12:00:00.000Z"),
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(queries.length, 1);
  assert.match(queries[0], /shop\s*\{/);
  assert.deepEqual(db.calls[0], {
    model: "shop.upsert",
    args: {
      where: { shopifyShopId: shopGid },
      create: { shopifyShopId: shopGid, domain: "merchant.myshopify.com" },
      update: { domain: "merchant.myshopify.com" },
      select: { id: true },
    },
  });
  assert.ok(
    db.calls
      .filter(({ model, args }) => model !== "shop.upsert" && args?.where)
      .every(
        ({ args }) =>
          args.where.shopId === "internal-shop-1" ||
          args.where.notifyRequest?.shopId === "internal-shop-1",
      ),
  );
});

test("reporting rejects a mismatch between authenticated session and Admin shop", async () => {
  const db = dbFixture();
  const { admin } = adminFixture("other.myshopify.com");
  const response = await loadMerchantReporting(
    new Request("https://app.example/api/reporting"),
    {
      authenticateAdmin: async () => ({
        admin,
        session: { shop: "merchant.myshopify.com" },
      }),
      db,
    },
  );

  assert.equal(response.status, 403);
  assert.equal(db.calls.length, 0);
});

test("reporting requires Shopify admin authentication and GET", async () => {
  const db = dbFixture();
  const unauthenticated = await loadMerchantReporting(
    new Request("https://app.example/api/reporting"),
    {
      authenticateAdmin: async () => ({
        session: { shop: "merchant.myshopify.com" },
      }),
      db,
    },
  );
  assert.equal(unauthenticated.status, 401);

  const methodNotAllowed = await loadMerchantReporting(
    new Request("https://app.example/api/reporting", { method: "POST" }),
    {
      authenticateAdmin: async () =>
        assert.fail("POST must be rejected before auth"),
      db,
    },
  );
  assert.equal(methodNotAllowed.status, 405);
  assert.equal(db.calls.length, 0);
});

test("reporting defaults to seven days and accepts 30-day and custom windows", async () => {
  for (const [query, expectedDays] of [["", 7], ["?days=30", 30], ["?days=14", 14]]) {
    const response = await loadMerchantReporting(
      new Request(`https://app.example/api/reporting${query}`),
      {
        authenticateAdmin: async () => ({
          ...adminFixture(),
          session: { shop: "merchant.myshopify.com" },
        }),
        db: dbFixture(),
        now: new Date("2026-10-08T12:00:00.000Z"),
      },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).window.days, expectedDays);
  }
});

test("reporting rejects malformed, duplicate, and excessive ranges before querying", async () => {
  for (const query of ["?days=0", "?days=-1", "?days=1.5", "?days=91", "?days=1&days=7"]) {
    const response = await loadMerchantReporting(
      new Request(`https://app.example/api/reporting${query}`),
      { authenticateAdmin: async () => assert.fail("Invalid ranges do not authenticate"), db: dbFixture() },
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_reporting_days");
  }
});
