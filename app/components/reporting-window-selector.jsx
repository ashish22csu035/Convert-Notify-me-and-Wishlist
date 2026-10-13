import styles from "../styles/reporting.module.css";

/* eslint-disable react/prop-types */
export default function ReportingWindowSelector({
  rangeChoice,
  customDays,
  onChoice,
  onCustomDays,
  onApply,
}) {
  return (
    <s-section>
      <s-box padding="base" border="base" borderRadius="base">
        <div className={styles.rangeControls}>
          <s-select label="Reporting period" value={rangeChoice} onChange={onChoice}>
            <s-option value="7">Last 7 days</s-option>
            <s-option value="30">Last 30 days</s-option>
            <s-option value="custom">Custom days</s-option>
          </s-select>
          {rangeChoice === "custom" ? (
            <s-number-field
              label="Number of days (1–90)"
              value={customDays}
              min={1}
              max={90}
              onChange={onCustomDays}
            />
          ) : null}
          <s-button variant="primary" onClick={onApply}>Apply</s-button>
        </div>
      </s-box>
    </s-section>
  );
}
/* eslint-enable react/prop-types */
