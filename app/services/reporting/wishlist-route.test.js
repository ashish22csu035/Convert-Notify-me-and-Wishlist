import assert from "node:assert/strict";
import test from "node:test";
import { loadWishlistAnalytics } from "./wishlist-route.js";

const shopGid = "gid://shopify/Shop/123";

function dbFixture() {
  const calls = [];
  return {
    calls,
    shop: {
      async upsert(args) {
        calls.push({ model: "shop.upsert", args });
        return { id: "internal-shop-a" };
      },
    },
    analyticsEvent: {
      async findMany(args) {
        calls.push({ model: "analyticsEvent.findMany", args });
        return [];
      },
    },
    wishlistEntry: {
      async findMany(args) {
        calls.push({ model: "wishlistEntry.findMany", args });
        return [];
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

test("Wishlist Analytics authenticates the merchant, verifies Admin shop identity, and scopes every query", async () => {
  const db = dbFixture();
  const { admin, queries } = adminFixture();
  const response = await loadWishlistAnalytics(
    new Request("https://app.example/api/reporting/wishlist?days=30&shop=attacker.myshopify.com&customerId=gid%3A%2F%2Fshopify%2FCustomer%2F999"),
    {
      authenticateAdmin: async () => ({ admin, session: { shop: "merchant.myshopify.com" } }),
      db,
      now: new Date("2026-10-08T12:00:00.000Z"),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(queries.length, 1);
  const payload = await response.json();
  assert.equal(JSON.stringify(payload).includes("Customer/999"), false);
  assert.ok(db.calls.filter(({ model }) => model !== "shop.upsert").every(({ args }) => args.where.shopId === "internal-shop-a"));
});

test("Shop A cannot see Shop B data and a mismatched authenticated Admin shop fails closed", async () => {
  const db = dbFixture();
  const { admin } = adminFixture("other.myshopify.com");
  const response = await loadWishlistAnalytics(
    new Request("https://app.example/api/reporting/wishlist"),
    {
      authenticateAdmin: async () => ({ admin, session: { shop: "merchant.myshopify.com" } }),
      db,
    },
  );
  assert.equal(response.status, 403);
  assert.equal(db.calls.length, 0);
});

test("Wishlist Analytics rejects invalid windows and non-GET requests before querying", async () => {
  const db = dbFixture();
  for (const query of ["?days=0", "?days=91", "?days=nope", "?days=7&days=30"]) {
    const response = await loadWishlistAnalytics(
      new Request(`https://app.example/api/reporting/wishlist${query}`),
      { authenticateAdmin: async () => assert.fail("Invalid windows must fail before authentication"), db },
    );
    assert.equal(response.status, 400);
  }
  const method = await loadWishlistAnalytics(
    new Request("https://app.example/api/reporting/wishlist", { method: "POST" }),
    { authenticateAdmin: async () => assert.fail("Non-GET must fail before authentication"), db },
  );
  assert.equal(method.status, 405);
  assert.equal(db.calls.length, 0);
});

test("Wishlist Analytics requires authenticated Admin context", async () => {
  const response = await loadWishlistAnalytics(
    new Request("https://app.example/api/reporting/wishlist"),
    { authenticateAdmin: async () => ({ session: { shop: "merchant.myshopify.com" } }), db: dbFixture() },
  );
  assert.equal(response.status, 401);
});
