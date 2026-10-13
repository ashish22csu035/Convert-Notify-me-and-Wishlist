import assert from "node:assert/strict";
import test from "node:test";
import { createNotifyRequest } from "./submission.js";

const baseInput = {
  shopId: "trusted-shop",
  productShopifyId: "gid://shopify/Product/123",
  variantShopifyId: "gid://shopify/ProductVariant/456",
  verifiedCustomerShopifyId: "gid://shopify/Customer/789",
  normalizedContact: "private@example.com",
  contactDeduplicationKey: "keyed-contact-digest",
  consentText: "I agree to receive an email.",
  consentVersion: "notify-email-v1",
  acceptedAt: new Date("2026-10-07T10:00:00.000Z"),
};

function createTransaction() {
  const state = { requests: [], events: [] };
  let nextId = 1;
  const transaction = {
    state,
    async $queryRaw(_strings, shopId) {
      return shopId === "trusted-shop" ? [{ id: shopId }] : [];
    },
    notifyRequest: {
      async findFirst({ where }) {
        return (
          state.requests.find(
            (request) =>
              request.shopId === where.shopId &&
              request.variantShopifyId === where.variantShopifyId &&
              request.contactDeduplicationKey ===
                where.contactDeduplicationKey &&
              where.status.in.includes(request.status),
          ) ?? null
        );
      },
      async create({ data }) {
        const request = { id: `request-${nextId++}`, ...data };
        state.requests.push(request);
        return request;
      },
    },
    analyticsEvent: {
      async create({ data }) {
        if (
          state.events.some(
            (event) =>
              event.shopId === data.shopId && event.eventKey === data.eventKey,
          )
        ) {
          const error = new Error("duplicate event");
          error.code = "P2002";
          throw error;
        }
        state.events.push(data);
        return data;
      },
    },
  };
  return transaction;
}

test("newly accepted unique Notify request creates one reporting signup fact", async () => {
  const transaction = createTransaction();
  const result = await createNotifyRequest(transaction, baseInput);

  assert.equal(result.duplicate, false);
  assert.equal(transaction.state.requests.length, 1);
  assert.equal(transaction.state.events.length, 1);
  assert.deepEqual(transaction.state.events[0], {
    eventKey: "notify-request-created:request-1",
    type: "NOTIFY_REQUEST_CREATED",
    shopId: "trusted-shop",
    productShopifyId: baseInput.productShopifyId,
    variantShopifyId: baseInput.variantShopifyId,
    notifyRequestId: "request-1",
    verifiedCustomerShopifyId: baseInput.verifiedCustomerShopifyId,
    sourceSurface: "PRODUCT_PAGE",
    occurredAt: baseInput.acceptedAt,
  });
  assert.equal(JSON.stringify(transaction.state.events).includes("private@example.com"), false);
});

test("duplicate open Notify submission does not create another signup fact", async () => {
  const transaction = createTransaction();
  await createNotifyRequest(transaction, baseInput);
  const duplicate = await createNotifyRequest(transaction, {
    ...baseInput,
    acceptedAt: new Date(baseInput.acceptedAt.getTime() + 1_000),
  });

  assert.deepEqual(duplicate, { duplicate: true });
  assert.equal(transaction.state.requests.length, 1);
  assert.equal(transaction.state.events.length, 1);
});
