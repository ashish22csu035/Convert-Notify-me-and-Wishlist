import assert from "node:assert/strict";
import test from "node:test";
import { authenticateAppProxyCustomer } from "./app-proxy-customer.server.js";

function requestWithParams(parameters) {
  const search = new URLSearchParams(parameters);
  return new Request(`https://app.example.com/api/wishlist?${search}`);
}

test("derives customer identity only from a signed app proxy context", async () => {
  const request = requestWithParams({
    shop: "shop.myshopify.com",
    logged_in_customer_id: "123",
  });
  let authenticated = false;
  const identity = await authenticateAppProxyCustomer(request, async () => {
    authenticated = true;
    return {
      session: { shop: "shop.myshopify.com" },
      admin: { graphql() {} },
    };
  });

  assert.equal(authenticated, true);
  assert.deepEqual(identity, {
    admin: { graphql: identity.admin.graphql },
    shopDomain: "shop.myshopify.com",
    customerShopifyId: "gid://shopify/Customer/123",
  });
});

test("rejects guest app proxy requests without an authenticated customer", async () => {
  const request = requestWithParams({
    shop: "shop.myshopify.com",
    logged_in_customer_id: "",
  });
  const identity = await authenticateAppProxyCustomer(request, async () => ({
    session: { shop: "shop.myshopify.com" },
    admin: { graphql() {} },
  }));

  assert.equal(identity, null);
});

test("rejects signed shop/session mismatches and missing admin context", async () => {
  const request = requestWithParams({
    shop: "shop.myshopify.com",
    logged_in_customer_id: "123",
  });
  const mismatch = await authenticateAppProxyCustomer(request, async () => ({
    session: { shop: "another.myshopify.com" },
    admin: { graphql() {} },
  }));
  const noAdmin = await authenticateAppProxyCustomer(request, async () => ({
    session: { shop: "shop.myshopify.com" },
    admin: undefined,
  }));

  assert.equal(mismatch, null);
  assert.equal(noAdmin, null);
});
