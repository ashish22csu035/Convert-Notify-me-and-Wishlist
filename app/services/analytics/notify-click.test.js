import assert from "node:assert/strict";
import test from "node:test";
import { handleNotifyClick } from "./notify-click.js";

const clickId = "a9f7c54e-7a4e-4a21-8df6-328bfc221a10";
const shopDomain = "analytics-shop.myshopify.com";
const productId = "gid://shopify/Product/123";
const variantId = "gid://shopify/ProductVariant/456";

function makeDatabase() {
  const events = [];
  return {
    events,
    shop: {
      async findUnique() {
        return { notifyEnabled: true, wishlistEnabled: true };
      },
      async upsert() {
        return { id: "trusted-shop-record" };
      },
    },
    async $transaction(callback) {
      return callback({
        analyticsEvent: {
          async create({ data }) {
            if (
              events.some(
                (event) =>
                  event.shopId === data.shopId &&
                  event.eventKey === data.eventKey,
              )
            ) {
              const error = new Error("duplicate event");
              error.code = "P2002";
              throw error;
            }
            events.push(data);
            return data;
          },
        },
      });
    },
  };
}

function request(body, { customerId = "987", shop = shopDomain } = {}) {
  return new Request(
    `https://app.example/api/notify/analytics?shop=${shop}&logged_in_customer_id=${customerId}&signature=signed`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function dependencies(applicationDb) {
  return {
    applicationDb,
    now: () => new Date("2026-10-07T10:00:00.000Z"),
    authenticateProxy: async () => ({
      session: { shop: shopDomain },
      admin: {
        async graphql(_query, { variables }) {
          assert.equal(variables.variantId, variantId);
          return {
            ok: true,
            async json() {
              return {
                data: {
                  shop: {
                    id: "gid://shopify/Shop/42",
                    myshopifyDomain: shopDomain,
                  },
                  productVariant: {
                    id: variantId,
                    product: { id: productId },
                  },
                },
              };
            },
          };
        },
      },
    }),
  };
}

const body = { clickId, productId, variantId };

test("intentional Notify click is recorded once with trusted shop and product data", async () => {
  const db = makeDatabase();
  const response = await handleNotifyClick(request(body), dependencies(db));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { recorded: true, duplicate: false });
  assert.deepEqual(db.events[0], {
    eventKey: `notify-click:${clickId}`,
    type: "NOTIFY_CLICKED",
    shopId: "trusted-shop-record",
    productShopifyId: productId,
    variantShopifyId: variantId,
    verifiedCustomerShopifyId: "gid://shopify/Customer/987",
    sourceSurface: "PRODUCT_PAGE",
    occurredAt: new Date("2026-10-07T10:00:00.000Z"),
  });
});

test("duplicate click listener submissions with the same click ID are idempotent", async () => {
  const db = makeDatabase();
  const deps = dependencies(db);
  const first = await handleNotifyClick(request(body), deps);
  const second = await handleNotifyClick(request(body), deps);

  assert.deepEqual(await first.json(), { recorded: true, duplicate: false });
  assert.deepEqual(await second.json(), { recorded: false, duplicate: true });
  assert.equal(db.events.length, 1);
});

test("caller-supplied shop identity is rejected and cannot redirect analytics writes", async () => {
  const db = makeDatabase();
  const response = await handleNotifyClick(
    request({ ...body, shopId: "attacker-shop" }),
    dependencies(db),
  );

  assert.equal(response.status, 400);
  assert.equal(db.events.length, 0);
});

test("guest click is recorded without inventing a customer identity", async () => {
  const db = makeDatabase();
  const response = await handleNotifyClick(
    request(body, { customerId: "" }),
    dependencies(db),
  );

  assert.equal(response.status, 200);
  assert.equal(db.events[0].verifiedCustomerShopifyId, null);
});
