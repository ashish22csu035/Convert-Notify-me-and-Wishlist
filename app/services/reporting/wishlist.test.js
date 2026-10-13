import assert from "node:assert/strict";
import test from "node:test";
import { getWishlistAnalytics } from "./wishlist.js";

const shopA = "shop-a";
const product = (id) => `gid://shopify/Product/${id}`;
const customer = (id) => `gid://shopify/Customer/${id}`;
const end = new Date("2026-10-08T12:00:00.000Z");

function event({
  id,
  type = "WISHLIST_ENTRY_CREATED",
  entryId,
  productId = product(1),
  shopId = shopA,
  occurredAt,
  createdAt = occurredAt,
}) {
  return { id, type, wishlistEntryId: entryId, productShopifyId: productId, shopId, occurredAt, createdAt };
}

function fixture({ events = [], active = [], matches = [], products = [] } = {}) {
  const calls = [];
  const db = {
    calls,
    analyticsEvent: {
      async findMany(args) {
        calls.push({ model: "analyticsEvent.findMany", args });
        const where = args.where;
        if (where.type === "WISHLIST_ENTRY_CREATED") {
          return events.filter((row) =>
            row.shopId === where.shopId &&
            row.type === where.type &&
            row.occurredAt >= where.occurredAt.gte &&
            row.occurredAt < where.occurredAt.lt &&
            Boolean(row.productShopifyId) &&
            Boolean(row.wishlistEntryId),
          );
        }
        return events.filter((row) =>
          row.shopId === where.shopId &&
          where.wishlistEntryId.in.includes(row.wishlistEntryId) &&
          where.type.in.includes(row.type) &&
          row.occurredAt >= where.occurredAt.gte &&
          row.occurredAt < where.occurredAt.lt,
        ).sort((left, right) => left.occurredAt - right.occurredAt || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      },
    },
    wishlistEntry: {
      async findMany(args) {
        calls.push({ model: "wishlistEntry.findMany", args });
        return active.filter((row) =>
          row.shopId === args.where.shopId &&
          row.isActive === args.where.isActive &&
          row.savedAt >= args.where.savedAt.gte &&
          row.savedAt < args.where.savedAt.lt &&
          args.where.productShopifyId.in.includes(row.productShopifyId),
        );
      },
    },
    orderMatch: {
      async findMany(args) {
        calls.push({ model: "orderMatch.findMany", args });
        return matches.filter((row) =>
          row.shopId === args.where.shopId &&
          row.source === args.where.source &&
          args.where.wishlistEntryId.in.includes(row.wishlistEntryId) &&
          row.paidAt >= args.where.paidAt.gte &&
          row.paidAt < args.where.paidAt.lt &&
          row.wishlistEntry?.shopId === shopA,
        );
      },
    },
  };
  const catalog = new Map(products.map((item) => [item.id, item]));
  const admin = {
    async graphql(query, { variables }) {
      return {
        ok: true,
        async json() {
          return { data: { nodes: variables.ids.map((id) => catalog.get(id) ?? null) } };
        },
      };
    },
  };
  return { db, admin, calls };
}

function activeRow(productId, customerId, savedAt = new Date("2026-10-06T12:00:00.000Z"), shopId = shopA) {
  return { shopId, productShopifyId: productId, verifiedCustomerShopifyId: customerId, isActive: true, savedAt };
}

function match({ entryId, productId, customerId, paidAt, shopId = shopA, entryShopId = shopA }) {
  return {
    shopId,
    source: "WISHLIST_ENTRY",
    wishlistEntryId: entryId,
    paidAt,
    wishlistEntry: {
      shopId: entryShopId,
      productShopifyId: productId,
      verifiedCustomerShopifyId: customerId,
    },
  };
}

test("save episodes count once per server event; duplicate active save is absent and re-add is a new episode", async () => {
  const productId = product(1);
  const firstSave = new Date("2026-10-05T12:00:00.000Z");
  const reSave = new Date("2026-10-06T12:00:00.000Z");
  const { db, admin } = fixture({
    events: [
      event({ id: "save-1", entryId: "entry-1", productId, occurredAt: firstSave }),
      event({ id: "save-1", entryId: "entry-1", productId, occurredAt: firstSave }),
      event({ id: "remove-1", type: "WISHLIST_ENTRY_REMOVED", entryId: "entry-1", productId, occurredAt: new Date("2026-10-05T18:00:00.000Z") }),
      event({ id: "save-2", entryId: "entry-1", productId, occurredAt: reSave }),
    ],
    active: [activeRow(productId, customer(1), reSave)],
    products: [{ id: productId, title: "Greenhouse", handle: "greenhouse" }],
  });
  const report = await getWishlistAnalytics({ db, admin, shopId: shopA, now: end });
  assert.equal(report.summary.savedItems, 2);
  assert.equal(report.summary.savedProducts, 1);
  assert.equal(report.products[0].saves, 2);
  assert.equal(report.products[0].activeSavers, 1);
});

test("active savers are unique verified customers per product and removed customers are absent", async () => {
  const productId = product(1);
  const { db, admin } = fixture({
    events: [event({ id: "save-1", entryId: "entry-1", productId, occurredAt: new Date("2026-10-06T12:00:00.000Z") })],
    active: [
      activeRow(productId, customer(1)),
      activeRow(productId, customer(1)),
      activeRow(productId, customer(2)),
    ],
  });
  const report = await getWishlistAnalytics({ db, admin, shopId: shopA, now: end });
  assert.equal(report.summary.activeSavers, 2);
  assert.equal(report.products[0].activeSavers, 2);
  assert.equal(JSON.stringify(report).includes(customer(1)), false);
});

test("ranks products by save episodes and uses matched Wishlist buyers, deduplicated across orders", async () => {
  const p1 = product(1);
  const p2 = product(2);
  const cohortSave = new Date("2026-10-05T12:00:00.000Z");
  const purchase = new Date("2026-10-10T12:00:00.000Z");
  const { db, admin, calls } = fixture({
    events: [
      event({ id: "a-save-1", entryId: "a1", productId: p1, occurredAt: cohortSave }),
      event({ id: "a-save-2", entryId: "a2", productId: p1, occurredAt: new Date("2026-10-06T12:00:00.000Z") }),
      event({ id: "b-save-1", entryId: "b1", productId: p2, occurredAt: new Date("2026-10-07T12:00:00.000Z") }),
      event({ id: "a-remove", type: "WISHLIST_ENTRY_REMOVED", entryId: "a1", productId: p1, occurredAt: new Date("2026-10-07T12:00:00.000Z") }),
    ],
    matches: [
      match({ entryId: "a1", productId: p1, customerId: customer(1), paidAt: purchase }),
      match({ entryId: "a1", productId: p1, customerId: customer(1), paidAt: new Date("2026-10-11T12:00:00.000Z") }),
      match({ entryId: "b1", productId: p2, customerId: customer(2), paidAt: new Date("2026-10-08T13:00:00.000Z") }),
    ],
    products: [
      { id: p1, title: "Product One", handle: "product-one" },
      { id: p2, title: "Product Two", handle: "product-two" },
    ],
  });
  const report = await getWishlistAnalytics({ db, admin, shopId: shopA, now: end, days: 7 });
  assert.deepEqual(report.products.map((row) => [row.productId, row.saves]), [[p1, 2], [p2, 1]]);
  assert.equal(report.products[0].matchedBuyers, 0, "a removed episode cannot convert");
  assert.equal(report.products[1].matchedBuyers, 1);
  const matchQuery = calls.find(({ model }) => model === "orderMatch.findMany").args;
  assert.equal(matchQuery.where.shopId, shopA);
  assert.equal("variantShopifyId" in matchQuery.where, false);
});

test("10 distinct saved products and two distinct products later bought produce 20% conversion", async () => {
  const products = Array.from({ length: 10 }, (_, index) => product(index + 1));
  const createdAt = new Date("2026-10-06T12:00:00.000Z");
  const events = products.map((productId, index) => event({
    id: `save-${index}`,
    entryId: `entry-${index}`,
    productId,
    occurredAt: createdAt,
  }));
  const paidAt = new Date("2026-10-07T12:00:00.000Z");
  const matches = [
    match({ entryId: "entry-0", productId: products[0], customerId: customer(1), paidAt }),
    match({ entryId: "entry-0", productId: products[0], customerId: customer(1), paidAt: new Date("2026-10-08T12:00:00.000Z") }),
    match({ entryId: "entry-1", productId: products[1], customerId: customer(2), paidAt }),
    match({ entryId: "entry-1", productId: products[1], customerId: customer(2), paidAt, shopId: "shop-b", entryShopId: "shop-b" }),
  ];
  const { db, admin } = fixture({ events, matches });
  const report = await getWishlistAnalytics({ db, admin, shopId: shopA, now: end });
  assert.equal(report.summary.savedProducts, 10);
  assert.equal(report.summary.matchedProducts, 2);
  assert.equal(report.summary.itemConversionRate, 0.2);
  assert.equal(report.products.find((row) => row.productId === products[0]).matchedBuyers, 1);
  assert.equal(Number.isFinite(report.summary.itemConversionRate), true);
  assert.equal(JSON.stringify(report).includes(customer(1)), false);
});

test("a purchase must follow an active cohort episode and land inside its existing seven-day window", async () => {
  const productId = product(1);
  const saveAt = new Date("2026-10-07T12:00:00.000Z");
  const { db, admin } = fixture({
    events: [
      event({ id: "save", entryId: "entry", productId, occurredAt: saveAt }),
      event({ id: "remove", type: "WISHLIST_ENTRY_REMOVED", entryId: "entry", productId, occurredAt: new Date("2026-10-07T18:00:00.000Z") }),
    ],
    matches: [
      match({ entryId: "entry", productId, customerId: customer(1), paidAt: new Date("2026-10-07T11:00:00.000Z") }),
      match({ entryId: "entry", productId, customerId: customer(1), paidAt: new Date("2026-10-08T12:00:00.000Z") }),
      match({ entryId: "entry", productId, customerId: customer(1), paidAt: new Date("2026-10-14T12:00:00.000Z") }),
    ],
  });
  const report = await getWishlistAnalytics({ db, admin, shopId: shopA, now: end });
  assert.equal(report.products[0].matchedBuyers, 0);
});

test("reports only current active cohort savers and safely handles missing Shopify products and zero denominator", async () => {
  const productId = product(1);
  const { db, admin } = fixture({
    events: [event({ id: "save", entryId: "entry", productId, occurredAt: new Date("2026-10-06T12:00:00.000Z") })],
    active: [
      activeRow(productId, customer(1)),
      activeRow(product(99), customer(2)),
      activeRow(productId, customer(3), new Date("2026-09-01T12:00:00.000Z")),
    ],
  });
  const report = await getWishlistAnalytics({ db, admin, shopId: shopA, now: end });
  assert.equal(report.summary.activeSavers, 1);
  assert.equal(report.summary.itemConversionRate, 0);
  assert.equal(report.products[0].title, "Unavailable product (1)");

  const empty = fixture();
  const emptyReport = await getWishlistAnalytics({ db: empty.db, admin: empty.admin, shopId: shopA, now: end });
  assert.equal(emptyReport.summary.savedProducts, 0);
  assert.equal(emptyReport.summary.savedItems, 0);
  assert.equal(emptyReport.summary.itemConversionRate, null);
});

test("custom and 30-day cohorts use the shared reporting window; every query is shop scoped", async () => {
  const productId = product(1);
  const oldSave = new Date("2026-09-20T12:00:00.000Z");
  const recentSave = new Date("2026-10-06T12:00:00.000Z");
  const { db, admin, calls } = fixture({
    events: [
      event({ id: "old", entryId: "old", productId, occurredAt: oldSave }),
      event({ id: "recent", entryId: "recent", productId, occurredAt: recentSave }),
      event({ id: "other-shop", entryId: "other", productId, shopId: "shop-b", occurredAt: recentSave }),
    ],
    active: [activeRow(productId, customer(1), recentSave)],
  });
  const report = await getWishlistAnalytics({ db, admin, shopId: shopA, now: end, days: 30 });
  assert.equal(report.window.days, 30);
  assert.equal(report.window.start, new Date(end.getTime() - 30 * 86400000).toISOString());
  assert.equal(report.summary.savedItems, 2);
  assert.deepEqual(report.products.map((row) => row.productId), [productId]);
  assert.ok(calls.every(({ args }) => args.where.shopId === shopA));

  const custom = await getWishlistAnalytics({ db, admin, shopId: shopA, now: end, days: 14 });
  assert.equal(custom.summary.savedItems, 1);
  assert.equal(custom.window.days, 14);
});
