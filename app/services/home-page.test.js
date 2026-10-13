import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const home = await readFile(new URL("../routes/app._index.jsx", import.meta.url), "utf8");
const settings = await readFile(new URL("../routes/app.settings.jsx", import.meta.url), "utf8");

test("Home keeps the feature cards, quick links, and How it works flow", () => {
  assert.match(home, /heading="Konvert Notify & Wishlist"/);
  assert.match(home, /Capture demand for unavailable variants/);
  assert.match(home, /enabled=\{notifyEnabled\}/);
  assert.match(home, /enabled=\{wishlistEnabled\}/);
  assert.match(home, /href="\/app\/reporting"/);
  assert.match(home, /href="\/app\/reporting\/demand"/);
  assert.match(home, /href="\/app\/reporting\/wishlist"/);
  assert.match(home, /href="\/app\/settings"/);
  assert.match(home, /heading="How it works"/);
});

test("Home omits Settings-only sections while Settings retains them", () => {
  assert.doesNotMatch(home, /heading="Supported storefront surfaces"/);
  assert.doesNotMatch(home, /heading="Marketing integration"/);
  assert.match(settings, /heading="Supported storefront surfaces"/);
  assert.match(settings, /heading="Marketing integration"/);
});
