(() => {
  if (window.KonvertFeatureSettings) return;
  let settingsPromise;
  function getSettings() {
    if (!settingsPromise) {
      settingsPromise = fetch("/apps/konvert-notify/settings", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      }).then((response) => {
        if (!response.ok) throw new Error("Settings unavailable");
        return response.json();
      }).catch(() => {
        console.warn("[Konvert] Storefront settings unavailable; feature blocks remain hidden.");
        throw new Error("Settings unavailable");
      });
    }
    return settingsPromise;
  }
  window.KonvertFeatureSettings = {
    mount(root, feature, initialize) {
      if (!root || root.dataset.konvertSettingsChecked === "true") return;
      root.dataset.konvertSettingsChecked = "true";
      getSettings().then((settings) => {
        const enabled = feature === "notify" ? settings.notifyEnabled : settings.wishlistEnabled;
        if (enabled !== true) return;
        root.hidden = false;
        initialize(root);
      }).catch(() => {
        root.dataset.konvertSettingsUnavailable = "true";
      });
    },
  };
})();
