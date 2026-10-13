import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSettingsResponse,
  getSettingsResponse,
  isFeatureEnabled,
  readFeatureSettings,
  updateFeatureSettings,
} from "./settings.server.js";

function database() {
  const rows = new Map([
    ["a.myshopify.com", { id: "shop-a", notifyEnabled: true, wishlistEnabled: true }],
    ["b.myshopify.com", { id: "shop-b", notifyEnabled: true, wishlistEnabled: true }],
  ]);
  return {
    rows,
    shop: {
      async findUnique({ where, select }) {
        const row = where.id ? [...rows.values()].find((value) => value.id === where.id) : rows.get(where.domain);
        if (!row) return null;
        return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
      },
      async update({ where, data }) {
        const row = [...rows.values()].find((value) => value.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
  };
}

test("new and unknown shops default to both features enabled", async () => {
  assert.deepEqual(await readFeatureSettings(database(), "new.myshopify.com"), {
    notifyEnabled: true, wishlistEnabled: true,
  });
});

test("feature changes persist and are isolated to the authenticated shop record", async () => {
  const db = database();
  await updateFeatureSettings(db, { id: "shop-a" }, { features: { notify: { enabled: false } } });
  const loaded = await getSettingsResponse(db, { id: "shop-a" });
  assert.equal(loaded.features.notify.enabled, false);
  assert.equal((await getSettingsResponse(db, { id: "shop-b" })).features.notify.enabled, true);
  assert.equal(await isFeatureEnabled(db, "a.myshopify.com", "notify"), false);
  assert.equal(await isFeatureEnabled(db, "a.myshopify.com", "wishlist"), true);
});

test("settings reject shop spoofing and malformed feature updates", async () => {
  const db = database();
  assert.equal(await updateFeatureSettings(db, { id: "shop-a" }, { shopId: "shop-b", features: { notify: { enabled: false } } }), null);
  assert.equal(await updateFeatureSettings(db, { id: "shop-a" }, { features: { notify: { enabled: "false" } } }), null);
  assert.equal(db.rows.get("a.myshopify.com").notifyEnabled, true);
});

test("merchant status describes only implemented surfaces, channels, copy, and integration", () => {
  const payload = buildSettingsResponse({ notifyEnabled: true, wishlistEnabled: true });
  assert.ok(payload.surfaces.supported.some((surface) => surface.includes("Product page")));
  assert.deepEqual(payload.surfaces.unsupported, ["Collection cards"]);
  assert.deepEqual(payload.channels.email, { supported: true, enabled: true });
  assert.equal(payload.channels.whatsapp.enabled, false);
  assert.equal(payload.integration.status, "UNAVAILABLE");
  assert.ok(payload.copy.editableFields.includes("description"));
  assert.equal(JSON.stringify(payload).includes("secret"), false);
  assert.equal(JSON.stringify(payload).includes("customer"), true); // surface label only
});
