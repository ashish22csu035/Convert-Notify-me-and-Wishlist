(() => {
  const rootSelector = "[data-konvert-notify]";
  const roots = new Map();

  function initialize(root) {
    if (root.dataset.initialized === "true") return;
    root.dataset.initialized = "true";

    let variants;
    try {
      variants = JSON.parse(root.dataset.variants);
    } catch {
      throw new Error("Notify Me could not read the product variants.");
    }

    const variantsById = new Map(
      variants.map((variant) => [String(variant.id), variant]),
    );
    const trigger = root.querySelector("[data-open-dialog]");
    const dialog = root.querySelector("[data-dialog]");
    const form = root.querySelector("[data-form]");
    const email = root.querySelector("[data-email]");
    const consent = root.querySelector("[data-consent]");
    const submit = root.querySelector("[data-submit]");
    const status = root.querySelector("[data-status]");
    const productName = root.querySelector("[data-product-name]");
    const variantTitle = root.querySelector("[data-variant-title]");
    let selectedVariantId = "";
    let submittingVariantId = "";
    let submittingVariantTitle = "";
    let submitting = false;
    let completed = false;
    let returnFocusTo = null;

    function selectedVariant() {
      const variantSelector =
        'form[action*="/cart/add"] [name="id"], [data-product-form] [name="id"]';
      const localScope = root.closest(".shopify-section");
      const scopes = localScope ? [localScope, document] : [document];

      for (const scope of scopes) {
        const variantInputs = scope.querySelectorAll(variantSelector);
        for (const input of variantInputs) {
          const variant = variantsById.get(String(input.value));
          if (variant) return variant;
        }
      }

      const queryVariant = new URLSearchParams(window.location.search).get(
        "variant",
      );
      if (queryVariant && variantsById.has(queryVariant)) {
        return variantsById.get(queryVariant);
      }

      return variantsById.get(root.dataset.initialVariantId) || null;
    }

    function showStatus(state, message) {
      status.dataset.state = state;
      status.textContent = message;
    }

    function clearStatus() {
      delete status.dataset.state;
      status.textContent = "";
    }

    function messageForVariant(template, title) {
      return template.replace("__VARIANT__", title);
    }

    function recordNotifyClick(variant) {
      const clickId = window.crypto.randomUUID();
      void fetch(root.dataset.analyticsEndpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clickId,
          productId: root.dataset.productId,
          variantId: String(variant.id),
        }),
      })
        .then((response) => {
          if (!response.ok) {
            console.warn("Notify click analytics unavailable", response.status);
          }
        })
        .catch(() => {
          console.warn("Notify click analytics unavailable");
        });
    }

    function syncVariant() {
      const variant = selectedVariant();
      const nextId = variant ? String(variant.id) : "";

      if (nextId !== selectedVariantId) {
        selectedVariantId = nextId;
        completed = false;
        email.value = "";
        consent.checked = false;
        email.removeAttribute("aria-invalid");
        consent.removeAttribute("aria-invalid");

        if (submitting && submittingVariantId !== selectedVariantId) {
          showStatus(
            "loading",
            messageForVariant(
              root.dataset.submittingVariantMessage,
              submittingVariantTitle,
            ),
          );
        } else {
          clearStatus();
        }
      }

      productName.textContent = root.dataset.productName;
      variantTitle.textContent = variant?.title || "";
      trigger.hidden = !variant || variant.available;
      submit.disabled =
        submitting || completed || !variant || variant.available;

      if (
        variant?.available &&
        dialog.open &&
        !["loading", "success", "duplicate", "error"].includes(
          status.dataset.state,
        )
      ) {
        showStatus("validation", root.dataset.invalidVariant);
      }
    }

    root.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => dialog.close());
    });

    trigger.addEventListener("click", () => {
      const variant = variantsById.get(selectedVariantId);
      if (!variant || variant.available || dialog.open) return;

      returnFocusTo = trigger;
      dialog.showModal();
      recordNotifyClick(variant);
      email.focus();
    });

    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });

    dialog.addEventListener("close", () => {
      if (returnFocusTo?.isConnected && !returnFocusTo.hidden) {
        returnFocusTo.focus();
      }
      returnFocusTo = null;
    });

    email.addEventListener("input", () => {
      email.removeAttribute("aria-invalid");
      if (status.dataset.state === "validation") clearStatus();
    });

    consent.addEventListener("change", () => {
      consent.removeAttribute("aria-invalid");
      if (status.dataset.state === "validation") clearStatus();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submitting || completed) return;

      const variant = variantsById.get(selectedVariantId);
      const contact = email.value.trim();
      const validEmail =
        email.validity.valid && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
      const validConsent = consent.checked;

      email.setAttribute("aria-invalid", String(!validEmail));
      consent.setAttribute("aria-invalid", String(!validConsent));
      if (!variant || variant.available || !validEmail || !validConsent) {
        showStatus(
          "validation",
          !validEmail
            ? root.dataset.invalidEmail
            : !validConsent
              ? root.dataset.requiredConsent
              : root.dataset.invalidVariant,
        );
        return;
      }

      submitting = true;
      submittingVariantId = String(variant.id);
      submittingVariantTitle = variant.title;
      submit.disabled = true;
      showStatus("loading", root.dataset.loadingMessage);

      try {
        const response = await fetch(root.dataset.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            variantId: String(variant.id),
            contact,
            channel: "EMAIL",
            consent: true,
          }),
        });
        let result;
        try {
          result = await response.json();
        } catch {
          result = null;
        }

        const variantChanged =
          String(selectedVariantId) !== submittingVariantId;
        if (response.ok && result?.success === true && result.duplicate) {
          completed = !variantChanged;
          showStatus(
            "duplicate",
            variantChanged
              ? messageForVariant(
                  root.dataset.duplicateVariantMessage,
                  submittingVariantTitle,
                )
              : result.message || root.dataset.duplicateMessage,
          );
        } else if (response.ok && result?.success === true) {
          completed = !variantChanged;
          showStatus(
            "success",
            variantChanged
              ? messageForVariant(
                  root.dataset.successVariantMessage,
                  submittingVariantTitle,
                )
              : result.message || root.dataset.successMessage,
          );
        } else if (response.status === 400) {
          showStatus(
            "validation",
            result?.message || root.dataset.invalidResponse,
          );
        } else {
          showStatus("error", result?.message || root.dataset.errorMessage);
        }
      } catch {
        showStatus("error", root.dataset.networkError);
      } finally {
        submitting = false;
        submittingVariantId = "";
        submittingVariantTitle = "";
        syncVariant();
      }
    });

    roots.set(root, syncVariant);
    syncVariant();
  }

  function initializeWithin(node) {
    const mount = (root) => window.KonvertFeatureSettings?.mount(root, "notify", initialize);
    if (node instanceof Element && node.matches(rootSelector)) mount(node);
    node.querySelectorAll?.(rootSelector).forEach(mount);
  }

  function updateVariants() {
    roots.forEach((syncVariant, root) => {
      if (!root.isConnected) {
        roots.delete(root);
        return;
      }
      syncVariant();
    });
  }

  if (window.konvertNotifyInitialized) return;
  window.konvertNotifyInitialized = true;

  initializeWithin(document);
  document.addEventListener("change", updateVariants);
  document.addEventListener("input", updateVariants);
  document.addEventListener("shopify:section:load", (event) =>
    initializeWithin(event.target),
  );
  new MutationObserver((records) => {
    records.forEach((record) => record.addedNodes.forEach(initializeWithin));
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
