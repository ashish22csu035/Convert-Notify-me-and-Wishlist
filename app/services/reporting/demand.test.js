import assert from "node:assert/strict";
import test from "node:test";
import { getDemandAndRequests, getOperationalContacts } from "./demand.js";

const shopId = "shop-a";
const productA = "gid://shopify/Product/100";
const productB = "gid://shopify/Product/200";
const variantA = "gid://shopify/ProductVariant/101";
const variantB = "gid://shopify/ProductVariant/102";
const variantC = "gid://shopify/ProductVariant/201";
const privateContact = "private-customer@example.com";

const requests = [
  { id: "request-1", shopId, productShopifyId: productA, variantShopifyId: variantA, status: "PENDING", contactDeduplicationKey: "digest-a", normalizedContact: privateContact, channel: "EMAIL", createdAt: new Date("2026-10-01T00:00:00Z"), handoffJobs: [{ id: "job-failed", status: "FAILED", sanitizedErrorCode: "provider_rejected", sanitizedErrorMessage: "Provider rejected this handoff." }] },
  { id: "request-duplicate", shopId, productShopifyId: productA, variantShopifyId: variantA, status: "PENDING", contactDeduplicationKey: "digest-a", normalizedContact: privateContact, channel: "EMAIL", createdAt: new Date("2026-10-02T00:00:00Z"), handoffJobs: [{ id: "job-failed-duplicate", status: "FAILED", sanitizedErrorCode: "provider_rejected", sanitizedErrorMessage: "Provider rejected this handoff." }] },
  { id: "request-2", shopId, productShopifyId: productA, variantShopifyId: variantA, status: "PENDING", contactDeduplicationKey: "digest-b", normalizedContact: "second@example.com", channel: "EMAIL", createdAt: new Date("2026-10-03T00:00:00Z"), handoffJobs: [{ id: "job-pending", status: "PENDING" }] },
  { id: "request-active", shopId, productShopifyId: productA, variantShopifyId: variantA, status: "ACTIVE", contactDeduplicationKey: "digest-c", normalizedContact: "active@example.com", channel: "EMAIL", createdAt: new Date("2026-10-04T00:00:00Z"), handoffJobs: [{ id: "job-accepted", status: "SUCCEEDED" }] },
  { id: "request-3", shopId, productShopifyId: productA, variantShopifyId: variantB, status: "PENDING", contactDeduplicationKey: "digest-a", normalizedContact: "third@example.com", channel: "EMAIL", createdAt: new Date("2026-10-05T00:00:00Z"), handoffJobs: [] },
  { id: "request-closed", shopId, productShopifyId: productB, variantShopifyId: variantC, status: "CLOSED", contactDeduplicationKey: "digest-a", normalizedContact: "closed@example.com", channel: "EMAIL", createdAt: new Date("2026-10-06T00:00:00Z"), handoffJobs: [] },
  { id: "other-shop-request", shopId: "shop-b", productShopifyId: productB, variantShopifyId: variantC, status: "PENDING", contactDeduplicationKey: "digest-z", normalizedContact: "other@example.com", channel: "EMAIL", createdAt: new Date("2026-10-07T00:00:00Z"), handoffJobs: [] },
];

const analyticsEvents = [
  { shopId, variantShopifyId: variantA, type: "NOTIFY_CLICKED", eventKey: "click-1" },
  { shopId, variantShopifyId: variantA, type: "NOTIFY_CLICKED", eventKey: "click-1" },
  { shopId, variantShopifyId: variantA, type: "NOTIFY_CLICKED", eventKey: "click-2" },
  { shopId, variantShopifyId: variantA, type: "NOTIFY_REQUEST_CREATED", eventKey: "signup-1", notifyRequestId: "request-1" },
  { shopId, variantShopifyId: variantA, type: "NOTIFY_REQUEST_CREATED", eventKey: "signup-replay", notifyRequestId: "request-1" },
  { shopId, variantShopifyId: variantA, type: "NOTIFY_REQUEST_CREATED", eventKey: "signup-2", notifyRequestId: "request-2" },
  { shopId, variantShopifyId: variantB, type: "NOTIFY_CLICKED", eventKey: "click-3" },
  { shopId, variantShopifyId: variantB, type: "NOTIFY_REQUEST_CREATED", eventKey: "signup-3", notifyRequestId: "request-3" },
];

function inSearch(row, where) {
  if (!where.OR) return true;
  return where.OR.some((part) =>
    Object.entries(part).some(([field, condition]) =>
      condition.in.includes(row[field]),
    ),
  );
}

function makeDb() {
  const calls = [];
  return {
    calls,
    notifyRequest: {
      async groupBy(args) {
        calls.push({ model: "notifyRequest.groupBy", args });
        const matching = requests.filter(
          (row) =>
            row.shopId === args.where.shopId &&
            (!args.where.status || row.status === args.where.status) &&
            inSearch(row, args.where),
        );
        if (args.by.includes("contactDeduplicationKey")) {
          const unique = new Map();
          for (const row of matching) {
            const key = `${row.productShopifyId}/${row.variantShopifyId}/${row.contactDeduplicationKey}`;
            unique.set(key, {
              productShopifyId: row.productShopifyId,
              variantShopifyId: row.variantShopifyId,
              contactDeduplicationKey: row.contactDeduplicationKey,
            });
          }
          return [...unique.values()];
        }
        const groups = new Map();
        for (const row of matching) {
          const key = `${row.productShopifyId}/${row.variantShopifyId}/${row.status}`;
          groups.set(key, {
            productShopifyId: row.productShopifyId,
            variantShopifyId: row.variantShopifyId,
            status: row.status,
            _count: { _all: (groups.get(key)?._count._all ?? 0) + 1 },
          });
        }
        return [...groups.values()];
      },
      async findMany(args) {
        calls.push({ model: "notifyRequest.findMany", args });
        if (typeof args.where.variantShopifyId === "string") {
          const matches = requests.filter(
            (row) =>
              row.shopId === args.where.shopId &&
              row.variantShopifyId === args.where.variantShopifyId &&
              row.status === args.where.status,
          );
          const byContact = new Map(matches.map((row) => [row.contactDeduplicationKey, row]));
          return [...byContact.values()].map((row) => ({
            id: row.id,
            channel: row.channel,
            normalizedContact: row.normalizedContact,
            createdAt: row.createdAt,
          }));
        }
        return requests
          .filter((row) => row.shopId === args.where.shopId)
          .filter((row) => row.variantShopifyId === args.where.variantShopifyId || args.where.variantShopifyId?.in?.includes(row.variantShopifyId))
          .filter((row) => row.status === "PENDING" || row.status === "ACTIVE")
          .map((row) => ({
            id: row.id,
            variantShopifyId: row.variantShopifyId,
            handoffJobs: row.handoffJobs,
          }));
      },
    },
    analyticsEvent: {
      async groupBy(args) {
        calls.push({ model: "analyticsEvent.groupBy", args });
        const unique = new Map();
        for (const event of analyticsEvents) {
          if (event.shopId !== args.where.shopId || event.type !== args.where.type || !args.where.variantShopifyId.in.includes(event.variantShopifyId)) continue;
          unique.set(event.eventKey, event);
        }
        const counts = new Map();
        for (const event of unique.values()) counts.set(event.variantShopifyId, (counts.get(event.variantShopifyId) ?? 0) + 1);
        return [...counts].map(([variantShopifyId, count]) => ({ variantShopifyId, _count: { _all: count } }));
      },
      async findMany(args) {
        calls.push({ model: "analyticsEvent.findMany", args });
        return analyticsEvents.filter(
          (event) =>
            event.shopId === args.where.shopId &&
            event.type === args.where.type &&
            args.where.variantShopifyId.in.includes(event.variantShopifyId),
        );
      },
    },
    variantAvailability: {
      async findMany(args) {
        calls.push({ model: "variantAvailability.findMany", args });
        return [
          { shopId, variantShopifyId: variantA, restockCycle: 4 },
          { shopId, variantShopifyId: variantB, restockCycle: 0 },
        ].filter((item) => item.shopId === args.where.shopId && args.where.variantShopifyId.in.includes(item.variantShopifyId));
      },
    },
  };
}

function catalogAdmin() {
  const calls = [];
  return {
    calls,
    async graphql(query, options = {}) {
      calls.push({ query, options });
      const nodes = [
        { id: productA, title: "Green Hat", handle: "green-hat" },
        { id: productB, title: "Blue Shirt", handle: "blue-shirt" },
        { id: variantA, title: "Small", sku: "GREEN-S", product: { id: productA, title: "Green Hat", handle: "green-hat" } },
        { id: variantB, title: "Large", sku: "GREEN-L", product: { id: productA, title: "Green Hat", handle: "green-hat" } },
        { id: variantC, title: "Default Title", sku: "BLUE-ONE", product: { id: productB, title: "Blue Shirt", handle: "blue-shirt" } },
      ];
      return {
        ok: true,
        async json() {
          if (query.includes("SearchDemandCatalog")) {
            const phrase = options.variables.productsQuery.toLowerCase();
            const matchingProducts = nodes.filter((node) => node.id.startsWith("gid://shopify/Product/") && `${node.title} ${node.handle}`.toLowerCase().includes(phrase.match(/"([^"]+)"/)?.[1] ?? ""));
            const skuTerm = options.variables.variantsQuery.match(/"([^"]+)"/)?.[1]?.toLowerCase();
            const matchingVariants = nodes.filter((node) => node.sku?.toLowerCase().includes(skuTerm ?? ""));
            return { data: { products: { nodes: matchingProducts }, productVariants: { nodes: matchingVariants } } };
          }
          return { data: { nodes: nodes.filter((node) => options.variables.ids.includes(node.id)) } };
        },
      };
    },
  };
}

test("ranks exact variants by unique pending contacts and loads catalog names in one batch", async () => {
  const db = makeDb();
  const admin = catalogAdmin();
  const report = await getDemandAndRequests({ db, admin, shopId, providerConfigured: true });
  assert.equal(report.rows[0].variantShopifyId, variantA);
  assert.equal(report.rows[0].uniqueWaitingContacts, 2);
  assert.equal(report.rows[0].requestCount, 4);
  assert.equal(report.rows[0].product, "Green Hat");
  assert.equal(report.rows[0].variant, "Small");
  assert.equal(report.rows[0].sku, "GREEN-S");
  assert.equal(report.rows[0].notifyClicks, 2);
  assert.equal(report.rows[0].newSignups, 2);
  assert.equal(report.rows[0].restockCycle, 4);
  assert.match(report.rows[0].handoffStatus, /FAILED: 2/);
  assert.equal(report.rows[0].failedJobs[0].errorMessage, "Provider rejected this handoff.");
  assert.equal(JSON.stringify(report).includes(privateContact), false);
  assert.equal(admin.calls.length, 1);
  assert.equal(report.rows.find((row) => row.variantShopifyId === variantB).uniqueWaitingContacts, 1);
});

test("request status filter keeps waiting counts unique and rejects invalid values", async () => {
  const db = makeDb();
  const report = await getDemandAndRequests({ db, admin: catalogAdmin(), shopId, status: "CLOSED" });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].variantShopifyId, variantC);
  assert.equal(report.rows[0].uniqueWaitingContacts, 0);
  await assert.rejects(
    getDemandAndRequests({ db, admin: catalogAdmin(), shopId, status: "SENT" }),
    /input is invalid/,
  );
});

test("product title and SKU search scopes demand and returns an explicit empty result", async () => {
  const db = makeDb();
  const admin = catalogAdmin();
  const report = await getDemandAndRequests({ db, admin, shopId, search: "green" });
  assert.deepEqual(report.rows.map((row) => row.variantShopifyId), [variantA, variantB]);
  assert.match(admin.calls[0].options.variables.productsQuery, /title:/);
  const skuResult = await getDemandAndRequests({ db, admin: catalogAdmin(), shopId, search: "BLUE-ONE" });
  assert.deepEqual(skuResult.rows.map((row) => row.variantShopifyId), [variantC]);
  const empty = await getDemandAndRequests({ db, admin: catalogAdmin(), shopId, search: "missing" });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.total, 0);
});

test("unconfigured provider state is shown as unavailable when no handoff fact exists", async () => {
  const db = makeDb();
  const report = await getDemandAndRequests({ db, admin: catalogAdmin(), shopId, providerConfigured: false });
  assert.equal(report.provider.status, "UNAVAILABLE");
  assert.match(report.rows.find((row) => row.variantShopifyId === variantB).handoffStatus, /Unavailable/);
});

test("pagination is server-side and requests the next ranked page", async () => {
  const manyRequests = Array.from({ length: 27 }, (_, index) => ({
    id: `page-${index}`,
    shopId,
    productShopifyId: productA,
    variantShopifyId: `gid://shopify/ProductVariant/${1000 + index}`,
    status: "PENDING",
    contactDeduplicationKey: `contact-${index}`,
    normalizedContact: "hidden@example.com",
    channel: "EMAIL",
    handoffJobs: [],
  }));
  const db = makeDb();
  const originalGroupBy = db.notifyRequest.groupBy;
  db.notifyRequest.groupBy = async (args) => {
    const base = await originalGroupBy(args);
    if (args.by.includes("contactDeduplicationKey")) return [...base, ...manyRequests.map((row) => ({ productShopifyId: row.productShopifyId, variantShopifyId: row.variantShopifyId, contactDeduplicationKey: row.contactDeduplicationKey }))];
    if (args.where.status === "PENDING") return [...base, ...manyRequests.map((row) => ({ productShopifyId: row.productShopifyId, variantShopifyId: row.variantShopifyId, status: row.status, _count: { _all: 1 } }))];
    return base;
  };
  const report = await getDemandAndRequests({ db, admin: catalogAdmin(), shopId, page: 2, providerConfigured: true });
  assert.equal(report.page, 2);
  assert.equal(report.pageSize, 25);
  assert.equal(report.total, 30);
  assert.equal(report.rows.length, 5);
});

test("operational contacts are limited to current waiting requests for the exact shop and variant", async () => {
  const db = makeDb();
  const contacts = await getOperationalContacts({ db, shopId, variantShopifyId: variantA });
  assert.equal(contacts.length, 2);
  assert.ok(contacts.every((item) => item.contact && !("shopId" in item) && !("customerId" in item)));
  const query = db.calls[0];
  assert.deepEqual(query.args.where, { shopId, variantShopifyId: variantA, status: "PENDING" });
  assert.deepEqual(query.args.distinct, ["contactDeduplicationKey"]);
  assert.equal(query.args.select.consentText, undefined);
});
