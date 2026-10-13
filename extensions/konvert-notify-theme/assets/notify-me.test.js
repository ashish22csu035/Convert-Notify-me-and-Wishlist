import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const notifyScript = await readFile(new URL("./notify-me.js", import.meta.url), "utf8");
const clickId = "a9f7c54e-7a4e-4a21-8df6-328bfc221a10";

class ElementMock {
  constructor() {
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
  }

  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target: this });
    }
  }

  querySelectorAll() {
    return [];
  }

  closest() {
    return null;
  }

  removeAttribute() {}

  focus() {}
}

function createNotifyFixture() {
  const root = new ElementMock();
  root.dataset = {
    variants: JSON.stringify([
      { id: 456, title: "Blue", available: false },
    ]),
    productId: "123",
    analyticsEndpoint: "/apps/konvert-notify/analytics",
    initialVariantId: "456",
    productName: "Example product",
    invalidVariant: "This option is available.",
  };
  const trigger = new ElementMock();
  const dialog = new ElementMock();
  dialog.open = false;
  dialog.showModal = () => {
    dialog.open = true;
  };
  const form = new ElementMock();
  const email = new ElementMock();
  email.value = "";
  email.validity = { valid: false };
  const consent = new ElementMock();
  consent.checked = false;
  const submit = new ElementMock();
  const status = new ElementMock();
  status.dataset = {};
  const productName = new ElementMock();
  const variantTitle = new ElementMock();
  const elements = {
    "[data-open-dialog]": trigger,
    "[data-dialog]": dialog,
    "[data-form]": form,
    "[data-email]": email,
    "[data-consent]": consent,
    "[data-submit]": submit,
    "[data-status]": status,
    "[data-product-name]": productName,
    "[data-variant-title]": variantTitle,
  };
  root.querySelector = (selector) => elements[selector] ?? null;
  root.matches = () => false;

  const documentListeners = new Map();
  const document = {
    documentElement: new ElementMock(),
    addEventListener(type, callback) {
      documentListeners.set(type, callback);
    },
    querySelectorAll(selector) {
      if (selector === "[data-konvert-notify]") return [root];
      return [];
    },
  };
  const fetchCalls = [];
  const window = {
    location: { search: "" },
    crypto: { randomUUID: () => clickId },
    KonvertFeatureSettings: { mount: (node, feature, initialize) => {
      assert.equal(feature, "notify");
      node.hidden = false;
      initialize(node);
    } },
  };
  const sandbox = {
    window,
    document,
    Element: ElementMock,
    URLSearchParams,
    MutationObserver: class {
      observe() {}
    },
    fetch: async (...args) => {
      fetchCalls.push(args);
      return { ok: true };
    },
    console: { warn() {} },
  };

  return { sandbox, trigger, dialog, fetchCalls, documentListeners };
}

test("Notify click analytics fires only when a click opens the modal and binds once", async () => {
  const fixture = createNotifyFixture();
  runInNewContext(notifyScript, fixture.sandbox);
  runInNewContext(notifyScript, fixture.sandbox);

  assert.equal(fixture.fetchCalls.length, 0);
  assert.equal(fixture.trigger.listeners.get("click").length, 1);
  fixture.documentListeners.get("change")?.({});
  assert.equal(fixture.fetchCalls.length, 0);
  fixture.trigger.dispatch("click");

  assert.equal(fixture.dialog.open, true);
  assert.equal(fixture.fetchCalls.length, 1);
  assert.equal(
    fixture.fetchCalls[0][0],
    "/apps/konvert-notify/analytics",
  );
  assert.equal(fixture.fetchCalls[0][1].method, "POST");
  assert.deepEqual(JSON.parse(fixture.fetchCalls[0][1].body), {
    clickId,
    productId: "123",
    variantId: "456",
  });

  fixture.trigger.dispatch("click");
  assert.equal(fixture.fetchCalls.length, 1);
});
