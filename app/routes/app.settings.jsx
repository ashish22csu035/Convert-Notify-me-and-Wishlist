import { useEffect, useState } from "react";

export default function SettingsPage() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({ notify: true, wishlist: true });
  const [status, setStatus] = useState("loading");
  const [saving, setSaving] = useState(false);

  async function load() {
    setStatus("loading");
    try {
      const response = await fetch("/api/settings", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("load");
      const result = await response.json();
      setData(result);
      setDraft({ notify: result.features.notify.enabled, wishlist: result.features.wishlist.enabled });
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }

  useEffect(() => { load(); }, []);

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ features: { notify: { enabled: draft.notify }, wishlist: { enabled: draft.wishlist } } }),
      });
      if (!response.ok) throw new Error("save");
      const result = await response.json();
      setData(result);
      setDraft({ notify: result.features.notify.enabled, wishlist: result.features.wishlist.enabled });
      setStatus("saved");
    } catch {
      setStatus("save-error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <s-page heading="Settings">
      {status === "loading" ? <s-section><s-spinner size="base" accessibilityLabel="Loading settings" /></s-section> : null}
      {status === "error" ? <s-section><s-banner tone="critical" heading="Settings could not be loaded"><s-button onClick={load}>Retry</s-button></s-banner></s-section> : null}
      {data ? <>
        <s-section heading="Feature status">
          <s-switch label="Notify Me" checked={draft.notify} onChange={(event) => setDraft({ ...draft, notify: event.currentTarget.checked })} />
          <s-switch label="Wishlist" checked={draft.wishlist} onChange={(event) => setDraft({ ...draft, wishlist: event.currentTarget.checked })} />
          <s-button variant="primary" onClick={save} loading={saving}>Save changes</s-button>
          {status === "saved" ? <s-banner tone="success" heading="Settings saved" /> : null}
          {status === "save-error" ? <s-banner tone="critical" heading="Settings could not be saved"><s-paragraph>Try again. Changes are confirmed only after the server saves them.</s-paragraph></s-banner> : null}
        </s-section>
        <s-section heading="Supported storefront surfaces">
          <s-paragraph>Supported: {data.surfaces.supported.join("; ")}.</s-paragraph>
          <s-paragraph>Not supported: {data.surfaces.unsupported.join(", ")}.</s-paragraph>
          <s-paragraph>Theme support depends on the product-page app blocks being added in the Shopify Theme Editor.</s-paragraph>
        </s-section>
        <s-section heading="Notify Me">
          <s-paragraph>Email notifications are supported and enabled. WhatsApp is coming soon and is not operational.</s-paragraph>
          <s-paragraph>Change the Notify block heading, description, and button label in the Shopify Theme Editor. Text is safely escaped by the block.</s-paragraph>
        </s-section>
        <s-section heading="Marketing integration"><s-paragraph>Unavailable — not configured.</s-paragraph></s-section>
      </> : null}
    </s-page>
  );
}
