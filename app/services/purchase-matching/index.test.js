import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  processNotifyPaidOrderLine,
  processWishlistPaidOrderLine,
  runNotifyPurchaseMatchingWorker,
} from "./index.js";

const shopId = "shop-db-1";
const orderId = "gid://shopify/Order/100";
const customerId = "gid://shopify/Customer/10";
const variantId = "gid://shopify/ProductVariant/20";
const productId = "gid://shopify/Product/21";
const paidAt = new Date("2026-04-05T12:00:00.000Z");
const anchorAt = new Date("2026-04-03T12:00:00.000Z");
const secret = "purchase-matching-test-secret";
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function digest(kind, value) {
  return createHmac("sha256", secret)
    .update(`${kind}\0${value.trim().toLowerCase()}`)
    .digest("hex");
}

function makeRequest({
  id = "request-1",
  requestShopId = shopId,
  requestVariantId = variantId,
  requestCustomerId = null,
  channel = "EMAIL",
  contactDigest = digest("EMAIL", "buyer@example.com"),
  anchors = [anchorAt],
} = {}) {
  return {
    id,
    shopId: requestShopId,
    variantShopifyId: requestVariantId,
    verifiedCustomerShopifyId: requestCustomerId,
    channel,
    contactDeduplicationKey: contactDigest,
    analyticsEvents: anchors.map((occurredAt) => ({ occurredAt })),
  };
}

function makeLine({
  id = "line-db-1",
  shop = shopId,
  paidOrderId = orderId,
  lineGid = "gid://shopify/LineItem/30",
  lineVariantId = variantId,
  lineProductId = productId,
  at = paidAt,
  orderCreatedAt = new Date("2026-04-05T11:55:00.000Z"),
  orderCustomerId = null,
  emailDigest = null,
  phoneDigest = null,
} = {}) {
  return {
    id,
    orderLineShopifyId: lineGid,
    variantShopifyId: lineVariantId,
    productShopifyId: lineProductId,
    paidOrderEvent: {
      id: `order-event-${id}`,
      shopId: shop,
      orderShopifyId: paidOrderId,
      orderCreatedAt,
      paidAt: at,
      verifiedCustomerShopifyId: orderCustomerId,
      customerEmailDeduplicationKey: emailDigest,
      customerPhoneDeduplicationKey: phoneDigest,
    },
  };
}

function createDb({ lines = [makeLine()], requests = [], wishlistEvents = [], failLineIds = [] } = {}) {
  const state = { matches: [], wishlistEvents };
  const linesById = new Map(lines.map((line) => [line.id, line]));
  const failures = new Set(failLineIds);
  const db = {
    state,
    paidOrderLine: {
      async findUnique({ where, select }) {
        if (failures.has(where.id)) throw new Error("synthetic line failure");
        const line = linesById.get(where.id);
        if (!line) return null;
        return {
          ...line,
          orderMatches: state.matches
            .filter((match) => match.paidOrderLineId === line.id && match.source === select.orderMatches.where.source)
            .map(({ id }) => ({ id })),
        };
      },
      async findMany({ where, take }) {
        const after = where.id?.gt;
        return lines
          .filter(
            (line) =>
              line.paidOrderEvent.paidAt &&
              (!after || line.id > after) &&
              (!state.matches.some(
                (match) => match.paidOrderLineId === line.id && match.source === "NOTIFY_REQUEST",
              ) || !state.matches.some(
                (match) => match.paidOrderLineId === line.id && match.source === "WISHLIST_ENTRY",
              )),
          )
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, take)
          .map(({ id }) => ({ id }));
      },
    },
    notifyRequest: {
      async findMany({ where }) {
        return requests.filter(
          (request) =>
            request.shopId === where.shopId &&
            request.variantShopifyId === where.variantShopifyId &&
            request.analyticsEvents.length > 0,
        );
      },
    },
    analyticsEvent: {
      async findMany({ where }) {
        return state.wishlistEvents
          .filter((event) =>
            event.shopId === where.shopId &&
            event.productShopifyId === where.productShopifyId &&
            where.type.in.includes(event.type) &&
            event.occurredAt <= where.occurredAt.lte,
          )
          .sort((a, b) => a.occurredAt - b.occurredAt);
      },
    },
    orderMatch: {
      async create({ data }) {
        if (
          state.matches.some(
            (match) =>
              match.shopId === data.shopId &&
              match.orderShopifyId === data.orderShopifyId &&
              match.orderLineShopifyId === data.orderLineShopifyId &&
              match.source === data.source,
          )
        ) {
          const error = new Error("unique match");
          error.code = "P2002";
          throw error;
        }
        const match = { id: `match-${state.matches.length + 1}`, ...data };
        state.matches.push(match);
        return match;
      },
    },
  };
  return db;
}

async function process(db, lineId = "line-db-1") {
  return processNotifyPaidOrderLine({
    db,
    paidOrderLineId: lineId,
    now: new Date("2026-04-06T00:00:00.000Z"),
  });
}

const wishlistEntryId = "wishlist-entry-1";
const wishlistSaveAt = new Date("2026-04-03T12:00:00.000Z");

function makeWishlistEvent({
  type = "WISHLIST_ENTRY_CREATED",
  entryId = wishlistEntryId,
  shop = shopId,
  product = productId,
  at = wishlistSaveAt,
  customer = null,
  email = null,
  phone = null,
} = {}) {
  return {
    id: `${entryId}:${type}:${at.toISOString()}`,
    type,
    wishlistEntryId: entryId,
    shopId: shop,
    productShopifyId: product,
    occurredAt: at,
    createdAt: at,
    verifiedCustomerShopifyId: customer,
    emailIdentityDigest: email,
    phoneIdentityDigest: phone,
  };
}

async function processWishlist(db, lineId = "line-db-1") {
  return processWishlistPaidOrderLine({
    db,
    paidOrderLineId: lineId,
    now: new Date("2026-04-06T00:00:00.000Z"),
  });
}

function wishlistDb({ line, events = [] } = {}) {
  line ??= makeLine({ orderCustomerId: customerId });
  return createDb({ lines: [line], wishlistEvents: events });
}

test("matches a paid line by verified Shopify customer ID", async () => {
  const db = createDb({
    lines: [makeLine({ orderCustomerId: customerId })],
    requests: [makeRequest({ requestCustomerId: customerId })],
  });
  assert.equal((await process(db)).status, "matched");
  assert.equal(db.state.matches[0].notifyRequestId, "request-1");
});

test("uses exact email digest fallback when customer ID is unavailable", async () => {
  const db = createDb({
    lines: [makeLine({ emailDigest: digest("EMAIL", "buyer@example.com") })],
    requests: [makeRequest()],
  });
  assert.equal((await process(db)).status, "matched");
});

test("uses exact phone digest fallback when an SMS request digest exists", async () => {
  const db = createDb({
    lines: [makeLine({ phoneDigest: digest("PHONE", "+15551234567") })],
    requests: [
      makeRequest({
        channel: "SMS",
        contactDigest: digest("PHONE", "+15551234567"),
      }),
    ],
  });
  assert.equal((await process(db)).status, "matched");
});

for (const [label, timestamp] of [
  ["before accepted handoff", new Date(anchorAt.getTime() - 1)],
  ["exactly at accepted handoff", anchorAt],
  ["exactly seven days after accepted handoff", new Date(anchorAt.getTime() + 7 * 86400000)],
  ["after seven days", new Date(anchorAt.getTime() + 7 * 86400000 + 1)],
]) {
  test(`does not match a purchase ${label}`, async () => {
    const db = createDb({
      lines: [makeLine({ at: timestamp, emailDigest: digest("EMAIL", "buyer@example.com") })],
      requests: [makeRequest()],
    });
    assert.equal((await process(db)).status, "unmatched");
    assert.equal(db.state.matches.length, 0);
  });
}

test("does not match a different variant", async () => {
  const db = createDb({
    lines: [makeLine({ lineVariantId: "gid://shopify/ProductVariant/99" })],
    requests: [makeRequest()],
  });
  assert.equal((await process(db)).status, "unmatched");
});

test("does not match a request from a different shop", async () => {
  const db = createDb({
    requests: [makeRequest({ requestShopId: "other-shop" })],
  });
  assert.equal((await process(db)).status, "unmatched");
});

test("chooses the latest eligible accepted handoff", async () => {
  const earlier = makeRequest({
    id: "earlier",
    requestCustomerId: customerId,
    anchors: [new Date("2026-04-01T12:00:00.000Z")],
  });
  const later = makeRequest({
    id: "later",
    requestCustomerId: customerId,
    anchors: [new Date("2026-04-04T12:00:00.000Z")],
  });
  const db = createDb({
    lines: [makeLine({ orderCustomerId: customerId })],
    requests: [earlier, later],
  });
  assert.equal((await process(db)).status, "matched");
  assert.equal(db.state.matches[0].notifyRequestId, "later");
});

test("leaves conflicting verified ID and exact contact identity unmatched", async () => {
  const db = createDb({
    lines: [
      makeLine({
        orderCustomerId: customerId,
        emailDigest: digest("EMAIL", "buyer@example.com"),
      }),
    ],
    requests: [
      makeRequest({ requestCustomerId: "gid://shopify/Customer/99" }),
    ],
  });
  assert.equal((await process(db)).status, "unmatched");
  assert.equal(db.state.matches.length, 0);
});

test("leaves a shared contact digest across different customer IDs ambiguous", async () => {
  const db = createDb({
    lines: [
      makeLine({ emailDigest: digest("EMAIL", "buyer@example.com") }),
    ],
    requests: [
      makeRequest({ requestCustomerId: customerId }),
      makeRequest({
        id: "same-email-other-customer",
        requestCustomerId: "gid://shopify/Customer/99",
      }),
    ],
  });
  assert.equal((await process(db)).status, "unmatched");
  assert.equal(db.state.matches.length, 0);
});

test("leaves a missing paidAt unmatched", async () => {
  const db = createDb({
    lines: [makeLine({ at: null, emailDigest: digest("EMAIL", "buyer@example.com") })],
    requests: [makeRequest()],
  });
  assert.equal((await process(db)).status, "unmatched");
});

test("leaves an order without any usable identity unmatched", async () => {
  const db = createDb({ requests: [makeRequest()] });
  assert.equal((await process(db)).status, "unmatched");
});

test("is idempotent when the same order line is matched repeatedly", async () => {
  const db = createDb({
    lines: [makeLine({ orderCustomerId: customerId })],
    requests: [makeRequest({ requestCustomerId: customerId })],
  });
  assert.equal((await process(db)).status, "matched");
  assert.equal((await process(db)).status, "already_matched");
  assert.equal(db.state.matches.length, 1);
});

test("creates at most one Notify match per order line and selects latest request", async () => {
  const db = createDb({
    lines: [makeLine({ orderCustomerId: customerId })],
    requests: [
      makeRequest({ id: "first", requestCustomerId: customerId }),
      makeRequest({
        id: "second",
        requestCustomerId: customerId,
        anchors: [new Date("2026-04-04T12:00:00.000Z")],
      }),
    ],
  });
  await process(db);
  await process(db);
  assert.equal(db.state.matches.length, 1);
  assert.equal(db.state.matches[0].notifyRequestId, "second");
  assert.equal(db.state.matches[0].source, "NOTIFY_REQUEST");
});

test("allows feature-scoped Notify and Wishlist matches for the same order line", async () => {
  const db = createDb({
    lines: [makeLine({ orderCustomerId: customerId })],
    requests: [makeRequest({ requestCustomerId: customerId })],
    wishlistEvents: [makeWishlistEvent({ customer: customerId })],
  });
  await process(db);
  await db.orderMatch.create({
    data: {
      shopId,
      orderShopifyId: orderId,
      orderLineShopifyId: "gid://shopify/LineItem/30",
      paidOrderLineId: "line-db-1",
      source: "WISHLIST_ENTRY",
      wishlistEntryId: "future-wishlist-entry",
      orderCreatedAt: new Date("2026-04-05T11:55:00.000Z"),
      paidAt,
    },
  });
  assert.deepEqual(
    db.state.matches.map((match) => match.source).sort(),
    ["NOTIFY_REQUEST", "WISHLIST_ENTRY"],
  );
});

test("worker continues after a line failure and returns structured counts", async () => {
  const db = createDb({
    lines: [
      makeLine({ id: "a-fails", orderCustomerId: customerId }),
      makeLine({ id: "b-succeeds", orderCustomerId: customerId }),
    ],
    requests: [makeRequest({ requestCustomerId: customerId })],
    wishlistEvents: [makeWishlistEvent({ customer: customerId })],
    failLineIds: ["a-fails"],
  });
  const summary = await runNotifyPurchaseMatchingWorker({ db, batchSize: 1 });
  assert.equal(summary.status, "completed_with_errors");
  assert.equal(summary.candidateCount, 2);
  assert.equal(summary.failedCount, 2);
  assert.equal(summary.matchedCount, 1);
  assert.equal(summary.wishlistFailedCount, 1);
  assert.equal(summary.wishlistMatchedCount, 1);
  assert.equal(db.state.matches.length, 2);
});

test("Wishlist matching accepts a verified customer ID match", async () => {
  const db = wishlistDb({ events: [makeWishlistEvent({ customer: customerId })] });
  assert.equal((await processWishlist(db)).status, "matched");
  assert.equal(db.state.matches[0].source, "WISHLIST_ENTRY");
  assert.equal(db.state.matches[0].wishlistEntryId, wishlistEntryId);
  assert.equal(db.state.matches[0].paidAt, paidAt);
});

test("Wishlist matching falls back to exact email digest", async () => {
  const email = digest("EMAIL", "buyer@example.com");
  const db = wishlistDb({
    line: makeLine({ emailDigest: email }),
    events: [makeWishlistEvent({ email })],
  });
  assert.equal((await processWishlist(db)).status, "matched");
});

test("Wishlist matching falls back to exact phone digest", async () => {
  const phone = digest("PHONE", "+15551234567");
  const db = wishlistDb({
    line: makeLine({ phoneDigest: phone }),
    events: [makeWishlistEvent({ phone })],
  });
  assert.equal((await processWishlist(db)).status, "matched");
});

test("Wishlist matching leaves orders without usable identity unmatched", async () => {
  const db = wishlistDb({
    line: makeLine({ orderCustomerId: null }),
    events: [makeWishlistEvent()],
  });
  assert.equal((await processWishlist(db)).status, "unmatched");
});

test("conflicting verified customer identity is not downgraded to matching email", async () => {
  const email = digest("EMAIL", "buyer@example.com");
  const db = wishlistDb({
    line: makeLine({ orderCustomerId: customerId, emailDigest: email }),
    events: [makeWishlistEvent({ customer: "gid://shopify/Customer/99", email })],
  });
  assert.equal((await processWishlist(db)).status, "unmatched");
});

test("ambiguous email and phone identities across customers are unmatched", async () => {
  const email = digest("EMAIL", "buyer@example.com");
  const phone = digest("PHONE", "+15551234567");
  const db = wishlistDb({
    line: makeLine({ emailDigest: email, phoneDigest: phone }),
    events: [
      makeWishlistEvent({ entryId: "email-owner", customer: customerId, email }),
      makeWishlistEvent({ entryId: "phone-owner", customer: "gid://shopify/Customer/99", phone }),
    ],
  });
  assert.equal((await processWishlist(db)).status, "unmatched");
});

test("a shared fallback digest across verified customers is ambiguous", async () => {
  const email = digest("EMAIL", "buyer@example.com");
  const db = wishlistDb({
    line: makeLine({ orderCustomerId: null, emailDigest: email }),
    events: [
      makeWishlistEvent({ entryId: "customer-a", customer: customerId, email }),
      makeWishlistEvent({ entryId: "customer-b", customer: "gid://shopify/Customer/99", email }),
    ],
  });
  assert.equal((await processWishlist(db)).status, "unmatched");
});

test("Wishlist matches by product even when the purchased variant differs", async () => {
  const db = wishlistDb({
    line: makeLine({ lineVariantId: "gid://shopify/ProductVariant/999", orderCustomerId: customerId }),
    events: [makeWishlistEvent({ customer: customerId })],
  });
  assert.equal((await processWishlist(db)).status, "matched");
});

test("Wishlist does not match a different product", async () => {
  const db = wishlistDb({
    line: makeLine({ lineProductId: "gid://shopify/Product/404", orderCustomerId: customerId }),
    events: [makeWishlistEvent({ customer: customerId })],
  });
  assert.equal((await processWishlist(db)).status, "unmatched");
});

for (const [label, timestamp] of [
  ["before save", new Date(wishlistSaveAt.getTime() - 1)],
  ["exactly at save", wishlistSaveAt],
  ["exactly seven days after save", new Date(wishlistSaveAt.getTime() + WINDOW_MS)],
  ["after seven days", new Date(wishlistSaveAt.getTime() + WINDOW_MS + 1)],
]) {
  test(`Wishlist does not match a purchase ${label}`, async () => {
    const db = wishlistDb({
      line: makeLine({ at: timestamp, orderCustomerId: customerId }),
      events: [makeWishlistEvent({ customer: customerId })],
    });
    assert.equal((await processWishlist(db)).status, "unmatched");
  });
}

test("Wishlist episode matches while active at purchase time", async () => {
  const db = wishlistDb({ events: [makeWishlistEvent({ customer: customerId })] });
  assert.equal((await processWishlist(db)).status, "matched");
});

test("Wishlist episode removed before purchase is not eligible", async () => {
  const db = wishlistDb({
    events: [
      makeWishlistEvent({ customer: customerId }),
      makeWishlistEvent({
        type: "WISHLIST_ENTRY_REMOVED",
        at: new Date("2026-04-04T12:00:00.000Z"),
      }),
    ],
  });
  assert.equal((await processWishlist(db)).status, "unmatched");
});

test("Wishlist episode removed exactly at purchase time is inactive", async () => {
  const db = wishlistDb({
    events: [
      makeWishlistEvent({ customer: customerId }),
      makeWishlistEvent({
        type: "WISHLIST_ENTRY_REMOVED",
        at: paidAt,
      }),
    ],
  });
  assert.equal((await processWishlist(db)).status, "unmatched");
});

test("save, remove, re-save creates an independently eligible episode", async () => {
  const db = wishlistDb({
    events: [
      makeWishlistEvent({ customer: customerId }),
      makeWishlistEvent({
        type: "WISHLIST_ENTRY_REMOVED",
        at: new Date("2026-04-04T00:00:00.000Z"),
      }),
      makeWishlistEvent({ at: new Date("2026-04-04T12:00:00.000Z"), customer: customerId }),
    ],
  });
  assert.equal((await processWishlist(db)).status, "matched");
  assert.equal(db.state.matches[0].wishlistEntryId, wishlistEntryId);
});

test("latest eligible Wishlist save episode wins", async () => {
  const db = wishlistDb({
    events: [
      makeWishlistEvent({ entryId: "earlier", customer: customerId }),
      makeWishlistEvent({
        entryId: "latest",
        at: new Date("2026-04-04T12:00:00.000Z"),
        customer: customerId,
      }),
    ],
  });
  assert.equal((await processWishlist(db)).status, "matched");
  assert.equal(db.state.matches[0].wishlistEntryId, "latest");
});

test("an older episode outside the seven-day window does not win", async () => {
  const db = wishlistDb({
    line: makeLine({ at: new Date("2026-04-12T12:00:00.000Z"), orderCustomerId: customerId }),
    events: [
      makeWishlistEvent({ entryId: "expired", customer: customerId, at: new Date("2026-04-01T12:00:00.000Z") }),
      makeWishlistEvent({ entryId: "eligible", customer: customerId, at: new Date("2026-04-10T12:00:00.000Z") }),
    ],
  });
  assert.equal((await processWishlist(db)).status, "matched");
  assert.equal(db.state.matches[0].wishlistEntryId, "eligible");
});

test("old episodes without contact digests can match by verified customer ID", async () => {
  const db = wishlistDb({
    line: makeLine({ orderCustomerId: customerId }),
    events: [makeWishlistEvent({ customer: customerId, email: null, phone: null })],
  });
  assert.equal((await processWishlist(db)).status, "matched");
});

test("Wishlist matching requires paidAt", async () => {
  const db = wishlistDb({
    line: makeLine({ at: null, orderCustomerId: customerId }),
    events: [makeWishlistEvent({ customer: customerId })],
  });
  assert.equal((await processWishlist(db)).status, "unmatched");
});

test("replayed paid order creates no duplicate Wishlist match", async () => {
  const db = wishlistDb({
    line: makeLine({ orderCustomerId: customerId }),
    events: [makeWishlistEvent({ customer: customerId })],
  });
  assert.equal((await processWishlist(db)).status, "matched");
  assert.equal((await processWishlist(db)).status, "already_matched");
  assert.equal(db.state.matches.length, 1);
});

test("one order line matches only the latest eligible Wishlist episode", async () => {
  const db = wishlistDb({
    line: makeLine({ orderCustomerId: customerId }),
    events: [
      makeWishlistEvent({ entryId: "first", customer: customerId }),
      makeWishlistEvent({ entryId: "second", customer: customerId, at: new Date("2026-04-04T00:00:00.000Z") }),
    ],
  });
  await processWishlist(db);
  assert.equal(db.state.matches.length, 1);
  assert.equal(db.state.matches[0].wishlistEntryId, "second");
});

test("the same order line can have both Notify and Wishlist attribution", async () => {
  const db = createDb({
    lines: [makeLine({ orderCustomerId: customerId })],
    requests: [makeRequest({ requestCustomerId: customerId })],
    wishlistEvents: [makeWishlistEvent({ customer: customerId })],
  });
  assert.equal((await process(db)).status, "matched");
  assert.equal((await processWishlist(db)).status, "matched");
  assert.deepEqual(db.state.matches.map((match) => match.source).sort(), ["NOTIFY_REQUEST", "WISHLIST_ENTRY"]);
});

test("Wishlist customer isolation prevents another customer's save from matching", async () => {
  const db = wishlistDb({
    line: makeLine({ orderCustomerId: customerId }),
    events: [makeWishlistEvent({ customer: "gid://shopify/Customer/99" })],
  });
  assert.equal((await processWishlist(db)).status, "unmatched");
});

test("Wishlist event shop isolation prevents cross-shop matching", async () => {
  const db = wishlistDb({
    line: makeLine({ orderCustomerId: customerId }),
    events: [makeWishlistEvent({ shop: "other-shop", customer: customerId })],
  });
  assert.equal((await processWishlist(db)).status, "unmatched");
});

test("existing worker processes both features and remains idempotent across runs", async () => {
  const db = createDb({
    lines: [makeLine({ orderCustomerId: customerId })],
    requests: [makeRequest({ requestCustomerId: customerId })],
    wishlistEvents: [makeWishlistEvent({ customer: customerId })],
  });
  const first = await runNotifyPurchaseMatchingWorker({ db });
  assert.equal(first.matchedCount, 1);
  assert.equal(first.wishlistMatchedCount, 1);
  const second = await runNotifyPurchaseMatchingWorker({ db });
  assert.equal(second.candidateCount, 0);
  assert.equal(db.state.matches.length, 2);
});
