import assert from "node:assert/strict";
import test from "node:test";
import {
  listWishlistEntries,
  removeWishlistEntry,
  saveWishlistEntry,
} from "./index.js";
import {
  parseAddWishlistInput,
  parseRemoveWishlistInput,
} from "./request-validation.js";
import {
  verifyWishlistProduct,
  verifyWishlistVariant,
} from "./shopify-validation.js";

const shopId = "shop-record-1";
const customerA = "gid://shopify/Customer/111";
const customerB = "gid://shopify/Customer/222";
const productId = "gid://shopify/Product/333";
const variantOne = "gid://shopify/ProductVariant/444";
const variantTwo = "gid://shopify/ProductVariant/555";
const now = new Date("2026-10-06T12:00:00.000Z");
const eventsOfType = (db, type) =>
  db.state.events.filter((event) => event.type === type);

function createDatabase(entries = []) {
  const state = {
    entries: entries.map((entry) => ({ ...entry })),
    events: [],
  };
  let nextEntryId = 1;

  const matches = (entry, where) =>
    Object.entries(where).every(([key, value]) => entry[key] === value);

  const db = {
    state,
    async $transaction(callback) {
      return callback(db);
    },
    async $queryRaw(strings, shopParam) {
      assert.match(
        strings.join("?"),
        /SELECT id FROM Shop WHERE id = \? FOR UPDATE/,
      );
      return shopParam === shopId ? [{ id: shopId }] : [];
    },
    wishlistEntry: {
      async findMany({ where }) {
        return state.entries
          .filter((entry) => matches(entry, where))
          .sort((left, right) => right.savedAt - left.savedAt)
          .map(
            ({ id, productShopifyId, preferredVariantShopifyId, savedAt }) => ({
              id,
              productShopifyId,
              preferredVariantShopifyId,
              savedAt,
            }),
          );
      },
      async findUnique({ where }) {
        const identity =
          where.shopId_verifiedCustomerShopifyId_productShopifyId;
        return state.entries.find((entry) => matches(entry, identity)) ?? null;
      },
      async findFirst({ where }) {
        return state.entries.find((entry) => matches(entry, where)) ?? null;
      },
      async create({ data, select }) {
        const entry = {
          id: `wishlist-${nextEntryId++}`,
          savedAt: now,
          isActive: true,
          deactivatedAt: null,
          ...data,
        };
        state.entries.push(entry);
        return Object.fromEntries(
          Object.keys(select).map((key) => [key, entry[key]]),
        );
      },
      async update({ where, data, select }) {
        const entry = state.entries.find(({ id }) => id === where.id);
        assert.ok(entry);
        Object.assign(entry, data);
        return Object.fromEntries(
          Object.keys(select).map((key) => [key, entry[key]]),
        );
      },
      async updateMany({ where, data }) {
        const entry = state.entries.find((candidate) =>
          matches(candidate, where),
        );
        if (!entry) {
          return { count: 0 };
        }
        Object.assign(entry, data);
        return { count: 1 };
      },
    },
    analyticsEvent: {
      async create({ data }) {
        state.events.push({ id: `event-${state.events.length + 1}`, ...data });
        return data;
      },
    },
  };
  return db;
}

function activeEntry({
  id = "wishlist-existing",
  owner = customerA,
  shop = shopId,
  productShopifyId = productId,
  preferredVariantShopifyId = variantOne,
  isActive = true,
} = {}) {
  return {
    id,
    shopId: shop,
    verifiedCustomerShopifyId: owner,
    productShopifyId,
    preferredVariantShopifyId,
    savedAt: new Date("2026-10-05T12:00:00.000Z"),
    isActive,
    deactivatedAt: isActive ? null : new Date("2026-10-05T13:00:00.000Z"),
  };
}

test("authenticated customer can add a product and records a confirmed event", async () => {
  const db = createDatabase();
  const result = await saveWishlistEntry({
    db,
    shopId,
    customerShopifyId: customerA,
    productShopifyId: productId,
    preferredVariantShopifyId: variantOne,
    now,
  });

  assert.equal(result.added, true);
  assert.equal(result.entry.productShopifyId, productId);
  assert.equal(result.entry.preferredVariantShopifyId, variantOne);
  assert.equal(db.state.entries.length, 1);
  assert.equal(db.state.events.length, 2);
  assert.equal(db.state.events[1].type, "WISHLIST_CLICKED");
  assert.equal(db.state.events[0].verifiedCustomerShopifyId, customerA);
  assert.equal(db.state.events[0].sourceSurface, "STOREFRONT");
  assert.equal(db.state.events[0].type, "WISHLIST_ENTRY_CREATED");
  assert.equal(db.state.events[0].shopId, shopId);
  assert.equal(db.state.events[0].wishlistEntryId, result.entry.id);
  assert.equal(db.state.events[0].variantShopifyId, variantOne);
  assert.equal(db.state.events[0].emailIdentityDigest, null);
  assert.equal(db.state.events[0].phoneIdentityDigest, null);
});

test("new save stores only supplied digests on its created event", async () => {
  const db = createDatabase();
  const result = await saveWishlistEntry({
    db,
    shopId,
    customerShopifyId: customerA,
    productShopifyId: productId,
    emailIdentityDigest: "a".repeat(64),
    phoneIdentityDigest: "b".repeat(64),
    now,
  });

  assert.equal(result.added, true);
  assert.equal(db.state.events[0].emailIdentityDigest, "a".repeat(64));
  assert.equal(db.state.events[0].phoneIdentityDigest, "b".repeat(64));
  assert.equal("emailIdentityDigest" in db.state.entries[0], false);
  assert.equal("phoneIdentityDigest" in db.state.entries[0], false);
});

test("authenticated customer can read only their own active entries", async () => {
  const db = createDatabase([
    activeEntry({ id: "a-item" }),
    activeEntry({ id: "b-item", owner: customerB }),
    activeEntry({ id: "inactive-item", isActive: false }),
    activeEntry({ id: "other-shop-item", shop: "shop-record-2" }),
  ]);
  const entries = await listWishlistEntries({
    db,
    shopId,
    customerShopifyId: customerA,
  });

  assert.deepEqual(
    entries.map(({ id }) => id),
    ["a-item"],
  );
  assert.equal("verifiedCustomerShopifyId" in entries[0], false);
});

test("authenticated customer can remove their item and records one event", async () => {
  const db = createDatabase([activeEntry()]);
  const result = await removeWishlistEntry({
    db,
    shopId,
    customerShopifyId: customerA,
    wishlistEntryId: "wishlist-existing",
    now,
  });

  assert.deepEqual(result, { removed: true });
  assert.equal(db.state.entries[0].isActive, false);
  assert.equal(db.state.entries[0].deactivatedAt, now);
  assert.equal(db.state.events.length, 2);
  assert.equal(db.state.events[0].type, "WISHLIST_ENTRY_REMOVED");
  assert.equal(db.state.events[0].wishlistEntryId, "wishlist-existing");
});

test("saving the same active product again does not duplicate the entry or add event", async () => {
  const db = createDatabase([activeEntry()]);
  const result = await saveWishlistEntry({
    db,
    shopId,
    customerShopifyId: customerA,
    productShopifyId: productId,
    preferredVariantShopifyId: variantOne,
    now,
  });

  assert.equal(result.added, false);
  assert.equal(db.state.entries.length, 1);
  assert.equal(db.state.events.length, 1);
  assert.equal(db.state.events[0].type, "WISHLIST_CLICKED");
});

test("saving a different variant updates the existing preferred variant", async () => {
  const db = createDatabase([activeEntry()]);
  const result = await saveWishlistEntry({
    db,
    shopId,
    customerShopifyId: customerA,
    productShopifyId: productId,
    preferredVariantShopifyId: variantTwo,
    now,
  });

  assert.equal(result.entry.id, "wishlist-existing");
  assert.equal(result.entry.preferredVariantShopifyId, variantTwo);
  assert.equal(db.state.entries.length, 1);
  assert.equal(db.state.events.length, 1);
  assert.equal(db.state.events[0].type, "WISHLIST_CLICKED");
});

test("unauthenticated identity is rejected by wishlist reads and writes", async () => {
  const db = createDatabase();
  await assert.rejects(
    listWishlistEntries({ db, shopId, customerShopifyId: null }),
    TypeError,
  );
  await assert.rejects(
    saveWishlistEntry({
      db,
      shopId,
      customerShopifyId: null,
      productShopifyId: productId,
    }),
    TypeError,
  );
  await assert.rejects(
    removeWishlistEntry({
      db,
      shopId,
      customerShopifyId: null,
      wishlistEntryId: "wishlist-existing",
    }),
    TypeError,
  );
});

test("browser customer_id input is rejected instead of trusted", () => {
  assert.equal(
    parseAddWishlistInput({
      productId: productId,
      customer_id: "222",
    }),
    null,
  );
  assert.equal(
    parseAddWishlistInput({
      productId: productId,
      customerId: customerB,
    }),
    null,
  );
  assert.equal(
    parseAddWishlistInput({ productId, email: "buyer@example.com" }),
    null,
  );
  assert.equal(
    parseAddWishlistInput({ productId, phone: "+15551234567" }),
    null,
  );
});

test("customer A cannot read customer B's entry", async () => {
  const db = createDatabase([activeEntry({ id: "b-item", owner: customerB })]);
  const entries = await listWishlistEntries({
    db,
    shopId,
    customerShopifyId: customerA,
  });

  assert.deepEqual(entries, []);
});

test("customer A cannot remove customer B's entry", async () => {
  const db = createDatabase([activeEntry({ id: "b-item", owner: customerB })]);
  const result = await removeWishlistEntry({
    db,
    shopId,
    customerShopifyId: customerA,
    wishlistEntryId: "b-item",
    now,
  });

  assert.deepEqual(result, { removed: false });
  assert.equal(db.state.entries[0].isActive, true);
  assert.equal(db.state.events.length, 0);
});

test("invalid Shopify product ID is rejected", async () => {
  const db = createDatabase();
  await assert.rejects(
    saveWishlistEntry({
      db,
      shopId,
      customerShopifyId: customerA,
      productShopifyId: "gid://shopify/Product/../../other",
    }),
    TypeError,
  );
});

test("Shopify product and variant must belong to the authenticated shop and product", async () => {
  const adminFor = (data) => ({
    async graphql() {
      return {
        ok: true,
        async json() {
          return { data };
        },
      };
    },
  });

  const productValid = await verifyWishlistProduct({
    admin: adminFor({
      shop: {
        id: "gid://shopify/Shop/1",
        myshopifyDomain: "shop.myshopify.com",
      },
      product: { id: productId },
    }),
    shopifyShopId: "gid://shopify/Shop/1",
    shopDomain: "shop.myshopify.com",
    productId,
  });
  const wrongShop = await verifyWishlistProduct({
    admin: adminFor({
      shop: {
        id: "gid://shopify/Shop/2",
        myshopifyDomain: "other.myshopify.com",
      },
      product: { id: productId },
    }),
    shopifyShopId: "gid://shopify/Shop/1",
    shopDomain: "shop.myshopify.com",
    productId,
  });
  const wrongProductVariant = await verifyWishlistVariant({
    admin: adminFor({
      shop: {
        id: "gid://shopify/Shop/1",
        myshopifyDomain: "shop.myshopify.com",
      },
      productVariant: {
        id: variantOne,
        product: { id: "gid://shopify/Product/999" },
      },
    }),
    shopifyShopId: "gid://shopify/Shop/1",
    shopDomain: "shop.myshopify.com",
    productId,
    variantId: variantOne,
  });

  assert.equal(productValid, true);
  assert.equal(wrongShop, false);
  assert.equal(wrongProductVariant, false);
});

test("wishlist_added analytics are emitted only on a new active episode", async () => {
  const db = createDatabase();
  await saveWishlistEntry({
    db,
    shopId,
    customerShopifyId: customerA,
    productShopifyId: productId,
    now,
  });
  await saveWishlistEntry({
    db,
    shopId,
    customerShopifyId: customerA,
    productShopifyId: productId,
    now: new Date(now.getTime() + 1),
  });
  assert.equal(eventsOfType(db, "WISHLIST_ENTRY_CREATED").length, 1);

  await removeWishlistEntry({
    db,
    shopId,
    customerShopifyId: customerA,
    wishlistEntryId: "wishlist-1",
    now,
  });
  await saveWishlistEntry({
    db,
    shopId,
    customerShopifyId: customerA,
    productShopifyId: productId,
    now: new Date(now.getTime() + 2),
  });

  assert.deepEqual(
    db.state.events
      .map(({ type }) => type)
      .filter((type) => type !== "WISHLIST_CLICKED"),
    [
      "WISHLIST_ENTRY_CREATED",
      "WISHLIST_ENTRY_REMOVED",
      "WISHLIST_ENTRY_CREATED",
    ],
  );
});

test("wishlist_removed analytics are emitted only on a real removal", async () => {
  const db = createDatabase([activeEntry()]);
  const first = await removeWishlistEntry({
    db,
    shopId,
    customerShopifyId: customerA,
    wishlistEntryId: "wishlist-existing",
    now,
  });
  const second = await removeWishlistEntry({
    db,
    shopId,
    customerShopifyId: customerA,
    wishlistEntryId: "wishlist-existing",
    now,
  });

  assert.equal(first.removed, true);
  assert.equal(second.removed, false);
  assert.equal(eventsOfType(db, "WISHLIST_ENTRY_REMOVED").length, 1);
  assert.equal(eventsOfType(db, "WISHLIST_CLICKED").length, 1);
  assert.equal(
    eventsOfType(db, "WISHLIST_ENTRY_REMOVED")[0].verifiedCustomerShopifyId,
    customerA,
  );
  assert.equal(
    eventsOfType(db, "WISHLIST_ENTRY_REMOVED")[0].sourceSurface,
    "STOREFRONT",
  );
});

test("removing then adding the same product reactivates one entry with a new episode time", async () => {
  const db = createDatabase([activeEntry()]);
  await removeWishlistEntry({
    db,
    shopId,
    customerShopifyId: customerA,
    wishlistEntryId: "wishlist-existing",
    now,
  });
  const reactivatedAt = new Date(now.getTime() + 60_000);
  const result = await saveWishlistEntry({
    db,
    shopId,
    customerShopifyId: customerA,
    productShopifyId: productId,
    preferredVariantShopifyId: null,
    now: reactivatedAt,
  });

  assert.equal(db.state.entries.length, 1);
  assert.equal(result.added, true);
  assert.equal(result.entry.savedAt, reactivatedAt);
  assert.equal(db.state.entries[0].isActive, true);
  assert.equal(db.state.entries[0].deactivatedAt, null);
});

test("reactivation records a fresh event snapshot and leaves historical identity untouched", async () => {
  const db = createDatabase([activeEntry({ isActive: false })]);
  db.state.events.push({
    type: "WISHLIST_ENTRY_CREATED",
    emailIdentityDigest: "1".repeat(64),
    phoneIdentityDigest: null,
  });
  const historical = { ...db.state.events[0] };

  await saveWishlistEntry({
    db,
    shopId,
    customerShopifyId: customerA,
    productShopifyId: productId,
    emailIdentityDigest: "2".repeat(64),
    phoneIdentityDigest: "3".repeat(64),
    now,
  });

  assert.deepEqual(db.state.events[0], historical);
  assert.equal(db.state.events[1].emailIdentityDigest, "2".repeat(64));
  assert.equal(db.state.events[1].phoneIdentityDigest, "3".repeat(64));
});

test("remove request validation requires exactly one entry ID", () => {
  assert.deepEqual(parseRemoveWishlistInput({ entryId: "entry-1" }), {
    wishlistEntryId: "entry-1",
  });
  assert.equal(
    parseRemoveWishlistInput({ entryId: "entry-1", customer_id: "222" }),
    null,
  );
  assert.equal(parseRemoveWishlistInput({ entryId: "" }), null);
});
