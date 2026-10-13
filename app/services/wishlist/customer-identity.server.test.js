import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import {
  createCustomerIdentityDigests,
  normalizeEmail,
  normalizePhone,
} from "../order-ingestion/index.js";
import {
  getWishlistCustomerIdentitySnapshot,
  lookupWishlistCustomerIdentity,
} from "./customer-identity.server.js";

const customerShopifyId = "gid://shopify/Customer/123";
const secret = "test-secret-with-at-least-32-characters";

function adminFor(customer) {
  let call;
  return {
    get call() {
      return call;
    },
    admin: {
      async graphql(query, options) {
        call = { query, options };
        return {
          ok: true,
          async json() {
            return { data: { customer } };
          },
        };
      },
    },
  };
}

test("customer lookup snapshots email and phone through existing normalization and HMAC", async () => {
  const previous = process.env.NOTIFY_CONTACT_HMAC_SECRET;
  process.env.NOTIFY_CONTACT_HMAC_SECRET = secret;
  try {
    const harness = adminFor({
      defaultEmailAddress: { emailAddress: " Buyer@Example.COM " },
      defaultPhoneNumber: { phoneNumber: "+1 (555) 123-4567" },
    });
    const digests = await lookupWishlistCustomerIdentity({ admin: harness.admin, customerShopifyId });
    const expected = createCustomerIdentityDigests({
      email: normalizeEmail(" Buyer@Example.COM "),
      phone: normalizePhone("+1 (555) 123-4567"),
    });

    assert.deepEqual(digests, expected);
    assert.equal(harness.call.options.variables.id, customerShopifyId);
    assert.match(harness.call.query, /defaultEmailAddress\s*\{\s*emailAddress/s);
    assert.match(harness.call.query, /defaultPhoneNumber\s*\{\s*phoneNumber/s);
    assert.doesNotMatch(harness.call.query, /firstName|lastName|orders/);
  } finally {
    if (previous === undefined) delete process.env.NOTIFY_CONTACT_HMAC_SECRET;
    else process.env.NOTIFY_CONTACT_HMAC_SECRET = previous;
  }
});

test("lookup supports email only, phone only, and no contact fields", async () => {
  for (const [customer, expectedEmail, expectedPhone] of [
    [{ defaultEmailAddress: { emailAddress: "one@example.com" } }, true, false],
    [{ defaultPhoneNumber: { phoneNumber: "+15551234567" } }, false, true],
    [{ defaultEmailAddress: null, defaultPhoneNumber: null }, false, false],
  ]) {
    const previous = process.env.NOTIFY_CONTACT_HMAC_SECRET;
    process.env.NOTIFY_CONTACT_HMAC_SECRET = secret;
    try {
      const { admin } = adminFor(customer);
      const digests = await lookupWishlistCustomerIdentity({ admin, customerShopifyId });
      assert.equal(Boolean(digests.emailIdentityDigest), expectedEmail);
      assert.equal(Boolean(digests.phoneIdentityDigest), expectedPhone);
    } finally {
      if (previous === undefined) delete process.env.NOTIFY_CONTACT_HMAC_SECRET;
      else process.env.NOTIFY_CONTACT_HMAC_SECRET = previous;
    }
  }
});

test("lookup rejects invalid IDs and Shopify API failures without inventing digests", async () => {
  const { admin } = adminFor({ defaultEmailAddress: null, defaultPhoneNumber: null });
  await assert.rejects(
    lookupWishlistCustomerIdentity({ admin, customerShopifyId: "gid://shopify/Customer/1 OR true" }),
    TypeError,
  );
  await assert.rejects(
    lookupWishlistCustomerIdentity({
      admin: { async graphql() { return { ok: false, async json() { return {}; } }; } },
      customerShopifyId,
    }),
    /lookup failed/,
  );
});

test("customer lookup failures continue with null digests and expose only an error class", async () => {
  const observed = [];
  const snapshot = await getWishlistCustomerIdentitySnapshot({
    admin: {
      async graphql() {
        throw new Error("private@example.com +15550001111");
      },
    },
    customerShopifyId,
    onLookupError: (name) => observed.push(name),
  });

  assert.deepEqual(snapshot, { emailIdentityDigest: null, phoneIdentityDigest: null });
  assert.deepEqual(observed, ["Error"]);
  assert.equal(JSON.stringify(observed).includes("private@example.com"), false);
  assert.equal(JSON.stringify(observed).includes("+15550001111"), false);
});

test("identity result contains digests only and never includes raw contact values", async () => {
  const previous = process.env.NOTIFY_CONTACT_HMAC_SECRET;
  process.env.NOTIFY_CONTACT_HMAC_SECRET = secret;
  try {
    const email = "private@example.com";
    const phone = "+15550001111";
    const { admin } = adminFor({
      defaultEmailAddress: { emailAddress: email },
      defaultPhoneNumber: { phoneNumber: phone },
    });
    const result = await lookupWishlistCustomerIdentity({ admin, customerShopifyId });
    assert.equal(JSON.stringify(result).includes(email), false);
    assert.equal(JSON.stringify(result).includes(phone), false);
    assert.deepEqual(Object.keys(result).sort(), ["emailIdentityDigest", "phoneIdentityDigest"]);
  } finally {
    if (previous === undefined) delete process.env.NOTIFY_CONTACT_HMAC_SECRET;
    else process.env.NOTIFY_CONTACT_HMAC_SECRET = previous;
  }
});
