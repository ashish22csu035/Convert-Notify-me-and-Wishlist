import { useCallback, useEffect, useState } from "react";
import ReportingWindowSelector from "../components/reporting-window-selector.jsx";
import {
  formatCount,
  formatPercentage,
  formatReportingWindow,
} from "../services/reporting/ui.js";
import styles from "../styles/reporting.module.css";
import wishlistStyles from "../styles/wishlist.module.css";

const WISHLIST_ENDPOINT = "/api/reporting/wishlist";

function LoadingState() {
  return (
    <s-section>
      <div className={styles.loadingState} role="status" aria-live="polite">
        <s-spinner size="base" accessibilityLabel="Loading Wishlist Analytics" />
        <s-paragraph>Loading Wishlist Analytics…</s-paragraph>
      </div>
    </s-section>
  );
}

// eslint-disable-next-line react/prop-types
function MetricCard({ label, value, description }) {
  return (
    <s-box padding="base" border="base" borderRadius="base" background="base">
      <div className={styles.metricLabel}><s-text color="subdued">{label}</s-text></div>
      <div className={styles.metricValue}><s-text type="strong">{value}</s-text></div>
      {description ? (
        <div className={styles.metricDescription}><s-text color="subdued">{description}</s-text></div>
      ) : null}
    </s-box>
  );
}

export default function WishlistAnalyticsPage() {
  const [rangeChoice, setRangeChoice] = useState("7");
  const [customDays, setCustomDays] = useState("14");
  const [requestedDays, setRequestedDays] = useState(7);
  const [state, setState] = useState("loading");
  const [report, setReport] = useState(undefined);

  const loadReport = useCallback(async (days) => {
    setState("loading");
    try {
      const params = new URLSearchParams({ days: String(days) });
      const response = await fetch(`${WISHLIST_ENDPOINT}?${params}`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const data = await response.json();
      if (
        !response.ok ||
        data?.error ||
        !data?.window ||
        !data?.summary ||
        !Array.isArray(data?.products)
      ) {
        throw new Error("Wishlist Analytics request failed");
      }
      setReport(data);
      setState("success");
    } catch {
      setReport(undefined);
      setState("error");
    }
  }, []);

  useEffect(() => {
    loadReport(7);
  }, [loadReport]);

  const applyRange = (event) => {
    event.preventDefault();
    const days = rangeChoice === "custom" ? Number(customDays) : Number(rangeChoice);
    setRequestedDays(days);
    loadReport(days);
  };
  const selectRange = (event) => setRangeChoice(event.currentTarget.value);
  const updateCustomDays = (event) => setCustomDays(event.currentTarget.value);

  return (
    <s-page heading="Wishlist Analytics" inlineSize="large">
      <ReportingWindowSelector
        rangeChoice={rangeChoice}
        customDays={customDays}
        onChoice={selectRange}
        onCustomDays={updateCustomDays}
        onApply={applyRange}
      />
      {state === "loading" ? <LoadingState /> : null}
      {state === "error" ? (
        <s-section>
          <s-banner tone="critical" heading="Wishlist Analytics could not be loaded">
            <s-paragraph>Check your connection and try again.</s-paragraph>
          </s-banner>
          <div className={styles.errorActions}>
            <s-button variant="primary" onClick={() => loadReport(requestedDays)}>Retry</s-button>
          </div>
        </s-section>
      ) : null}

      {state === "success" && report ? (
        <>
          <div className={wishlistStyles.window}>
            <s-paragraph color="subdued">
              Last {report.window.days} days · {formatReportingWindow(report.window)}
            </s-paragraph>
          </div>
          <s-section heading="Wishlist summary">
            <div className={styles.metricGrid}>
              <MetricCard label="Distinct saved products" value={formatCount(report.summary.savedProducts)} />
              <MetricCard label="Save episodes" value={formatCount(report.summary.savedItems)} />
              <MetricCard label="Distinct products later bought" value={formatCount(report.summary.matchedProducts)} />
              <MetricCard
                label="Wishlist item conversion"
                value={formatPercentage(report.summary.itemConversionRate)}
                description="Distinct saved products later bought / distinct products saved. Purchases use the existing 7-day attribution window."
              />
              <MetricCard label="Active savers" value={formatCount(report.summary.activeSavers)} />
            </div>
          </s-section>

          <s-section heading="Shopper summary">
            <div className={wishlistStyles.summary}>
              <s-paragraph>
                During this period, {formatCount(report.summary.savedProducts)} distinct products were saved across {formatCount(report.summary.savedItems)} save episodes, and {formatCount(report.summary.matchedProducts)} distinct saved products were later purchased.
              </s-paragraph>
            </div>
          </s-section>

          <s-section heading="Product ranking by saves">
            {report.products.length === 0 ? (
              <div className={wishlistStyles.emptyState}>
                <s-heading>No Wishlist activity in this reporting window</s-heading>
              </div>
            ) : (
              <div className={wishlistStyles.tableScroll}>
                <s-table variant="auto">
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Product</s-table-header>
                    <s-table-header>Saves</s-table-header>
                    <s-table-header>Active savers</s-table-header>
                    <s-table-header>Matched buyers</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {report.products.map((product) => (
                      <s-table-row key={product.productId}>
                        <s-table-cell>
                          <s-text type="strong">{product.title}</s-text>
                          {product.handle ? <div><s-text color="subdued">/{product.handle}</s-text></div> : null}
                        </s-table-cell>
                        <s-table-cell>{formatCount(product.saves)}</s-table-cell>
                        <s-table-cell>{formatCount(product.activeSavers)}</s-table-cell>
                        <s-table-cell>{formatCount(product.matchedBuyers)}</s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </div>
            )}
          </s-section>
        </>
      ) : null}
    </s-page>
  );
}
