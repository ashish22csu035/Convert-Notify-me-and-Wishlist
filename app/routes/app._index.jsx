import { boundary } from "@shopify/shopify-app-react-router/server";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server.js";
import applicationDb from "../application-db.server.js";
import { authenticateMerchantShop } from "../services/reporting/shop-auth.js";
import { getSettingsResponse } from "../services/settings.server.js";
import styles from "../styles/home.module.css";

export const loader = async ({ request }) => {
  const result = await authenticateMerchantShop(request, {
    authenticateAdmin: authenticate.admin,
    db: applicationDb,
  });
  if (result.response) return result.response;

  try {
    return {
      settings: await getSettingsResponse(applicationDb, result.shop),
      settingsUnavailable: false,
    };
  } catch {
    return { settings: null, settingsUnavailable: true };
  }
};

// eslint-disable-next-line react/prop-types
function FeatureCard({ name, description, enabled }) {
  return (
    <s-box padding="base" border="base" borderRadius="base" background="base">
      <div className={styles.featureCard}>
        <s-heading>{name}</s-heading>
        <s-paragraph>{description}</s-paragraph>
        <s-text type="strong">{enabled ? "Enabled" : "Disabled"}</s-text>
      </div>
    </s-box>
  );
}

export default function Home() {
  const { settings, settingsUnavailable } = useLoaderData();
  const notifyEnabled = settings?.features.notify.enabled;
  const wishlistEnabled = settings?.features.wishlist.enabled;

  return (
    <s-page heading="Konvert Notify & Wishlist" inlineSize="large">
      <s-section>
        <s-paragraph>
          Capture demand for unavailable variants and let shoppers save products for later.
        </s-paragraph>
      </s-section>

      {settingsUnavailable ? (
        <s-section>
          <s-banner tone="critical" heading="Feature status could not be loaded">
            <s-paragraph>Retry the page or check your Settings before relying on feature status.</s-paragraph>
            <s-link href="/app/settings">Open Settings</s-link>
          </s-banner>
        </s-section>
      ) : (
        <>
          {(notifyEnabled === false || wishlistEnabled === false) ? (
            <s-section>
              <s-banner tone="warning" heading="A feature is disabled">
                <s-paragraph>
                  {notifyEnabled === false ? "Notify Me is disabled. " : ""}
                  {wishlistEnabled === false ? "Wishlist is disabled. " : ""}
                  You can enable features in Settings.
                </s-paragraph>
                <s-link href="/app/settings">Open Settings</s-link>
              </s-banner>
            </s-section>
          ) : null}

          <s-section>
            <div className={styles.featureGrid}>
              <FeatureCard
                name="Notify Me"
                description="Let shoppers register interest in unavailable variants and prepare requests for marketing-tool handoff when stock returns."
                enabled={notifyEnabled}
              />
              <FeatureCard
                name="Wishlist"
                description="Let logged-in shoppers save products and manage them from My Wishlist."
                enabled={wishlistEnabled}
              />
            </div>
          </s-section>

        </>
      )}

      <s-section heading="Quick links">
        <div className={styles.quickLinks}>
          <s-link href="/app/reporting">Reporting</s-link>
          <s-link href="/app/reporting/demand">Demand &amp; Requests</s-link>
          <s-link href="/app/reporting/wishlist">Wishlist Analytics</s-link>
          <s-link href="/app/settings">Settings</s-link>
        </div>
      </s-section>

      <s-section heading="How it works">
        <div className={styles.flowGrid}>
          <div>
            <s-heading>Notify Me</s-heading>
            <s-paragraph>Unavailable variant → shopper registers → stock returns → marketing-tool handoff</s-paragraph>
          </div>
          <div>
            <s-heading>Wishlist</s-heading>
            <s-paragraph>Shopper saves product → login required → My Wishlist → shopper can return and purchase</s-paragraph>
          </div>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
