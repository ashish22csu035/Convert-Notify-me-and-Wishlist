import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAddToCartForm,
  buildNotifyMeUrl,
  classifyWishlistEntry,
  loadWishlistPageEntries,
} from "./page-data.server.js";

const productId = "gid://shopify/Product/123";
const variantId = "gid://shopify/ProductVariant/456";
const entry = {
  id: "entry-1",
  productShopifyId: productId,
  preferredVariantShopifyId: variantId,
  savedAt: new Date("2026-01-01T00:00:00.000Z"),
};
const product = {
  id: productId,
  title: "Everyday Coat",
  handle: "everyday-coat",
  status: "ACTIVE",
  onlineStoreUrl: "https://shop.example/products/everyday-coat",
  featuredMedia: {
    image: {
      url: "https://cdn.shopify.com/files/coat.jpg",
      altText: "Blue coat",
    },
  },
  priceRangeV2: {
    minVariantPrice: { amount: "79.00", currencyCode: "USD" },
  },
};

function variant(overrides = {}) {
  return {
    id: variantId,
    title: "Blue / Medium",
    availableForSale: true,
    product: { id: productId },
    ...overrides,
  };
}

function adminFor(nodes) {
  return {
    graphql: async (_query, { variables }) => ({
      ok: true,
      json: async () => ({
        data: {
          shop: {
            id: "gid://shopify/Shop/1",
            myshopifyDomain: "shop.example.myshopify.com",
          },
          nodes: variables.ids.map((id) => nodes[id] ?? null),
        },
      }),
    }),
  };
}

test("authenticated request maps only the supplied customer's active entries", async () => {
  const mapped = await loadWishlistPageEntries({
    admin: adminFor({ [productId]: product, [variantId]: variant() }),
    shopifyShopId: "gid://shopify/Shop/1",
    shopDomain: "shop.example.myshopify.com",
    entries: [entry],
  });
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].id, entry.id);
  assert.equal(Object.hasOwn(mapped[0], "customerShopifyId"), false);
});

test("deleted products remain removable and cannot be purchased", () => {
  const item = classifyWishlistEntry(entry, null, null);
  assert.equal(item.productState, "unavailable");
  assert.equal(item.product, null);
  assert.equal(item.canAddToCart, false);
  assert.equal(item.canNotify, false);
  assert.equal(item.id, entry.id);
});

test("draft or unpublished products cannot be linked or purchased", () => {
  const item = classifyWishlistEntry(
    entry,
    { ...product, status: "DRAFT" },
    variant(),
  );
  assert.equal(item.productState, "unavailable");
  assert.equal(item.product.url, null);
  assert.equal(item.canAddToCart, false);
  assert.equal(item.canNotify, false);
});

test("purchasable saved variant uses its exact Shopify variant ID", () => {
  const item = classifyWishlistEntry(entry, product, variant());
  assert.equal(item.variantState, "available");
  assert.equal(item.canAddToCart, true);
  assert.deepEqual(buildAddToCartForm(item), {
    action: "/cart/add",
    method: "post",
    variantId: "456",
  });
  assert.equal(buildNotifyMeUrl(item), null);
});

test("active product without an online store URL can add its available saved variant", () => {
  const item = classifyWishlistEntry(
    entry,
    { ...product, onlineStoreUrl: null },
    variant(),
  );
  assert.equal(item.productState, "available");
  assert.equal(item.variantState, "available");
  assert.equal(item.canAddToCart, true);
  assert.equal(item.canNotify, false);
  assert.deepEqual(buildAddToCartForm(item), {
    action: "/cart/add",
    method: "post",
    variantId: "456",
  });
});

test("unavailable saved variant offers explicit Notify Me for the exact variant", () => {
  const item = classifyWishlistEntry(
    entry,
    product,
    variant({ availableForSale: false }),
  );
  assert.equal(item.variantState, "unavailable");
  assert.equal(item.canNotify, true);
  assert.equal(item.canAddToCart, false);
  assert.equal(
    buildNotifyMeUrl(item),
    "/products/everyday-coat?variant=456",
  );
});

test("active product without an online store URL notifies for its unavailable saved variant", () => {
  const item = classifyWishlistEntry(
    entry,
    { ...product, onlineStoreUrl: null },
    variant({ availableForSale: false }),
  );
  assert.equal(item.productState, "available");
  assert.equal(item.variantState, "unavailable");
  assert.equal(item.canAddToCart, false);
  assert.equal(item.canNotify, true);
  assert.equal(buildNotifyMeUrl(item), "/products/everyday-coat?variant=456");
});

test("invalid or mismatched saved variant cannot be purchased or notified", () => {
  const item = classifyWishlistEntry(
    entry,
    product,
    variant({ product: { id: "gid://shopify/Product/999" } }),
  );
  assert.equal(item.variantState, "invalid");
  assert.equal(item.canAddToCart, false);
  assert.equal(item.canNotify, false);
  assert.equal(item.canChooseOptions, true);
  assert.equal(buildAddToCartForm(item), null);
  assert.equal(buildNotifyMeUrl(item), null);
});

test("entry without preferred variant does not silently select one", () => {
  const itemWithoutVariant = {
    ...entry,
    preferredVariantShopifyId: null,
  };
  const mapped = classifyWishlistEntry(itemWithoutVariant, product, null);
  assert.equal(mapped.variant, null);
  assert.equal(mapped.variantState, "none");
  assert.equal(mapped.canAddToCart, false);
  assert.equal(mapped.canChooseOptions, true);
  assert.equal(buildAddToCartForm(mapped), null);
});

test("unavailable saved variant never changes the Wishlist entry or Notify state", () => {
  const item = classifyWishlistEntry(
    entry,
    product,
    variant({ availableForSale: false }),
  );
  assert.equal(item.id, entry.id);
  assert.equal(item.canNotify, true);
  assert.equal(item.canAddToCart, false);
  assert.equal(item.productState, "available");
});

test("missing variant node is marked invalid and item remains removable", () => {
  const item = classifyWishlistEntry(entry, product, null);
  assert.equal(item.id, entry.id);
  assert.equal(item.variantState, "invalid");
  assert.equal(item.canAddToCart, false);
  assert.equal(item.canNotify, false);
  assert.equal(item.canChooseOptions, true);
  assert.equal(buildAddToCartForm(item), null);
  assert.equal(buildNotifyMeUrl(item), null);
});

test("other variants never replace the saved variant for cart or Notify Me", async () => {
  const alternateVariantId = "gid://shopify/ProductVariant/789";
  const alternateVariant = variant({
    id: alternateVariantId,
    title: "Red / Large",
    availableForSale: true,
  });
  const savedVariantUnavailable = variant({ availableForSale: false });
  const [notifyEntry] = await loadWishlistPageEntries({
    admin: adminFor({
      [productId]: { ...product, onlineStoreUrl: null },
      [variantId]: savedVariantUnavailable,
      [alternateVariantId]: alternateVariant,
    }),
    shopifyShopId: "gid://shopify/Shop/1",
    shopDomain: "shop.example.myshopify.com",
    entries: [entry],
  });
  assert.equal(notifyEntry.variant.id, variantId);
  assert.equal(notifyEntry.canAddToCart, false);
  assert.equal(notifyEntry.canNotify, true);
  assert.equal(buildNotifyMeUrl(notifyEntry), "/products/everyday-coat?variant=456");

  const savedVariantAvailable = variant();
  const [cartEntry] = await loadWishlistPageEntries({
    admin: adminFor({
      [productId]: { ...product, onlineStoreUrl: null },
      [variantId]: savedVariantAvailable,
      [alternateVariantId]: variant({
        id: alternateVariantId,
        title: "Red / Large",
        availableForSale: false,
      }),
    }),
    shopifyShopId: "gid://shopify/Shop/1",
    shopDomain: "shop.example.myshopify.com",
    entries: [entry],
  });
  assert.equal(cartEntry.variant.id, variantId);
  assert.equal(cartEntry.canAddToCart, true);
  assert.deepEqual(buildAddToCartForm(cartEntry), {
    action: "/cart/add",
    method: "post",
    variantId: "456",
  });
});

test("product link is built from a path-safe Shopify handle", () => {
  const item = classifyWishlistEntry(
    entry,
    { ...product, handle: "coat blue" },
    variant(),
  );
  assert.equal(item.product.url, "/products/coat%20blue");
});

test("wrong shop response fails closed", async () => {
  const admin = {
    graphql: async () => ({
      ok: true,
      json: async () => ({
        data: {
          shop: {
            id: "gid://shopify/Shop/2",
            myshopifyDomain: "other.example.myshopify.com",
          },
          nodes: [],
        },
      }),
    }),
  };
  await assert.rejects(
    loadWishlistPageEntries({
      admin,
      shopifyShopId: "gid://shopify/Shop/1",
      shopDomain: "shop.example.myshopify.com",
      entries: [entry],
    }),
    /could not be verified/,
  );
});
