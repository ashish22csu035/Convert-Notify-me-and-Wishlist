import assert from "node:assert/strict";
import test from "node:test";
import {
  PENDING_WISHLIST_KEY,
  PENDING_WISHLIST_TTL_MS,
  clearPendingWishlist,
  claimWishlistInitialization,
  createWishlistActionLock,
  createWishlistLoginUrl,
  loadWishlistProductEntry,
  readPendingWishlist,
  removeWishlistProduct,
  resolveWishlistPreferredVariant,
  resumePendingWishlist,
  sanitizeReturnLocation,
  saveWishlistClick,
  storePendingWishlist,
  wishlistActionFor,
  wishlistButtonState,
} from "../../../extensions/konvert-notify-theme/assets/wishlist-save.js";

const origin = "https://shop.example";
const item = {
  productId: "gid://shopify/Product/101",
  preferredVariantId: "gid://shopify/ProductVariant/202",
  returnLocation: "/products/coat?color=blue",
};

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function response(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

test("guest save stores one pending item and does not POST before login", async () => {
  const storage = memoryStorage();
  const calls = [];
  const result = await saveWishlistClick({
    storage,
    endpoint: "/apps/konvert-notify/wishlist",
    fetcher: async (...args) => {
      calls.push(args);
      return response(401);
    },
    ...item,
    origin,
    now: 100,
  });

  assert.equal(result.status, "login_required");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].method, "GET");
  assert.equal(
    JSON.parse(storage.getItem(PENDING_WISHLIST_KEY)).productId,
    item.productId,
  );
});

test("pending data includes preferred variant and original return location only", () => {
  const storage = memoryStorage();
  const pending = storePendingWishlist(storage, item, { now: 100, origin });
  assert.deepEqual(Object.keys(pending).sort(), [
    "createdAt",
    "expiresAt",
    "preferredVariantId",
    "productId",
    "returnLocation",
  ]);
  assert.equal(pending.preferredVariantId, item.preferredVariantId);
  assert.equal(pending.returnLocation, item.returnLocation);
  assert.equal(pending.expiresAt - pending.createdAt, PENDING_WISHLIST_TTL_MS);
});

test("pending item without a selected variant is supported", () => {
  const storage = memoryStorage();
  storePendingWishlist(
    storage,
    { ...item, preferredVariantId: null },
    { now: 100, origin },
  );
  assert.equal(
    readPendingWishlist(storage, { now: 101, origin }).pending
      .preferredVariantId,
    null,
  );
});

test("expired pending state is cleared and ignored", () => {
  const storage = memoryStorage();
  storePendingWishlist(storage, item, { now: 100, origin });
  const result = readPendingWishlist(storage, {
    now: 100 + PENDING_WISHLIST_TTL_MS,
    origin,
  });
  assert.deepEqual(result, { pending: null, expired: true });
  assert.equal(storage.getItem(PENDING_WISHLIST_KEY), null);
});

test("a newly selected guest item replaces the previous pending item", () => {
  const storage = memoryStorage();
  storePendingWishlist(storage, item, { now: 100, origin });
  storePendingWishlist(
    storage,
    { ...item, productId: "gid://shopify/Product/303" },
    { now: 200, origin },
  );
  const { pending } = readPendingWishlist(storage, { now: 201, origin });
  assert.equal(pending.productId, "gid://shopify/Product/303");
});

test("authenticated save posts only the product and optional variant", async () => {
  const storage = memoryStorage();
  const calls = [];
  const result = await saveWishlistClick({
    storage,
    endpoint: "/wishlist",
    fetcher: async (url, options) => {
      calls.push(options);
      return options.method === "GET"
        ? response(200, { entries: [] })
        : response(201, { entry: { id: "entry-1" }, added: true });
    },
    ...item,
    origin,
    now: 100,
  });
  assert.deepEqual(result, {
    status: "saved",
    added: true,
    entry: { id: "entry-1" },
  });
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1].body), {
    productId: item.productId,
    preferredVariantId: item.preferredVariantId,
  });
  assert.equal(calls[1].body.includes("customer_id"), false);
  assert.equal(storage.getItem(PENDING_WISHLIST_KEY), null);
});

test("authenticated save without a preferred variant omits no identity data", async () => {
  const calls = [];
  await saveWishlistClick({
    storage: memoryStorage(),
    endpoint: "/wishlist",
    fetcher: async (_url, options) => {
      calls.push(options);
      return options.method === "GET"
        ? response(200)
        : response(200, { entry: { id: "entry-1" }, added: false });
    },
    productId: "gid://shopify/Product/101",
    returnLocation: "/products/coat",
    origin,
  });
  assert.deepEqual(JSON.parse(calls[1].body), {
    productId: "gid://shopify/Product/101",
    preferredVariantId: null,
  });
});

test("login resume verifies authentication before saving and clears state", async () => {
  const storage = memoryStorage();
  storePendingWishlist(storage, item, { now: 100, origin });
  const methods = [];
  const result = await resumePendingWishlist({
    storage,
    endpoint: "/wishlist",
    origin,
    now: 101,
    fetcher: async (_url, options) => {
      methods.push(options.method);
      return options.method === "GET"
        ? response(200, { entries: [] })
        : response(201, { entry: { id: "entry-1" }, added: true });
    },
  });

  assert.deepEqual(methods, ["GET", "POST"]);
  assert.equal(result.status, "saved");
  assert.equal(result.returnLocation, "/products/coat?color=blue&konvert_wishlist_saved=1");
  assert.equal(storage.getItem(PENDING_WISHLIST_KEY), null);
});

test("repeated resume cannot POST again after successful state is cleared", async () => {
  const storage = memoryStorage();
  storePendingWishlist(storage, item, { now: 100, origin });
  let postCount = 0;
  const options = {
    storage,
    endpoint: "/wishlist",
    origin,
    now: 101,
    fetcher: async (_url, request) => {
      if (request.method === "POST") postCount += 1;
      return request.method === "GET"
        ? response(200)
        : response(200, { entry: { id: "entry-1" }, added: false });
    },
  };
  assert.equal((await resumePendingWishlist(options)).status, "saved");
  assert.equal((await resumePendingWishlist(options)).status, "none");
  assert.equal(postCount, 1);
});

test("simultaneous resume handlers share one server save", async () => {
  const storage = memoryStorage();
  storePendingWishlist(storage, item, { now: 100, origin });
  let postCount = 0;
  const options = {
    storage,
    endpoint: "/wishlist",
    origin,
    now: 101,
    fetcher: async (_url, request) => {
      if (request.method === "POST") {
        postCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return response(201, { entry: { id: "entry-1" }, added: true });
      }
      return response(200);
    },
  };
  const results = await Promise.all([
    resumePendingWishlist(options),
    resumePendingWishlist(options),
  ]);
  assert.equal(postCount, 1);
  assert.deepEqual(
    results.map(({ status }) => status),
    ["saved", "saved"],
  );
});

test("saved state is loaded from the authenticated server response", async () => {
  const result = await loadWishlistProductEntry({
    endpoint: "/wishlist",
    productId: "101",
    fetcher: async () =>
      response(200, {
        entries: [
          {
            id: "entry-1",
            productShopifyId: item.productId,
            preferredVariantShopifyId: item.preferredVariantId,
          },
        ],
      }),
  });
  assert.equal(result.status, "loaded");
  assert.equal(result.entry.id, "entry-1");
});

test("missing product in authenticated response produces unsaved state", async () => {
  const result = await loadWishlistProductEntry({
    endpoint: "/wishlist",
    productId: item.productId,
    fetcher: async () => response(200, { entries: [] }),
  });
  assert.deepEqual(result, { status: "loaded", entry: null });
});

test("guest saved-state lookup returns unauthenticated without private data", async () => {
  const result = await loadWishlistProductEntry({
    endpoint: "/wishlist",
    productId: item.productId,
    fetcher: async () => response(401),
  });
  assert.deepEqual(result, { status: "unauthenticated", entry: null });
});

test("removal calls the existing authenticated wishlist API", async () => {
  let request;
  const result = await removeWishlistProduct({
    endpoint: "/wishlist",
    entryId: "entry-1",
    fetcher: async (_url, options) => {
      request = options;
      return response(200, { removed: true });
    },
  });
  assert.deepEqual(result, { status: "removed" });
  assert.equal(request.method, "DELETE");
  assert.deepEqual(JSON.parse(request.body), { entryId: "entry-1" });
});

test("selected variant is sent exactly and no selection stays null", () => {
  assert.equal(
    resolveWishlistPreferredVariant({
      selectedVariantId: item.preferredVariantId,
      allowedVariantIds: [item.preferredVariantId],
    }),
    item.preferredVariantId,
  );
  assert.equal(
    resolveWishlistPreferredVariant({
      allowedVariantIds: [item.preferredVariantId],
    }),
    null,
  );
});

test("an explicit card variant is preferred only when it belongs to the product", () => {
  assert.equal(
    resolveWishlistPreferredVariant({
      explicitVariantId: "gid://shopify/ProductVariant/303",
      selectedVariantId: item.preferredVariantId,
      allowedVariantIds: [
        item.preferredVariantId,
        "gid://shopify/ProductVariant/303",
      ],
    }),
    "gid://shopify/ProductVariant/303",
  );
  assert.equal(
    resolveWishlistPreferredVariant({
      explicitVariantId: "gid://shopify/ProductVariant/999",
      allowedVariantIds: [item.preferredVariantId],
    }),
    null,
  );
});

test("changing selected variant updates the existing product preference", () => {
  assert.equal(
    wishlistActionFor({
      entry: {
        preferredVariantShopifyId: item.preferredVariantId,
      },
      preferredVariantId: "gid://shopify/ProductVariant/303",
    }),
    "update",
  );
  assert.equal(
    wishlistActionFor({
      entry: {
        preferredVariantShopifyId: item.preferredVariantId,
      },
      preferredVariantId: "202",
    }),
    "remove",
  );
  assert.equal(
    wishlistActionFor({
      entry: { preferredVariantShopifyId: item.preferredVariantId },
      preferredVariantId: null,
    }),
    "update",
  );
});

test("button states expose checking, saving, saved, removing, and retryable unsaved state", () => {
  const labels = {
    loading: "Checking",
    save: "Save",
    saving: "Saving",
    saved: "Saved",
    removing: "Removing",
  };
  assert.deepEqual(wishlistButtonState("loading", labels), {
    label: "Checking",
    disabled: true,
    pressed: false,
    busy: true,
    state: "loading",
  });
  assert.deepEqual(wishlistButtonState("unsaved", labels), {
    label: "Save",
    disabled: false,
    pressed: false,
    busy: false,
    state: "unsaved",
  });
  assert.equal(wishlistButtonState("saving", labels).disabled, true);
  assert.equal(wishlistButtonState("saved", labels).pressed, true);
  assert.equal(wishlistButtonState("removing", labels).pressed, true);
  assert.equal(wishlistButtonState("removing", labels).busy, true);
});

test("rapid clicks run only one concurrent wishlist action", async () => {
  const runOnce = createWishlistActionLock();
  let calls = 0;
  let release;
  const action = () =>
    runOnce(async () => {
      calls += 1;
      await new Promise((resolve) => {
        release = resolve;
      });
    });
  const first = action();
  const second = await action();
  assert.equal(second, false);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, true);
});

test("re-rendering the same collection node cannot claim initialization twice", () => {
  const root = { dataset: {} };
  assert.equal(claimWishlistInitialization(root), true);
  assert.equal(claimWishlistInitialization(root), false);
});

test("failed save and remove leave their server-confirmed state unchanged", async () => {
  const storage = memoryStorage();
  const failedSave = await saveWishlistClick({
    storage,
    endpoint: "/wishlist",
    fetcher: async (_url, request) =>
      request.method === "GET"
        ? response(200)
        : response(500),
    ...item,
    origin,
  });
  const failedRemove = await removeWishlistProduct({
    endpoint: "/wishlist",
    entryId: "entry-1",
    fetcher: async () => response(500),
  });
  assert.deepEqual(failedSave, { status: "error" });
  assert.deepEqual(failedRemove, { status: "error" });
  assert.equal(wishlistButtonState("unsaved", {
    loading: "Checking",
    save: "Save",
    saving: "Saving",
    saved: "Saved",
    removing: "Removing",
  }).pressed, false);
  assert.equal(wishlistButtonState("saved", {
    loading: "Checking",
    save: "Save",
    saving: "Saving",
    saved: "Saved",
    removing: "Removing",
  }).pressed, true);
});

test("unauthenticated resume clears state and never POSTs", async () => {
  const storage = memoryStorage();
  storePendingWishlist(storage, item, { now: 100, origin });
  let postCount = 0;
  const result = await resumePendingWishlist({
    storage,
    endpoint: "/wishlist",
    origin,
    now: 101,
    fetcher: async (_url, request) => {
      if (request.method === "POST") postCount += 1;
      return response(401);
    },
  });
  assert.equal(result.status, "unauthenticated");
  assert.equal(postCount, 0);
  assert.equal(storage.getItem(PENDING_WISHLIST_KEY), null);
});

test("failed login save clears pending state without reporting success", async () => {
  const storage = memoryStorage();
  storePendingWishlist(storage, item, { now: 100, origin });
  const result = await resumePendingWishlist({
    storage,
    endpoint: "/wishlist",
    origin,
    now: 101,
    fetcher: async (_url, request) =>
      request.method === "GET" ? response(200) : response(500),
  });
  assert.equal(result.status, "error");
  assert.equal(storage.getItem(PENDING_WISHLIST_KEY), null);
});

test("expired item cannot resume or create an entry", async () => {
  const storage = memoryStorage();
  storePendingWishlist(storage, item, { now: 100, origin });
  let calls = 0;
  const result = await resumePendingWishlist({
    storage,
    endpoint: "/wishlist",
    origin,
    now: 100 + PENDING_WISHLIST_TTL_MS,
    fetcher: async () => {
      calls += 1;
      return response(200);
    },
  });
  assert.equal(result.status, "expired");
  assert.equal(calls, 0);
});

test("cancel clears the pending item", () => {
  const storage = memoryStorage();
  storePendingWishlist(storage, item, { now: 100, origin });
  clearPendingWishlist(storage);
  assert.equal(storage.getItem(PENDING_WISHLIST_KEY), null);
});

test("client-supplied customer identity is never stored or posted", async () => {
  const storage = memoryStorage();
  storePendingWishlist(
    storage,
    { ...item, customer_id: "gid://shopify/Customer/999" },
    { now: 100, origin },
  );
  assert.equal(
    Object.hasOwn(
      JSON.parse(storage.getItem(PENDING_WISHLIST_KEY)),
      "customer_id",
    ),
    false,
  );
});

test("external return locations are rejected", () => {
  assert.equal(
    sanitizeReturnLocation("https://attacker.example/steal", origin),
    null,
  );
  assert.equal(sanitizeReturnLocation("//attacker.example/steal", origin), null);
  assert.equal(
    sanitizeReturnLocation("/products/coat", origin),
    "/products/coat",
  );
  const storage = memoryStorage();
  const pending = storePendingWishlist(
    storage,
    { ...item, returnLocation: "https://attacker.example/steal" },
    { now: 100, origin },
  );
  assert.equal(pending.returnLocation, "/");
});

test("login URL uses the Shopify route and a safe relative return target", () => {
  assert.equal(
    createWishlistLoginUrl(
      "/customer_authentication/login",
      "/products/coat?color=blue",
      origin,
    ),
    "/customer_authentication/login?return_to=%2Fproducts%2Fcoat%3Fcolor%3Dblue%26konvert_wishlist_resume%3D1",
  );
  assert.equal(
    createWishlistLoginUrl("https://attacker.example/login", "/products/coat", origin),
    null,
  );
  assert.equal(
    createWishlistLoginUrl(
      "/account/login",
      "https://attacker.example/steal",
      origin,
    ),
    "/account/login?return_url=%2F%3Fkonvert_wishlist_resume%3D1",
  );
});

test("server-confirmed duplicate save remains success without a second add event", async () => {
  const result = await saveWishlistClick({
    storage: memoryStorage(),
    endpoint: "/wishlist",
    fetcher: async (_url, options) =>
      options.method === "GET"
        ? response(200)
        : response(200, { entry: { id: "entry-1" }, added: false }),
    ...item,
    origin,
  });
  assert.deepEqual(result, {
    status: "saved",
    added: false,
    entry: { id: "entry-1" },
  });
});
