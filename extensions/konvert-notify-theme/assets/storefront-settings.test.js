import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./storefront-settings.js", import.meta.url), "utf8");

function fixture(result) {
  const calls = [];
  const warnings = [];
  const window = {};
  vm.runInNewContext(source, {
    window,
    fetch: async (...args) => { calls.push(args); return result; },
    console: { warn: (...args) => warnings.push(args) },
  });
  const root = { hidden: true, dataset: {} };
  const inits = [];
  return { window, root, calls, inits, warnings };
}

test("enabled feature is revealed and initialized after the signed settings fetch", async () => {
  const f = fixture({ ok: true, json: async () => ({ notifyEnabled: true, wishlistEnabled: true }) });
  f.window.KonvertFeatureSettings.mount(f.root, "notify", (root) => f.inits.push(root));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.root.hidden, false);
  assert.deepEqual(f.inits, [f.root]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], "/apps/konvert-notify/settings");
});

test("disabled feature remains hidden and never initializes", async () => {
  const f = fixture({ ok: true, json: async () => ({ notifyEnabled: true, wishlistEnabled: false }) });
  f.window.KonvertFeatureSettings.mount(f.root, "wishlist", (root) => f.inits.push(root));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.root.hidden, true);
  assert.equal(f.inits.length, 0);
});

test("proxy errors fail closed and emit one sanitized diagnostic", async () => {
  const f = fixture({ ok: false });
  f.window.KonvertFeatureSettings.mount(f.root, "notify", (root) => f.inits.push(root));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.root.hidden, true);
  assert.equal(f.inits.length, 0);
  assert.deepEqual(f.warnings, [["[Konvert] Storefront settings unavailable; feature blocks remain hidden."]]);
});
