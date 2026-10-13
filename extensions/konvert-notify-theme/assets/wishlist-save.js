export const PENDING_WISHLIST_KEY = "konvert-wishlist-pending";
export const PENDING_WISHLIST_TTL_MS = 30 * 60 * 1000;
export const WISHLIST_RESUME_PARAM = "konvert_wishlist_resume";
export const WISHLIST_SAVED_PARAM = "konvert_wishlist_saved";
const LOGIN_ATTEMPT_KEY = "konvert-wishlist-login-attempt";
const pendingResumes = new WeakMap();

function validShopifyId(value, type) {
  return (
    typeof value === "string" &&
    (/^[1-9]\d{0,19}$/.test(value) ||
      new RegExp(`^gid://shopify/${type}/[1-9]\\d{0,19}$`).test(value))
  );
}

function canonicalShopifyId(value, type) {
  if (typeof value !== "string") return null;
  return value.startsWith("gid://")
    ? value
    : validShopifyId(value, type)
      ? `gid://shopify/${type}/${value}`
      : null;
}

export function sanitizeReturnLocation(value, origin) {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return null;
  }

  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/")) return null;
    url.searchParams.delete(WISHLIST_RESUME_PARAM);
    url.searchParams.delete(WISHLIST_SAVED_PARAM);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function storePendingWishlist(
  storage,
  { productId, preferredVariantId = null, returnLocation },
  { now = Date.now(), origin },
) {
  if (
    !validShopifyId(productId, "Product") ||
    (preferredVariantId !== null &&
      !validShopifyId(preferredVariantId, "ProductVariant"))
  ) {
    throw new TypeError("Wishlist item is invalid");
  }
  const safeReturnLocation =
    sanitizeReturnLocation(returnLocation, origin) || "/";

  const pending = {
    productId,
    preferredVariantId,
    returnLocation: safeReturnLocation,
    createdAt: now,
    expiresAt: now + PENDING_WISHLIST_TTL_MS,
  };
  storage.setItem(PENDING_WISHLIST_KEY, JSON.stringify(pending));
  return pending;
}

export function readPendingWishlist(storage, { now = Date.now(), origin }) {
  const serialized = storage.getItem(PENDING_WISHLIST_KEY);
  if (serialized === null) return { pending: null, expired: false };

  try {
    const pending = JSON.parse(serialized);
    const expectedKeys = [
      "createdAt",
      "expiresAt",
      "preferredVariantId",
      "productId",
      "returnLocation",
    ];
    const keys = Object.keys(pending).sort();
    const exactShape =
      keys.length === expectedKeys.length &&
      keys.every((key, index) => key === expectedKeys[index]);
    const valid =
      exactShape &&
      validShopifyId(pending.productId, "Product") &&
      (pending.preferredVariantId === null ||
        validShopifyId(pending.preferredVariantId, "ProductVariant")) &&
      Number.isSafeInteger(pending.createdAt) &&
      Number.isSafeInteger(pending.expiresAt) &&
      pending.createdAt <= now &&
      pending.expiresAt === pending.createdAt + PENDING_WISHLIST_TTL_MS &&
      typeof pending.returnLocation === "string";

    if (!valid || now >= pending.expiresAt) {
      storage.removeItem(PENDING_WISHLIST_KEY);
      return { pending: null, expired: valid };
    }
    pending.returnLocation =
      sanitizeReturnLocation(pending.returnLocation, origin) || "/";
    return { pending, expired: false };
  } catch {
    storage.removeItem(PENDING_WISHLIST_KEY);
    return { pending: null, expired: false };
  }
}

export function clearPendingWishlist(storage) {
  storage.removeItem(PENDING_WISHLIST_KEY);
}

export function createWishlistLoginUrl(loginUrl, returnLocation, origin) {
  const safeReturnLocation =
    sanitizeReturnLocation(returnLocation, origin) || "/";

  try {
    const login = new URL(loginUrl, origin);
    const newAccountLogin = login.pathname.endsWith(
      "/customer_authentication/login",
    );
    const legacyAccountLogin = login.pathname.endsWith("/account/login");
    if (login.origin !== origin || (!newAccountLogin && !legacyAccountLogin)) {
      return null;
    }
    const destination = new URL(safeReturnLocation, origin);
    destination.searchParams.set(WISHLIST_RESUME_PARAM, "1");
    const returnParameter =
      newAccountLogin ? "return_to" : "return_url";
    login.searchParams.set(returnParameter, `${destination.pathname}${destination.search}${destination.hash}`);
    return `${login.pathname}${login.search}${login.hash}`;
  } catch {
    return null;
  }
}

export function createSavedLocation(returnLocation, origin) {
  const safeReturnLocation =
    sanitizeReturnLocation(returnLocation, origin) || "/";
  const destination = new URL(safeReturnLocation, origin);
  destination.searchParams.set(WISHLIST_SAVED_PARAM, "1");
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

export function resolveWishlistPreferredVariant({
  explicitVariantId = null,
  selectedVariantId = null,
  allowedVariantIds = [],
}) {
  const allowed = new Set(allowedVariantIds.map(String));
  const candidate = explicitVariantId ?? selectedVariantId;
  return candidate !== null && allowed.has(String(candidate))
    ? String(candidate)
    : null;
}

export function wishlistActionFor({ entry, preferredVariantId }) {
  if (!entry) return "save";
  return canonicalShopifyId(
    entry.preferredVariantShopifyId,
    "ProductVariant",
  ) === canonicalShopifyId(preferredVariantId, "ProductVariant")
    ? "remove"
    : "update";
}

export function wishlistButtonState(state, labels) {
  const states = {
    loading: [labels.loading, true, false, true],
    unsaved: [labels.save, false, false, false],
    saving: [labels.saving, true, false, true],
    saved: [labels.saved, false, true, false],
    removing: [labels.removing, true, true, true],
  };
  const [label, disabled, pressed, busy] = states[state];
  return { label, disabled, pressed, busy, state };
}

export function createWishlistActionLock() {
  let running = false;
  return async function runOnce(action) {
    if (running) return false;
    running = true;
    try {
      await action();
      return true;
    } finally {
      running = false;
    }
  };
}

export function claimWishlistInitialization(root) {
  if (root.dataset.initialized === "true") return false;
  root.dataset.initialized = "true";
  return true;
}

export async function loadWishlistProductEntry({
  fetcher,
  endpoint,
  productId,
}) {
  const response = await fetcher(endpoint, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) return { status: "unauthenticated", entry: null };
  if (!response.ok) return { status: "error", entry: null };

  const result = await response.json();
  if (!Array.isArray(result?.entries)) return { status: "error", entry: null };
  return {
    status: "loaded",
    entry:
      result.entries.find(
        (entry) =>
          canonicalShopifyId(entry.productShopifyId, "Product") ===
          canonicalShopifyId(productId, "Product"),
      ) ??
      null,
  };
}

async function postWishlistItem({ fetcher, endpoint, pending }) {
  return fetcher(endpoint, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      productId: pending.productId,
      preferredVariantId: pending.preferredVariantId,
    }),
  });
}

export async function saveWishlistClick({
  storage,
  fetcher,
  endpoint,
  productId,
  preferredVariantId = null,
  returnLocation,
  origin,
  now = Date.now(),
}) {
  const pending = {
    productId,
    preferredVariantId,
    returnLocation,
  };
  const authResponse = await fetcher(endpoint, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });

  if (authResponse.status === 401) {
    storePendingWishlist(storage, pending, { now, origin });
    return { status: "login_required" };
  }
  if (!authResponse.ok) return { status: "error" };

  const response = await postWishlistItem({ fetcher, endpoint, pending });
  if (!response.ok) {
    if (response.status === 401) {
      storePendingWishlist(storage, pending, { now, origin });
      return { status: "login_required" };
    }
    return { status: "error" };
  }
  const result = await response.json();
  if (!result?.entry || typeof result.added !== "boolean") {
    return { status: "error" };
  }
  clearPendingWishlist(storage);
  return { status: "saved", added: result.added, entry: result.entry };
}

export async function removeWishlistProduct({
  fetcher,
  endpoint,
  entryId,
}) {
  const response = await fetcher(endpoint, {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryId }),
  });
  if (!response.ok) return { status: "error" };
  const result = await response.json();
  return result?.removed === true
    ? { status: "removed" }
    : { status: "error" };
}

async function performPendingWishlistResume({
  storage,
  fetcher,
  endpoint,
  origin,
  now = Date.now(),
}) {
  const { pending, expired } = readPendingWishlist(storage, { now, origin });
  if (!pending) return { status: expired ? "expired" : "none" };

  const authResponse = await fetcher(endpoint, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!authResponse.ok) {
    clearPendingWishlist(storage);
    return { status: authResponse.status === 401 ? "unauthenticated" : "error" };
  }

  const response = await postWishlistItem({ fetcher, endpoint, pending });
  if (!response.ok) {
    clearPendingWishlist(storage);
    return { status: response.status === 401 ? "unauthenticated" : "error" };
  }
  const result = await response.json();
  if (!result?.entry || typeof result.added !== "boolean") {
    clearPendingWishlist(storage);
    return { status: "error" };
  }

  clearPendingWishlist(storage);
  return {
    status: "saved",
    added: result.added,
    returnLocation: createSavedLocation(pending.returnLocation, origin),
  };
}

export function resumePendingWishlist(options) {
  const inProgress = pendingResumes.get(options.storage);
  if (inProgress) return inProgress;

  const operation = performPendingWishlistResume(options);
  pendingResumes.set(options.storage, operation);
  return operation.finally(() => {
    if (pendingResumes.get(options.storage) === operation) {
      pendingResumes.delete(options.storage);
    }
  });
}

function currentReturnLocation() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function setStatus(root, state, message) {
  const status = root.querySelector("[data-status]");
  status.dataset.state = state;
  status.textContent = message;
}

function setWishlistButton(root, state) {
  const button = root.querySelector("[data-save]");
  const viewState = wishlistButtonState(state, {
    loading: root.dataset.loadingLabel,
    save: root.dataset.saveLabel,
    saving: root.dataset.savingLabel,
    saved: root.dataset.savedLabel,
    removing: root.dataset.removingLabel,
  });
  button.textContent = viewState.label;
  button.disabled = viewState.disabled;
  button.dataset.state = viewState.state;
  button.setAttribute("aria-pressed", String(viewState.pressed));
  button.setAttribute("aria-busy", String(viewState.busy));
}

function initialize(root) {
  if (!claimWishlistInitialization(root)) return;

  const button = root.querySelector("[data-save]");
  const dialog = root.querySelector("[data-dialog]");
  const continueButton = root.querySelector("[data-continue]");
  const cancelButton = root.querySelector("[data-cancel]");
  const endpoint = root.dataset.endpoint;
  let variantIds = new Set();
  try {
    variantIds = new Set(JSON.parse(root.dataset.variantIds).map(String));
  } catch {
    setStatus(root, "error", root.dataset.errorMessage);
  }
  const initialVariantId = root.dataset.initialVariantId || null;
  let savedEntry = null;
  const runActionOnce = createWishlistActionLock();

  function currentVariantId() {
    const selector =
      'form[action*="/cart/add"] [name="id"], [data-product-form] [name="id"]';
    const section = root.closest(".shopify-section");
    const scopes = section ? [section, document] : [document];
    for (const scope of scopes) {
      for (const input of scope.querySelectorAll(selector)) {
        const selected = resolveWishlistPreferredVariant({
          selectedVariantId: String(input.value),
          allowedVariantIds: [...variantIds],
        });
        if (selected) return selected;
      }
    }
    const queryVariant = new URLSearchParams(window.location.search).get(
      "variant",
    );
    return resolveWishlistPreferredVariant({
      selectedVariantId: queryVariant || initialVariantId,
      allowedVariantIds: [...variantIds],
    });
  }

  function applyLoadedState(result) {
    if (result.status === "loaded") {
      savedEntry = result.entry;
      setWishlistButton(root, savedEntry ? "saved" : "unsaved");
      return;
    }
    savedEntry = null;
    setWishlistButton(root, "unsaved");
  }

  async function loadState() {
    setWishlistButton(root, "loading");
    try {
      const result = await loadWishlistProductEntry({
        fetcher: window.fetch.bind(window),
        endpoint,
        productId: root.dataset.productId,
      });
      applyLoadedState(result);
      if (result.status === "error") {
        setStatus(root, "error", root.dataset.errorMessage);
      }
    } catch {
      applyLoadedState({ status: "unauthenticated" });
      setStatus(root, "error", root.dataset.errorMessage);
    }
  }

  button.addEventListener("click", async () => {
    await runActionOnce(async () => {
      const previousEntry = savedEntry;
      const preferredVariantId = currentVariantId();
      const action = wishlistActionFor({
        entry: previousEntry,
        preferredVariantId,
      });
      setWishlistButton(
        root,
        action === "remove" ? "removing" : "saving",
      );
      setStatus(root, "loading", "");

      try {
        const result =
          action === "remove"
            ? await removeWishlistProduct({
                fetcher: window.fetch.bind(window),
                endpoint,
                entryId: previousEntry.id,
              })
            : await saveWishlistClick({
                storage: window.localStorage,
                fetcher: window.fetch.bind(window),
                endpoint,
                productId: root.dataset.productId,
                preferredVariantId,
                returnLocation: currentReturnLocation(),
                origin: window.location.origin,
              });
        if (result.status === "login_required") {
          setWishlistButton(root, "unsaved");
          setStatus(root, "login", root.dataset.requiredMessage);
          dialog.showModal();
        } else if (result.status === "saved") {
          savedEntry = result.entry;
          setWishlistButton(root, "saved");
          setStatus(root, "success", root.dataset.successMessage);
        } else if (result.status === "removed") {
          savedEntry = null;
          setWishlistButton(root, "unsaved");
          setStatus(root, "success", root.dataset.removedMessage);
        } else {
          savedEntry = previousEntry;
          setWishlistButton(root, previousEntry ? "saved" : "unsaved");
          setStatus(root, "error", root.dataset.errorMessage);
        }
      } catch {
        savedEntry = previousEntry;
        setWishlistButton(root, previousEntry ? "saved" : "unsaved");
        setStatus(root, "error", root.dataset.errorMessage);
      }
    });
  });

  void loadState();

  continueButton.addEventListener("click", () => {
    if (root.dataset.loginEnabled !== "true") {
      setStatus(root, "error", root.dataset.loginUnavailable);
      return;
    }
    const loginUrl = createWishlistLoginUrl(
      root.dataset.loginUrl,
      currentReturnLocation(),
      window.location.origin,
    );
    if (!loginUrl) {
      clearPendingWishlist(window.localStorage);
      dialog.close();
      setStatus(root, "error", root.dataset.errorMessage);
      return;
    }
    window.sessionStorage.setItem(LOGIN_ATTEMPT_KEY, "1");
    window.location.assign(loginUrl);
  });

  cancelButton.addEventListener("click", () => {
    clearPendingWishlist(window.localStorage);
    dialog.close();
  });
  dialog.addEventListener("cancel", () => {
    clearPendingWishlist(window.localStorage);
  });

  const query = new URLSearchParams(window.location.search);
  if (query.get(WISHLIST_SAVED_PARAM) === "1") {
    setWishlistButton(root, "saved");
    setStatus(root, "success", root.dataset.successMessage);
    query.delete(WISHLIST_SAVED_PARAM);
    const queryString = query.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${queryString ? `?${queryString}` : ""}${window.location.hash}`,
    );
  }

  let resumeInProgress = false;
  const resume = () => {
    if (resumeInProgress) return;
    resumeInProgress = true;
    resumePendingWishlist({
      storage: window.localStorage,
      fetcher: window.fetch.bind(window),
      endpoint,
      origin: window.location.origin,
    })
      .then((result) => {
        window.sessionStorage.removeItem(LOGIN_ATTEMPT_KEY);
        if (result.status === "saved" && result.returnLocation) {
          window.location.replace(result.returnLocation);
        } else if (result.status === "unauthenticated") {
          setStatus(root, "error", root.dataset.failureMessage);
        } else if (result.status === "expired") {
          setStatus(root, "error", root.dataset.expiredMessage);
        } else if (result.status === "error") {
          setStatus(root, "error", root.dataset.errorMessage);
        }
      })
      .catch(() => {
        window.sessionStorage.removeItem(LOGIN_ATTEMPT_KEY);
        clearPendingWishlist(window.localStorage);
        setStatus(root, "error", root.dataset.errorMessage);
      })
      .finally(() => {
        resumeInProgress = false;
      });
  };

  if (
    query.get(WISHLIST_RESUME_PARAM) === "1" ||
    window.sessionStorage.getItem(LOGIN_ATTEMPT_KEY) === "1"
  ) {
    query.delete(WISHLIST_RESUME_PARAM);
    const queryString = query.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${queryString ? `?${queryString}` : ""}${window.location.hash}`,
    );
    resume();
  }

  window.addEventListener("pageshow", (event) => {
    if (
      event.persisted &&
      window.sessionStorage.getItem(LOGIN_ATTEMPT_KEY) === "1"
    ) {
      resume();
    }
  });

}

function mount(root) {
  window.KonvertFeatureSettings?.mount(root, "wishlist", initialize);
}

if (typeof document !== "undefined") {
  document.querySelectorAll("[data-konvert-wishlist]").forEach(mount);
  document.addEventListener("shopify:section:load", (event) => {
    event.target
      .querySelectorAll?.("[data-konvert-wishlist]")
      .forEach(mount);
  });
  new MutationObserver((records) => {
    records.forEach((record) =>
      record.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        if (node.matches("[data-konvert-wishlist]")) mount(node);
        node
          .querySelectorAll("[data-konvert-wishlist]")
          .forEach(mount);
      }),
    );
  }).observe(document.documentElement, { childList: true, subtree: true });
}
