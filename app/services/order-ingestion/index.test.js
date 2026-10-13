import assert from "node:assert/strict";
import process from "node:process";
import { createHmac } from "node:crypto";
import test from "node:test";
import { ingestPaidOrderWebhook } from "./index.js";
import { handlePaidOrderWebhook } from "./route-handler.js";

const shopDomain = "paid-orders.myshopify.com";
const shopRecord = { id: "shop-db-id" };
const secret = "s".repeat(40);

function makePayload(overrides = {}) {
  return {
    id: 7654321,
    admin_graphql_api_id: "gid://shopify/Order/7654321",
    created_at: "2026-03-10T12:30:00.000Z",
    financial_status: "paid",
    customer: { id: 24680, email: "Buyer@example.com" },
    line_items: [
      {
        id: 1234,
        product_id: 5678,
        variant_id: 9012,
      },
    ],
    ...overrides,
  };
}

function createDbMock({ existingShop = shopRecord } = {}) {
  const state = {
    events: [],
    analyticsEvents: [],
  };

  const transaction = {
    paidOrderEvent: {
      async create({ data }) {
        if (
          state.events.some(
            (event) =>
              (event.shopId === data.shopId &&
                event.shopifyWebhookId === data.shopifyWebhookId) ||
              (event.shopId === data.shopId &&
                event.orderShopifyId === data.orderShopifyId),
          )
        ) {
          const error = new Error("unique constraint");
          error.code = "P2002";
          throw error;
        }
        state.events.push(data);
      },
    },
    analyticsEvent: {
      async create({ data }) {
        state.analyticsEvents.push(data);
      },
    },
  };

  return {
    state,
    db: {
      shop: {
        async upsert({ create }) {
          return existingShop ?? { id: create.shopifyShopId };
        },
        async findUnique() {
          return existingShop;
        },
      },
      async $transaction(callback) {
        return callback(transaction);
      },
    },
  };
}

function createAdmin() {
  return {
    async graphql() {
      return {
        ok: true,
        async json() {
          return {
            data: {
              shop: {
                id: "gid://shopify/Shop/1",
                myshopifyDomain: shopDomain,
              },
            },
          };
        },
      };
    },
  };
}

async function ingest(db, overrides = {}) {
  return ingestPaidOrderWebhook({
    admin: createAdmin(),
    applicationDb: db,
    payload: makePayload(),
    shopDomain,
    topic: "ORDERS_PAID",
    triggeredAt: "2026-03-10T12:31:00.000Z",
    webhookId: "delivery-1",
    ...overrides,
  });
}

async function withContactSecret(callback) {
  const previousSecret = process.env.NOTIFY_CONTACT_HMAC_SECRET;
  process.env.NOTIFY_CONTACT_HMAC_SECRET = secret;
  try {
    await callback();
  } finally {
    if (previousSecret === undefined) {
      delete process.env.NOTIFY_CONTACT_HMAC_SECRET;
    } else {
      process.env.NOTIFY_CONTACT_HMAC_SECRET = previousSecret;
    }
  }
}

test("accepts an authenticated paid order and persists order and line identifiers", async () => {
  const { db, state } = createDbMock();

  await withContactSecret(async () => {
    const result = await ingest(db);

    assert.equal(result.status, "ingested");
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].orderShopifyId, "gid://shopify/Order/7654321");
    assert.equal(
      state.events[0].verifiedCustomerShopifyId,
      "gid://shopify/Customer/24680",
    );
    assert.equal(state.events[0].lines.create.length, 1);
    assert.deepEqual(state.events[0].lines.create[0], {
      orderLineShopifyId: "gid://shopify/LineItem/1234",
      productShopifyId: "gid://shopify/Product/5678",
      variantShopifyId: "gid://shopify/ProductVariant/9012",
    });
    assert.equal(state.events[0].paidAt.toISOString(), "2026-03-10T12:31:00.000Z");
    assert.equal(state.analyticsEvents.length, 1);
    assert.equal(state.analyticsEvents[0].type, "ORDER_PLACED");
    assert.equal(
      state.analyticsEvents[0].eventKey,
      "shopify:orders/paid:gid://shopify/Order/7654321",
    );
    assert.equal(
      state.analyticsEvents[0].verifiedCustomerShopifyId,
      "gid://shopify/Customer/24680",
    );
    assert.equal(
      state.analyticsEvents[0].orderShopifyId,
      "gid://shopify/Order/7654321",
    );
    assert.equal(state.analyticsEvents[0].sourceSurface, "SHOPIFY_WEBHOOK");
    assert.equal(
      state.events[0].customerEmailDeduplicationKey,
      createHmac("sha256", secret)
        .update("EMAIL\0buyer@example.com")
        .digest("hex"),
    );
    assert.equal(JSON.stringify(state.events).includes("Buyer@example.com"), false);
  });
});

test("deduplicates webhook replays and separate deliveries for the same order and line", async () => {
  const { db, state } = createDbMock();

  await withContactSecret(async () => {
    const first = await ingest(db);
    const replay = await ingest(db);
    const alternateDelivery = await ingest(db, { webhookId: "delivery-2" });

    assert.equal(first.status, "ingested");
    assert.equal(replay.status, "duplicate");
    assert.equal(alternateDelivery.status, "duplicate");
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].lines.create.length, 1);
    assert.equal(state.analyticsEvents.length, 1);
  });
});

test("does not persist orders that are unpaid or lack reliable paid-state information", async () => {
  const { db, state } = createDbMock();

  const unpaid = await ingest(db, {
    payload: makePayload({ financial_status: "pending" }),
  });
  const unknown = await ingest(db, {
    webhookId: "delivery-2",
    payload: makePayload({ financial_status: undefined }),
  });
  const invalidOrder = await ingest(db, {
    webhookId: "delivery-3",
    payload: makePayload({ created_at: "not-a-date" }),
  });

  assert.equal(unpaid.status, "not_paid_or_insufficient_data");
  assert.equal(unknown.status, "not_paid_or_insufficient_data");
  assert.equal(invalidOrder.status, "not_paid_or_insufficient_data");
  assert.equal(state.events.length, 0);
  assert.equal(state.analyticsEvents.length, 0);
});

test("ignores unrelated webhook topics", async () => {
  const { db, state } = createDbMock();

  const result = await ingest(db, { topic: "ORDERS_CREATE" });

  assert.equal(result.status, "ignored_topic");
  assert.equal(state.events.length, 0);
});

test("uses only a verified shop identity when resolving the application shop", async () => {
  const { db, state } = createDbMock();
  let queryCalled = false;
  const admin = {
    async graphql() {
      queryCalled = true;
      return {
        ok: true,
        async json() {
          return {
            data: {
              shop: {
                id: "gid://shopify/Shop/99",
                myshopifyDomain: "different.myshopify.com",
              },
            },
          };
        },
      };
    },
  };

  await withContactSecret(async () => {
    await assert.rejects(
      ingestPaidOrderWebhook({
        admin,
        applicationDb: db,
        payload: makePayload(),
        shopDomain,
        topic: "ORDERS_PAID",
        webhookId: "delivery-1",
      }),
      /Verified shop identity is unavailable/,
    );
    assert.equal(queryCalled, true);
    assert.equal(state.events.length, 0);
  });
});

test("returns a successful no-op when the verified event is an unpaid order", async () => {
  const { db, state } = createDbMock();
  let verifiedRequest;
  const result = await handlePaidOrderWebhook(
    new Request("https://app.example/webhooks/orders/paid"),
    {
      applicationDb: db,
      authenticateWebhook: async (request) => {
        verifiedRequest = request;
        return {
          payload: makePayload({ financial_status: "pending" }),
          shop: shopDomain,
          topic: "ORDERS_PAID",
          webhookId: "delivery-unpaid",
        };
      },
    },
  );

  assert.ok(verifiedRequest instanceof Request);
  assert.equal(result.status, 200);
  assert.equal(state.events.length, 0);
});

test("rejects a webhook that fails Shopify authentication before processing its payload", async () => {
  const { db, state } = createDbMock();
  let payloadProcessingStarted = false;

  await assert.rejects(
    handlePaidOrderWebhook(
      new Request("https://app.example/webhooks/orders/paid"),
      {
        applicationDb: db,
        authenticateWebhook: async () => {
          throw new Response("Unauthorized", { status: 401 });
        },
      },
    ),
    (error) => error instanceof Response && error.status === 401,
  );

  payloadProcessingStarted = state.events.length > 0;
  assert.equal(payloadProcessingStarted, false);
});

test("does not log order contact details while processing", async () => {
  const { db, state } = createDbMock();
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));

  try {
    await withContactSecret(async () => {
      await handlePaidOrderWebhook(
        new Request("https://app.example/webhooks/orders/paid"),
        {
          applicationDb: db,
          authenticateWebhook: async () => ({
            admin: createAdmin(),
            payload: makePayload({
              email: "private@example.com",
              phone: "+1 (555) 123-4567",
            }),
            shop: shopDomain,
            topic: "ORDERS_PAID",
            webhookId: "delivery-private",
          }),
        },
      );
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(logs.length, 0);
  assert.equal(JSON.stringify(state).includes("private@example.com"), false);
  assert.equal(JSON.stringify(state).includes("+1 (555) 123-4567"), false);
});

test("does not accept browser customer identity fields", async () => {
  const { db, state } = createDbMock();

  await withContactSecret(async () => {
    await ingest(db, {
      payload: makePayload({
        customer_id: 99999,
        browser_customer_id: "gid://shopify/Customer/99999",
      }),
    });

    assert.equal(
      state.events[0].verifiedCustomerShopifyId,
      "gid://shopify/Customer/24680",
    );
  });
});
