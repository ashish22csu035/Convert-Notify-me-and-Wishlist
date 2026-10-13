import { useCallback, useEffect, useState } from "react";
import styles from "../styles/demand.module.css";

const DEMAND_ENDPOINT = "/api/reporting/demand";
const CONTACTS_ENDPOINT = "/api/reporting/demand/contacts";
const REQUEST_STATUSES = [
  ["ALL", "All request statuses"],
  ["PENDING", "Pending"],
  ["ACTIVE", "Active"],
  ["NOTIFIED", "Notified"],
  ["CLOSED", "Closed"],
  ["UNSUBSCRIBED", "Unsubscribed"],
];

function DemandLoading() {
  return (
    <div className={styles.state} role="status" aria-live="polite">
      <s-spinner size="base" accessibilityLabel="Loading demand and requests" />
      <s-paragraph>Loading demand and requests…</s-paragraph>
    </div>
  );
}

/* eslint-disable react/prop-types */
function FailedJobs({ jobs, onRetry, retryingJobId }) {
  if (jobs.length === 0) return null;
  return (
    <div className={styles.failedJobs}>
      {jobs.map((job) => (
        <details key={job.jobId}>
          <summary>Failed handoff details</summary>
          <s-paragraph>{job.errorMessage || job.errorCode || "No sanitized detail is available."}</s-paragraph>
          {job.errorCode ? <s-text color="subdued">Code: {job.errorCode}</s-text> : null}
          <div className={styles.action}>
            <s-button
              variant="secondary"
              loading={retryingJobId === job.jobId}
              disabled={Boolean(retryingJobId)}
              onClick={() => onRetry(job.jobId)}
            >
              Retry
            </s-button>
          </div>
        </details>
      ))}
    </div>
  );
}

// eslint-disable-next-line react/prop-types
function DemandRows({ rows, onContacts, onRetry, retryingJobId }) {
  return rows.map((row) => (
    <s-table-row key={row.variantShopifyId}>
      <s-table-cell>
        <s-text type="strong">{row.product}</s-text>
      </s-table-cell>
      <s-table-cell>
        <s-text>{row.variant}</s-text>
        {row.sku ? <div><s-text color="subdued">SKU: {row.sku}</s-text></div> : null}
      </s-table-cell>
      <s-table-cell>{row.uniqueWaitingContacts}</s-table-cell>
      <s-table-cell>{row.notifyClicks}</s-table-cell>
      <s-table-cell>{row.newSignups}</s-table-cell>
      <s-table-cell>{row.restockCycle === null ? "Unavailable" : row.restockCycle}</s-table-cell>
      <s-table-cell>
        <s-text>{row.handoffStatus}</s-text>
        <FailedJobs jobs={row.failedJobs} onRetry={onRetry} retryingJobId={retryingJobId} />
      </s-table-cell>
      <s-table-cell>
        <s-button
          variant="secondary"
          disabled={row.uniqueWaitingContacts === 0}
          onClick={() => onContacts(row)}
        >
          View contacts
        </s-button>
      </s-table-cell>
    </s-table-row>
  ));
}
/* eslint-enable react/prop-types */

export default function DemandAndRequestsPage() {
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("ALL");
  const [page, setPage] = useState(1);
  const [report, setReport] = useState(undefined);
  const [state, setState] = useState("loading");
  const [message, setMessage] = useState("");
  const [retryingJobId, setRetryingJobId] = useState("");
  const [contactView, setContactView] = useState(undefined);

  const loadDemand = useCallback(async () => {
    setState("loading");
    try {
      const params = new URLSearchParams({ status, page: String(page) });
      if (search) params.set("search", search);
      const response = await fetch(`${DEMAND_ENDPOINT}?${params}`, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const data = await response.json();
      if (!response.ok || data?.error || !Array.isArray(data?.rows)) {
        throw new Error("Demand report failed");
      }
      setReport(data);
      setState("success");
    } catch {
      setReport(undefined);
      setState("error");
    }
  }, [page, search, status]);

  useEffect(() => {
    loadDemand();
  }, [loadDemand]);

  const applyFilters = (event) => {
    event.preventDefault();
    setPage(1);
    setSearch(searchDraft.trim());
  };

  const showContacts = async (row) => {
    setContactView({ variantId: row.variantShopifyId, product: row.product, variant: row.variant, state: "loading" });
    try {
      const params = new URLSearchParams({ variantId: row.variantShopifyId });
      const response = await fetch(`${CONTACTS_ENDPOINT}?${params}`, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const data = await response.json();
      if (!response.ok || data?.error || !Array.isArray(data?.requests)) {
        throw new Error("Operational contacts failed");
      }
      setContactView((current) =>
        current?.variantId === row.variantShopifyId
          ? { ...current, state: "success", requests: data.requests }
          : current,
      );
    } catch {
      setContactView((current) =>
        current?.variantId === row.variantShopifyId
          ? { ...current, state: "error" }
          : current,
      );
    }
  };

  const retryJob = async (jobId) => {
    setRetryingJobId(jobId);
    setMessage("");
    try {
      const response = await fetch(DEMAND_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jobId }),
      });
      const data = await response.json();
      if (!response.ok || data?.error) {
        throw new Error(data?.error || "Retry failed");
      }
      setMessage(data.message);
      await loadDemand();
    } catch {
      setMessage("This handoff could not be retried. Refresh and try again.");
    } finally {
      setRetryingJobId("");
    }
  };

  return (
    <s-page heading="Demand & Requests" inlineSize="large">
      <s-section>
        <form className={styles.filters} onSubmit={applyFilters}>
          <s-text-field
            label="Search products"
            placeholder="Product title, handle, or SKU"
            value={searchDraft}
            maxLength={100}
            onChange={(event) => setSearchDraft(event.currentTarget.value)}
          />
          <s-select
            label="Request status"
            value={status}
            onChange={(event) => setStatus(event.currentTarget.value)}
          >
            {REQUEST_STATUSES.map(([value, label]) => (
              <s-option key={value} value={value}>{label}</s-option>
            ))}
          </s-select>
          <s-button variant="primary" type="submit">Apply filters</s-button>
        </form>
      </s-section>

      {message ? (
        <s-banner tone="info" heading="Handoff update">
          <s-paragraph>{message}</s-paragraph>
        </s-banner>
      ) : null}

      {state === "loading" ? <DemandLoading /> : null}
      {state === "error" ? (
        <s-banner tone="critical" heading="Demand data could not be loaded">
          <s-paragraph>Check your connection and retry.</s-paragraph>
          <s-button variant="primary" onClick={loadDemand}>Retry</s-button>
        </s-banner>
      ) : null}

      {state === "success" && report?.rows.length === 0 ? (
        <s-section>
          <div className={styles.emptyState}>
            <s-heading>{search || status !== "ALL" ? "No matching requests" : "No demand or requests found"}</s-heading>
          </div>
        </s-section>
      ) : null}

      {state === "success" && report?.rows.length > 0 ? (
        <s-section>
          <div className={styles.tableScroll}>
            <s-table
              variant="auto"
              paginate
              hasPreviousPage={report.page > 1}
              hasNextPage={report.page < report.totalPages}
              onPreviousPage={() => setPage((value) => Math.max(1, value - 1))}
              onNextPage={() => setPage((value) => value + 1)}
            >
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header>Variant</s-table-header>
                <s-table-header>Unique waiting contacts</s-table-header>
                <s-table-header>Notify clicks</s-table-header>
                <s-table-header>New signups</s-table-header>
                <s-table-header>Restock cycle</s-table-header>
                <s-table-header>Handoff status</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                <DemandRows
                  rows={report.rows}
                  onContacts={showContacts}
                  onRetry={retryJob}
                  retryingJobId={retryingJobId}
                />
              </s-table-body>
            </s-table>
          </div>
          {report.totalPages > 1 ? (
            <div className={styles.pagination}>
              <s-text>Page {report.page} of {report.totalPages}</s-text>
            </div>
          ) : null}
        </s-section>
      ) : null}

      {contactView ? (
        <s-section heading={`Operational contacts: ${contactView.product} · ${contactView.variant}`}>
          <s-button variant="secondary" onClick={() => setContactView(undefined)}>Close contacts</s-button>
          {contactView.state === "loading" ? <DemandLoading /> : null}
          {contactView.state === "error" ? (
            <s-banner tone="critical" heading="Contacts could not be loaded">
              <s-paragraph>Retry from this variant&apos;s row.</s-paragraph>
            </s-banner>
          ) : null}
          {contactView.state === "success" && contactView.requests.length === 0 ? (
            <s-paragraph>No contacts are currently waiting for this variant.</s-paragraph>
          ) : null}
          {contactView.state === "success" && contactView.requests.length > 0 ? (
            <s-unordered-list>
              {contactView.requests.map((item) => (
                <s-list-item key={item.requestId}>
                  <s-text>{item.contact} · {item.channel}</s-text>
                </s-list-item>
              ))}
            </s-unordered-list>
          ) : null}
        </s-section>
      ) : null}
    </s-page>
  );
}
