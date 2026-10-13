import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCount,
  formatPercentage,
  formatReportingWindow,
  getReportingSections,
  isProviderUnavailable,
  REPORTING_ENDPOINT,
  reportingEndpoint,
  requestReporting,
  reportingViewState,
} from "./ui.js";

function reportFixture(overrides = {}) {
  return {
    window: {
      days: 7,
      start: "2026-10-01T12:00:00.000Z",
      end: "2026-10-08T12:00:00.000Z",
    },
    notify: {
      clicks: 0,
      newRequests: 0,
      waitingRequests: 0,
      restockDetected: 0,
      handoffAttempts: null,
      handoffAccepted: null,
      handoffFailed: null,
      matchedBuyers: 0,
      signupRate: null,
      handoffAcceptanceRate: null,
      buyerRate: null,
      eligibleContacts: 0,
    },
    wishlist: {
      clicks: 0,
      added: 0,
      removed: 0,
      activeItems: 0,
      matchedBuyers: 0,
      itemConversionRate: null,
      buyerRate: null,
      eligibleSavers: 0,
    },
    provider: { configured: false, status: "UNAVAILABLE" },
    ...overrides,
  };
}

test("reporting page starts in loading state and requests a selected day range without browser identity", () => {
  assert.equal(reportingViewState("idle", undefined), "loading");
  assert.equal(reportingViewState("loading", reportFixture()), "loading");
  assert.equal(REPORTING_ENDPOINT, "/api/reporting");
  assert.equal(reportingEndpoint(30), `${REPORTING_ENDPOINT}?days=30`);
});

test("report request performs an authenticated same-origin GET with no browser identity", async () => {
  const report = reportFixture();
  let requestUrl;
  let requestOptions;
  const result = await requestReporting(async (url, options) => {
    requestUrl = url;
    requestOptions = options;
    return {
      ok: true,
      async json() {
        return report;
      },
    };
  });

  assert.equal(result, report);
  assert.equal(requestUrl, "/api/reporting?days=7");
  assert.deepEqual(requestOptions, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  assert.equal("shopId" in requestOptions, false);
  assert.equal("customerId" in requestOptions, false);
});

test("report request rejects failed API responses", async () => {
  await assert.rejects(
    requestReporting(async () => ({
      ok: false,
      async json() {
        return { error: "reporting_unavailable" };
      },
    })),
    /Reporting request failed/,
  );
});

test("report request sends the selected custom day count", async () => {
  let requestUrl;
  await requestReporting(async (url) => {
    requestUrl = url;
    return { ok: true, async json() { return reportFixture(); } };
  }, 14);
  assert.equal(requestUrl, "/api/reporting?days=14");
});

test("successful report maps backend values to merchant-facing metric labels", () => {
  const report = reportFixture({
    notify: {
      ...reportFixture().notify,
      clicks: 4,
      newRequests: 2,
      signupRate: 0.5,
    },
    wishlist: {
      ...reportFixture().wishlist,
      added: 10,
      itemConversionRate: 0.2,
      buyerRate: 0.1,
    },
  });

  assert.equal(reportingViewState("idle", report), "success");
  const sections = getReportingSections(report);
  assert.deepEqual(sections[0].metrics.slice(0, 2), [
    { label: "Notify Me clicks", value: "4" },
    { label: "Unique signups", value: "2" },
  ]);
  assert.equal(sections[0].metrics.find((metric) => metric.label === "Signup rate").value, "50%");
  assert.equal(sections[0].metrics.find((metric) => metric.label === "Signup rate").description, "Unique new Notify signups / Notify Me clicks.");
  assert.equal(sections[1].metrics.find((metric) => metric.label === "Wishlist item conversion").value, "20%");
  assert.equal(sections[1].metrics.find((metric) => metric.label === "Wishlist buyer rate").value, "10%");
  assert.match(formatReportingWindow(report.window), /–/);
});

test("legitimate zero activity renders zero values", () => {
  const sections = getReportingSections(reportFixture());
  assert.equal(sections[0].metrics[0].value, "0");
  assert.equal(sections[0].metrics[1].value, "0");
  assert.equal(sections[1].metrics[0].value, "0");
  assert.equal(sections[1].metrics[1].value, "0");
});

test("unavailable provider data renders Unavailable rather than zero", () => {
  const report = reportFixture();
  assert.equal(isProviderUnavailable(report.provider), true);
  const notifyMetrics = getReportingSections(report)[0].metrics;
  for (const label of ["Handoff attempts", "Accepted handoffs", "Failed handoffs", "Handoff acceptance rate"]) {
    const metric = notifyMetrics.find((item) => item.label === label);
    assert.equal(metric.value, "Unavailable");
    assert.match(metric.description, /provider is not configured/);
  }
});

test("API errors and malformed payloads enter the retryable error state", () => {
  assert.equal(
    reportingViewState("idle", { error: "reporting_unavailable" }),
    "error",
  );
  assert.equal(reportingViewState("idle", { notify: {} }), "error");
});

test("percentages safely render zero, a percentage, and an em dash for invalid denominators", () => {
  assert.equal(formatPercentage(0), "0%");
  assert.equal(formatPercentage(0.2), "20%");
  assert.equal(formatPercentage(null), "—");
  assert.equal(formatPercentage(Number.NaN), "—");
  assert.equal(formatPercentage(Number.POSITIVE_INFINITY), "—");
  assert.equal(formatCount(undefined), "—");
});
