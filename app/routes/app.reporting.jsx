import { useCallback, useEffect, useState } from "react";
import styles from "../styles/reporting.module.css";
import ReportingWindowSelector from "../components/reporting-window-selector.jsx";
import {
  formatReportingWindow,
  getReportingSections,
  requestReporting,
  reportingViewState,
} from "../services/reporting/ui.js";

// eslint-disable-next-line react/prop-types
function MetricCard({ label, value, description }) {
  return (
    <s-box padding="base" border="base" borderRadius="base" background="base">
      <div className={styles.metricLabel}>
        <s-text color="subdued">{label}</s-text>
      </div>
      <div className={styles.metricValue}>
        <s-text type="strong">{value}</s-text>
      </div>
      {description ? (
        <div className={styles.metricDescription}>
          <s-text color="subdued">{description}</s-text>
        </div>
      ) : null}
    </s-box>
  );
}

function LoadingState() {
  return (
    <s-section>
      <div className={styles.loadingState} role="status" aria-live="polite">
        <s-spinner size="base" accessibilityLabel="Loading report" />
        <s-paragraph>Loading your report…</s-paragraph>
      </div>
    </s-section>
  );
}

// eslint-disable-next-line react/prop-types
function ErrorState({ onRetry }) {
  return (
    <s-section>
      <s-banner tone="critical" heading="Reporting data could not be loaded">
        <s-paragraph>Check your connection and try again.</s-paragraph>
      </s-banner>
      <div className={styles.errorActions}>
        <s-button variant="primary" onClick={onRetry}>
          Retry
        </s-button>
      </div>
    </s-section>
  );
}

/* eslint-disable react/prop-types */
function MetricsSection({ heading, metrics }) {
  return (
    <s-section heading={heading}>
      <div className={styles.metricGrid}>
        {metrics.map(({ label, value, description }) => (
          <MetricCard
            key={label}
            label={label}
            value={value}
            description={description}
          />
        ))}
      </div>
    </s-section>
  );
}
/* eslint-enable react/prop-types */

export default function ReportingPage() {
  const [request, setRequest] = useState({ state: "loading", data: undefined });
  const [rangeChoice, setRangeChoice] = useState("7");
  const [customDays, setCustomDays] = useState("14");
  const [requestedDays, setRequestedDays] = useState(7);
  const loadReport = useCallback(async (days = 7) => {
    setRequest({ state: "loading", data: undefined });
    try {
      const data = await requestReporting(window.fetch.bind(window), days);
      setRequest({ state: "idle", data });
    } catch {
      setRequest({ state: "idle", data: { error: "reporting_unavailable" } });
    }
  }, []);
  const viewState = reportingViewState(request.state, request.data);

  useEffect(() => {
    loadReport(7);
  }, [loadReport]);

  const retry = () => loadReport(requestedDays);

  const selectRange = (event) => setRangeChoice(event.currentTarget.value);
  const updateCustomDays = (event) => setCustomDays(event.currentTarget.value);
  const applyRange = (event) => {
    event.preventDefault();
    const days = rangeChoice === "custom" ? Number(customDays) : Number(rangeChoice);
    setRequestedDays(days);
    loadReport(days);
  };

  const report = request.data?.window ? request.data : undefined;
  const providerUnavailable = report && (
    report.provider.configured === false ||
    report.provider.status === "UNAVAILABLE"
  );

  if (viewState === "loading") {
    return (
      <s-page heading="Reporting" inlineSize="large">
        <ReportingWindowSelector {...{ rangeChoice, customDays }} onChoice={selectRange} onCustomDays={updateCustomDays} onApply={applyRange} />
        <LoadingState />
      </s-page>
    );
  }

  if (viewState === "error") {
    return (
      <s-page heading="Reporting" inlineSize="large">
        <ReportingWindowSelector {...{ rangeChoice, customDays }} onChoice={selectRange} onCustomDays={updateCustomDays} onApply={applyRange} />
        <ErrorState onRetry={retry} />
      </s-page>
    );
  }

  const currentReport = request.data;
  const sections = getReportingSections(currentReport);

  return (
    <s-page heading="Reporting" inlineSize="large">
      <ReportingWindowSelector {...{ rangeChoice, customDays }} onChoice={selectRange} onCustomDays={updateCustomDays} onApply={applyRange} />
      <div className={styles.window}>
        <s-paragraph color="subdued">
          Last {currentReport.window.days} days · {formatReportingWindow(currentReport.window)}
        </s-paragraph>
      </div>

      {providerUnavailable ? (
        <s-banner tone="warning" heading="Provider metrics unavailable">
          <s-paragraph>
            Unavailable — marketing provider is not configured. Handoff attempts and outcomes are unavailable.
          </s-paragraph>
        </s-banner>
      ) : null}

      {sections.map((section) => (
        <MetricsSection
          key={section.heading}
          heading={section.heading}
          metrics={section.metrics}
        />
      ))}
    </s-page>
  );
}
