import applicationDb from "../application-db.server.js";

export const DEFAULT_FEATURE_SETTINGS = Object.freeze({
  notifyEnabled: true,
  wishlistEnabled: true,
});

export async function readFeatureSettings(db, shopDomain) {
  const shop = await db.shop.findUnique({
    where: { domain: shopDomain },
    select: { notifyEnabled: true, wishlistEnabled: true },
  });
  return shop ?? DEFAULT_FEATURE_SETTINGS;
}

export async function isFeatureEnabled(db, shopDomain, feature) {
  const settings = await readFeatureSettings(db, shopDomain);
  return feature === "notify" ? settings.notifyEnabled : settings.wishlistEnabled;
}

export function buildSettingsResponse(settings) {
  return {
    features: {
      notify: { enabled: settings.notifyEnabled },
      wishlist: { enabled: settings.wishlistEnabled },
    },
    surfaces: {
      supported: [
        "Product page Notify Me block (Theme Editor)",
        "Product page Wishlist save block (Theme Editor)",
        "My Wishlist app-proxy page for logged-in customers",
      ],
      unsupported: ["Collection cards"],
    },
    channels: {
      email: { supported: true, enabled: true },
      whatsapp: { supported: false, enabled: false, status: "COMING_SOON" },
    },
    copy: {
      managedInThemeEditor: true,
      editableFields: ["Notify block heading", "description", "button label"],
    },
    integration: { status: "UNAVAILABLE", label: "Not configured" },
  };
}

export async function getSettingsResponse(db, shop) {
  const stored = await db.shop.findUnique({
    where: { id: shop.id },
    select: { notifyEnabled: true, wishlistEnabled: true },
  });
  return buildSettingsResponse(stored ?? DEFAULT_FEATURE_SETTINGS);
}

export async function updateFeatureSettings(db, shop, body) {
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).length !== 1 || !body.features ||
    typeof body.features !== "object" || Array.isArray(body.features) ||
    Object.keys(body.features).length === 0 ||
    Object.keys(body.features).some((key) => !["notify", "wishlist"].includes(key))
  ) return null;

  const data = {};
  for (const [key, value] of Object.entries(body.features)) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== 1 || typeof value.enabled !== "boolean") return null;
    data[key === "notify" ? "notifyEnabled" : "wishlistEnabled"] = value.enabled;
  }
  await db.shop.update({ where: { id: shop.id }, data });
  return getSettingsResponse(db, shop);
}

export { applicationDb };
