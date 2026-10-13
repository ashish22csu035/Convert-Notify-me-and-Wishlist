import assert from "node:assert/strict";
import test from "node:test";
import { getMerchantReporting } from "./index.js";

const shopA = "shop-a";
const windowEnd = new Date("2026-10-07T12:00:00.000Z");
const windowStart = new Date(windowEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

function event(type, offsetMs = 0, fields = {}) {
  return {
    id: `event-${type}-${offsetMs}`,
    type,
    occurredAt: new Date(windowStart.getTime() + offsetMs),
    shopId: shopA,
    ...(type === "NOTIFY_REQUEST_CREATED"
      ? {
          notifyRequestId: `request-${offsetMs}`,
          notifyRequest: {
            verifiedCustomerShopifyId: null,
            contactDeduplicationKey: `contact-${offsetMs}`,
            channel: "EMAIL",
          },
        }
      : {}),
    ...(type === "WISHLIST_ENTRY_CREATED"
      ? {
          wishlistEntryId: `entry-${offsetMs}`,
          productShopifyId: `product-${offsetMs}`,
          verifiedCustomerShopifyId: `gid://shopify/Customer/${offsetMs + 1}`,
        }
      : {}),
    ...fields,
  };
}

function makeDb({
  events = [],
  waitingRequests = 0,
  activeItems = 0,
  notifyMatches = [],
  wishlistMatches = [],
  attemptedJobs = 0,
  calls = [],
} = {}) {
  const inWindow = (row, where) =>
    row.shopId === where.shopId &&
    row.occurredAt >= where.occurredAt.gte &&
    row.occurredAt < where.occurredAt.lt;
  return {
    calls,
    analyticsEvent: {
      async groupBy(args) {
        calls.push({ model: "analyticsEvent.groupBy", args });
        const grouped = new Map();
        for (const row of events) {
          if (
            inWindow(row, args.where) &&
            args.where.type.in.includes(row.type)
          ) {
            grouped.set(row.type, (grouped.get(row.type) ?? 0) + 1);
          }
        }
        return [...grouped].map(([type, count]) => ({
          type,
          _count: { _all: count },
        }));
      },
      async findMany(args) {
        calls.push({ model: "analyticsEvent.findMany", args });
        return events.filter(
          (row) => inWindow(row, args.where) && row.type === args.where.type,
        );
      },
    },
    notifyRequest: {
      async count(args) {
        calls.push({ model: "notifyRequest.count", args });
        return waitingRequests;
      },
    },
    wishlistEntry: {
      async count(args) {
        calls.push({ model: "wishlistEntry.count", args });
        return activeItems;
      },
    },
    orderMatch: {
      async findMany(args) {
        calls.push({ model: "orderMatch.findMany", args });
        return args.where.source === "NOTIFY_REQUEST"
          ? notifyMatches
          : wishlistMatches;
      },
    },
    handoffJob: {
      async count(args) {
        calls.push({ model: "handoffJob.count", args });
        return attemptedJobs;
      },
    },
  };
}

function notifyMatch({
  requestId,
  customerId = "gid://shopify/Customer/1",
  email = "email-digest-1",
  phone = null,
} = {}) {
  return {
    notifyRequestId: requestId,
    notifyRequest: {
      verifiedCustomerShopifyId: customerId,
      contactDeduplicationKey: email,
      channel: "EMAIL",
    },
    paidOrderLine: {
      paidOrderEvent: {
        verifiedCustomerShopifyId: customerId,
        customerEmailDeduplicationKey: email,
        customerPhoneDeduplicationKey: phone,
      },
    },
  };
}

function wishlistMatch({
  entryId,
  productId,
  customerId = "gid://shopify/Customer/1",
} = {}) {
  return {
    wishlistEntryId: entryId,
    wishlistEntry: {
      id: entryId,
      productShopifyId: productId,
      verifiedCustomerShopifyId: customerId,
    },
    paidOrderLine: {
      paidOrderEvent: {
        verifiedCustomerShopifyId: customerId,
        customerEmailDeduplicationKey: null,
        customerPhoneDeduplicationKey: null,
      },
    },
  };
}

test("counts intentional Notify and Wishlist clicks and persisted request/save/removal facts", async () => {
  const db = makeDb({
    events: [
      event("NOTIFY_CLICKED"),
      event("NOTIFY_CLICKED", 1),
      event("NOTIFY_REQUEST_CREATED"),
      event("WISHLIST_CLICKED"),
      event("WISHLIST_ENTRY_CREATED"),
      event("WISHLIST_ENTRY_REMOVED"),
    ],
    waitingRequests: 2,
    activeItems: 3,
  });
  const report = await getMerchantReporting({
    db,
    shopId: shopA,
    now: windowEnd,
  });

  assert.equal(report.notify.clicks, 2);
  assert.equal(report.notify.newRequests, 1);
  assert.equal(report.notify.waitingRequests, 2);
  assert.equal(report.wishlist.clicks, 1);
  assert.equal(report.wishlist.added, 1);
  assert.equal(report.wishlist.removed, 1);
  assert.equal(report.wishlist.activeItems, 3);
});

test("signup and Wishlist add totals deduplicate repeated facts and active items use the selected cohort", async () => {
  const db = makeDb({
    events: [
      event("NOTIFY_REQUEST_CREATED", 1, {
        notifyRequestId: "same-request",
        notifyRequest: { verifiedCustomerShopifyId: null, contactDeduplicationKey: "same-contact", channel: "EMAIL" },
      }),
      event("NOTIFY_REQUEST_CREATED", 2, {
        notifyRequestId: "duplicate-request",
        notifyRequest: { verifiedCustomerShopifyId: null, contactDeduplicationKey: "same-contact", channel: "EMAIL" },
      }),
      event("WISHLIST_ENTRY_CREATED", 3, { wishlistEntryId: "same-entry", productShopifyId: "same-product" }),
      event("WISHLIST_ENTRY_CREATED", 4, { wishlistEntryId: "same-entry", productShopifyId: "same-product" }),
    ],
    activeItems: 1,
  });
  const report = await getMerchantReporting({ db, shopId: shopA, now: windowEnd });
  assert.equal(report.notify.newRequests, 1);
  assert.equal(report.wishlist.added, 1);
  assert.equal(report.wishlist.activeItems, 1);
  const activeItemsQuery = db.calls.find(({ model }) => model === "wishlistEntry.count");
  assert.deepEqual(activeItemsQuery.args.where, {
    shopId: shopA,
    isActive: true,
    savedAt: { gte: windowStart, lt: windowEnd },
  });
});

test("counts restock, accepted handoff, failed handoff, and attempts from confirmed facts", async () => {
  const db = makeDb({
    events: [
      event("RESTOCK_DETECTED"),
      event("HANDOFF_ACCEPTED"),
      event("HANDOFF_FAILED"),
    ],
    attemptedJobs: 2,
  });
  const report = await getMerchantReporting({
    db,
    shopId: shopA,
    now: windowEnd,
    providerConfigured: true,
  });

  assert.equal(report.notify.restockDetected, 1);
  assert.equal(report.notify.handoffAttempts, 2);
  assert.equal(report.notify.handoffAccepted, 1);
  assert.equal(report.notify.handoffFailed, 1);
  assert.equal(report.notify.handoffAcceptanceRate, 0.5);
});

test("unconfigured provider metrics are unavailable rather than zero", async () => {
  const db = makeDb({
    events: [event("HANDOFF_ACCEPTED"), event("HANDOFF_FAILED")],
  });
  const report = await getMerchantReporting({
    db,
    shopId: shopA,
    now: windowEnd,
  });

  assert.deepEqual(report.provider, {
    configured: false,
    status: "UNAVAILABLE",
  });
  assert.equal(report.notify.handoffAttempts, null);
  assert.equal(report.notify.handoffAccepted, null);
  assert.equal(report.notify.handoffFailed, null);
  assert.equal(report.notify.handoffAcceptanceRate, null);
  assert.equal(
    db.calls.some(({ model }) => model === "handoffJob.count"),
    false,
  );
});

test("counts a duplicate accepted request and matched buyer once", async () => {
  const request = {
    verifiedCustomerShopifyId: "gid://shopify/Customer/7",
    contactDeduplicationKey: "shared-email",
    channel: "EMAIL",
  };
  const db = makeDb({
    events: [
      event("NOTIFY_REQUEST_CREATED"),
      event("HANDOFF_ACCEPTED", 1, {
        notifyRequestId: "request-1",
        notifyRequest: request,
      }),
      event("HANDOFF_ACCEPTED", 2, {
        notifyRequestId: "request-1",
        notifyRequest: request,
      }),
    ],
    notifyMatches: [
      notifyMatch({
        requestId: "request-1",
        customerId: "gid://shopify/Customer/7",
        email: "shared-email",
      }),
      notifyMatch({
        requestId: "request-1",
        customerId: "gid://shopify/Customer/7",
        email: "shared-email",
      }),
    ],
  });
  const report = await getMerchantReporting({
    db,
    shopId: shopA,
    now: windowEnd,
    providerConfigured: true,
  });

  assert.equal(report.notify.matchedBuyers, 1);
  assert.equal(report.notify.eligibleContacts, 1);
  assert.equal(report.notify.buyerRate, 1);
});

test("Notify buyer rate uses the subscribed contact when the paid order adds a customer ID", async () => {
  const request = {
    verifiedCustomerShopifyId: null,
    contactDeduplicationKey: "subscriber-email",
    channel: "EMAIL",
  };
  const db = makeDb({
    events: [
      event("HANDOFF_ACCEPTED", 1, {
        notifyRequestId: "request-no-id",
        notifyRequest: request,
      }),
    ],
    notifyMatches: [
      notifyMatch({
        requestId: "request-no-id",
        customerId: "gid://shopify/Customer/99",
        email: "subscriber-email",
      }),
    ],
  });
  const report = await getMerchantReporting({
    db,
    shopId: shopA,
    now: windowEnd,
  });

  assert.equal(report.notify.eligibleContacts, 1);
  assert.equal(report.notify.buyerRate, 1);
});

test("computes signup, buyer, handoff, and item conversion rates", async () => {
  const products = Array.from({ length: 10 }, (_, index) => `product-${index}`);
  const saves = products.map((productId, index) =>
    event("WISHLIST_ENTRY_CREATED", index, {
      wishlistEntryId: `entry-${index}`,
      productShopifyId: productId,
      verifiedCustomerShopifyId: `gid://shopify/Customer/${index + 1}`,
    }),
  );
  const db = makeDb({
    events: [
      event("NOTIFY_CLICKED"),
      event("NOTIFY_CLICKED", 1),
      event("NOTIFY_REQUEST_CREATED"),
      ...saves,
      ...products
        .slice(0, 2)
        .map((productId, index) =>
          event("WISHLIST_CLICKED", index + 2, { productShopifyId: productId }),
        ),
      ...[1, 2].map((index) =>
        event("HANDOFF_ACCEPTED", index + 20, {
          notifyRequestId: `request-${index}`,
          notifyRequest: {
            verifiedCustomerShopifyId: `gid://shopify/Customer/${index}`,
            contactDeduplicationKey: `contact-${index}`,
            channel: "EMAIL",
          },
        }),
      ),
    ],
    attemptedJobs: 4,
    notifyMatches: [
      notifyMatch({
        requestId: "request-1",
        customerId: "gid://shopify/Customer/1",
        email: "contact-1",
      }),
    ],
    wishlistMatches: [
      wishlistMatch({
        entryId: "entry-0",
        productId: "product-0",
        customerId: "gid://shopify/Customer/1",
      }),
      wishlistMatch({
        entryId: "entry-1",
        productId: "product-1",
        customerId: "gid://shopify/Customer/2",
      }),
      wishlistMatch({
        entryId: "entry-0",
        productId: "product-0",
        customerId: "gid://shopify/Customer/1",
      }),
    ],
  });
  const report = await getMerchantReporting({
    db,
    shopId: shopA,
    now: windowEnd,
    providerConfigured: true,
  });

  assert.equal(report.notify.signupRate, 0.5);
  assert.equal(report.notify.handoffAcceptanceRate, 0.5);
  assert.equal(report.notify.buyerRate, 0.5);
  assert.equal(report.wishlist.itemConversionRate, 0.2);
  assert.equal(report.wishlist.buyerRate, 0.2);
  assert.equal(report.wishlist.matchedBuyers, 2);
});

test("zero denominators return null rather than non-finite rates", async () => {
  const db = makeDb();
  const report = await getMerchantReporting({
    db,
    shopId: shopA,
    now: windowEnd,
    providerConfigured: true,
  });

  assert.equal(report.notify.signupRate, null);
  assert.equal(report.notify.handoffAcceptanceRate, null);
  assert.equal(report.notify.buyerRate, null);
  assert.equal(report.wishlist.itemConversionRate, null);
  assert.equal(report.wishlist.buyerRate, null);
  for (const value of [
    report.notify.signupRate,
    report.notify.handoffAcceptanceRate,
    report.notify.buyerRate,
    report.wishlist.itemConversionRate,
    report.wishlist.buyerRate,
  ]) {
    assert.equal(value === null || Number.isFinite(value), true);
  }
});

test("uses the default seven-day half-open window and scopes every query to its shop", async () => {
  const db = makeDb({
    events: [
      event("NOTIFY_CLICKED", 0),
      event("NOTIFY_CLICKED", 7 * 24 * 60 * 60 * 1000 - 1),
      event("NOTIFY_CLICKED", 7 * 24 * 60 * 60 * 1000),
      { ...event("NOTIFY_CLICKED"), shopId: "shop-b" },
    ],
  });
  const report = await getMerchantReporting({
    db,
    shopId: shopA,
    now: windowEnd,
  });

  assert.deepEqual(report.window, {
    days: 7,
    start: windowStart.toISOString(),
    end: windowEnd.toISOString(),
  });
  assert.equal(report.notify.clicks, 2);
  assert.ok(
    db.calls.every(({ args }) => {
      const scopedShop = args.where.shopId ?? args.where.notifyRequest?.shopId;
      return scopedShop === shopA;
    }),
  );
});

test("30-day and custom reporting windows apply consistently to all cohort queries", async () => {
  const db = makeDb({
    events: [
      { ...event("NOTIFY_CLICKED", 0), occurredAt: new Date(windowEnd.getTime() - 29 * 86400000) },
      { ...event("NOTIFY_CLICKED", 1), occurredAt: new Date(windowEnd.getTime() - 8 * 86400000) },
    ],
  });
  const report = await getMerchantReporting({ db, shopId: shopA, now: windowEnd, days: 30 });
  assert.equal(report.window.days, 30);
  assert.equal(report.window.start, new Date(windowEnd.getTime() - 30 * 86400000).toISOString());
  assert.equal(report.notify.clicks, 2);
  for (const { args } of db.calls.filter(({ args }) => args.where?.occurredAt || args.where?.paidAt || args.where?.savedAt || args.where?.createdAt)) {
    const filter = args.where.occurredAt ?? args.where.paidAt ?? args.where.savedAt ?? args.where.createdAt;
    assert.equal(filter.gte.toISOString(), report.window.start);
    assert.equal(filter.lt.toISOString(), report.window.end);
  }
});

test("reporting rejects invalid and excessive day ranges", async () => {
  for (const days of [0, -1, 1.5, 91, "7"]) {
    await assert.rejects(
      getMerchantReporting({ db: makeDb(), shopId: shopA, now: windowEnd, days }),
      /input is invalid/,
    );
  }
});

test("counts Wishlist item conversion by distinct product, not order line or variant", async () => {
  const saveEvents = [
    event("WISHLIST_ENTRY_CREATED", 0, {
      wishlistEntryId: "entry-a",
      productShopifyId: "product-a",
      verifiedCustomerShopifyId: "gid://shopify/Customer/1",
    }),
    event("WISHLIST_ENTRY_CREATED", 1, {
      wishlistEntryId: "entry-b",
      productShopifyId: "product-b",
      verifiedCustomerShopifyId: "gid://shopify/Customer/2",
    }),
  ];
  const db = makeDb({
    events: saveEvents,
    wishlistMatches: [
      wishlistMatch({ entryId: "entry-a", productId: "product-a" }),
      wishlistMatch({ entryId: "entry-a", productId: "product-a" }),
    ],
  });
  const report = await getMerchantReporting({
    db,
    shopId: shopA,
    now: windowEnd,
  });

  assert.equal(report.wishlist.itemConversionRate, 0.5);
  const wishlistMatchQuery = db.calls.find(
    ({ model, args }) =>
      model === "orderMatch.findMany" && args.where.source === "WISHLIST_ENTRY",
  );
  assert.equal("variantShopifyId" in wishlistMatchQuery.args.where, false);
});
