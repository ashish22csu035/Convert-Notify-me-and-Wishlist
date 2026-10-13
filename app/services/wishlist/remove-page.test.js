import assert from "node:assert/strict";
import test from "node:test";
import { removeWishlistEntryFromPage } from "./remove-page.js";

function pageFixture({ otherItems = false } = {}) {
  let removed = false;
  let replacement = null;
  const alerts = [];
  const details = {
    append(element) {
      alerts.push(element);
    },
  };
  const card = {
    remove() {
      removed = true;
    },
    querySelector(selector) {
      if (selector === "[role='alert']") {
        return alerts.find((alert) => !alert.removed) ?? null;
      }
      if (selector === ".wishlist-details") return details;
      return null;
    },
  };
  const list = {
    querySelector() {
      return otherItems || !removed ? card : null;
    },
    replaceWith(element) {
      replacement = element;
    },
  };
  const button = { disabled: false, textContent: "Remove" };
  const documentRef = {
    createElement(tagName) {
      return {
        tagName,
        attributes: {},
        removed: false,
        remove() {
          this.removed = true;
        },
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      };
    },
  };

  return {
    button,
    card,
    list,
    documentRef,
    alerts,
    get removed() {
      return removed;
    },
    get replacement() {
      return replacement;
    },
  };
}

function removePageArgs(fixture, fetcher) {
  return {
    ...fixture,
    entryId: "entry-1",
    fetcher,
    endpoint: "/apps/konvert-notify/wishlist",
    emptyClass: "wishlist-empty",
    errorClass: "wishlist-error",
    detailsSelector: ".wishlist-details",
    emptyMessage: "No Wishlist items have been saved yet.",
  };
}

test("successful removal sends DELETE and removes the item from the page", async () => {
  const fixture = pageFixture();
  let request;
  const removed = await removeWishlistEntryFromPage(
    removePageArgs(fixture, async (url, options) => {
      request = { url, ...options };
      return { ok: true, json: async () => ({ removed: true }) };
    }),
  );

  assert.equal(removed, true);
  assert.equal(request.url, "/apps/konvert-notify/wishlist");
  assert.equal(request.method, "DELETE");
  assert.deepEqual(JSON.parse(request.body), { entryId: "entry-1" });
  assert.equal(fixture.removed, true);
  assert.equal(fixture.replacement.textContent, "No Wishlist items have been saved yet.");
  assert.equal(fixture.button.disabled, true);
});

test("failed removal keeps the item visible and enables retry", async () => {
  const fixture = pageFixture();
  const removed = await removeWishlistEntryFromPage(
    removePageArgs(fixture, async () => ({
      ok: false,
      json: async () => ({ error: "wishlist_update_failed" }),
    })),
  );

  assert.equal(removed, false);
  assert.equal(fixture.removed, false);
  assert.equal(fixture.button.disabled, false);
  assert.equal(fixture.button.textContent, "Remove");
  assert.equal(fixture.alerts[0].attributes.role, "alert");
  assert.equal(
    fixture.alerts[0].textContent,
    "We couldn't remove this item. Try removing again.",
  );

  const retried = await removeWishlistEntryFromPage(
    removePageArgs(fixture, async () => ({
      ok: true,
      json: async () => ({ removed: true }),
    })),
  );
  assert.equal(retried, true);
  assert.equal(fixture.removed, true);
  assert.equal(fixture.alerts[0].removed, true);
});

test("successful removal leaves the list in place while other items remain", async () => {
  const fixture = pageFixture({ otherItems: true });
  await removeWishlistEntryFromPage(
    removePageArgs(fixture, async () => ({
      ok: true,
      json: async () => ({ removed: true }),
    })),
  );

  assert.equal(fixture.removed, true);
  assert.equal(fixture.replacement, null);
});
