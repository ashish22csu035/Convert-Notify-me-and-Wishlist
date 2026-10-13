export const REPORTING_ENDPOINT = "/api/reporting";

export function reportingEndpoint(days = 7) {
  return `${REPORTING_ENDPOINT}?days=${encodeURIComponent(days)}`;
}

const COUNT_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});
const PERCENT_FORMAT = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

export function isReportingPayload(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.window &&
    Number.isFinite(value.window.days) &&
    value.notify &&
    value.wishlist &&
    value.provider,
  );
}

export async function requestReporting(
  fetchImpl = window.fetch.bind(window),
  days = 7,
) {
  const response = await fetchImpl(reportingEndpoint(days), {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const data = await response.json();
  if (!response.ok || data?.error || !isReportingPayload(data)) {
    throw new Error("Reporting request failed");
  }
  return data;
}

export function reportingViewState(fetcherState, data) {
  if (fetcherState !== "idle" || data === undefined) return "loading";
  if (data?.error || !isReportingPayload(data)) return "error";
  return "success";
}

export function formatCount(value) {
  return Number.isFinite(value) ? COUNT_FORMAT.format(value) : "—";
}

export function formatPercentage(value) {
  return Number.isFinite(value) ? PERCENT_FORMAT.format(value) : "—";
}

export function isProviderUnavailable(provider) {
  return provider?.configured === false || provider?.status === "UNAVAILABLE";
}

export function getReportingSections(report) {
  const providerUnavailable = isProviderUnavailable(report.provider);
  const providerCount = (value) =>
    providerUnavailable ? "Unavailable" : formatCount(value);
  const providerRate = (value) =>
    providerUnavailable ? "Unavailable" : formatPercentage(value);

  return [
    {
      heading: "Notify",
      metrics: [
        { label: "Notify Me clicks", value: formatCount(report.notify.clicks) },
        {
          label: "Unique signups",
          value: formatCount(report.notify.newRequests),
        },
        {
          label: "Waiting requests",
          value: formatCount(report.notify.waitingRequests),
        },
        {
          label: "Handoff attempts",
          value: providerCount(report.notify.handoffAttempts),
          description: providerUnavailable
            ? "Unavailable — marketing provider is not configured."
            : "Unique handoff jobs with at least one attempt.",
        },
        {
          label: "Accepted handoffs",
          value: providerCount(report.notify.handoffAccepted),
          description: providerUnavailable
            ? "Unavailable — marketing provider is not configured."
            : "Unique handoff jobs accepted by the provider.",
        },
        {
          label: "Failed handoffs",
          value: providerCount(report.notify.handoffFailed),
          description: providerUnavailable
            ? "Unavailable — marketing provider is not configured."
            : "Unique handoff jobs that reached terminal failure.",
        },
        {
          label: "Matched buyers",
          value: formatCount(report.notify.matchedBuyers),
        },
        {
          label: "Signup rate",
          value: formatPercentage(report.notify.signupRate),
          description: "Unique new Notify signups / Notify Me clicks.",
        },
        {
          label: "Handoff acceptance rate",
          value: providerRate(report.notify.handoffAcceptanceRate),
          description: providerUnavailable
            ? "Unavailable — marketing provider is not configured."
            : "Accepted unique handoff jobs / attempted unique handoff jobs.",
        },
        {
          label: "Buyer rate",
          value: formatPercentage(report.notify.buyerRate),
          description: `Unique matched buyers / ${formatCount(report.notify.eligibleContacts)} eligible contacts in this reporting cohort.`,
        },
      ],
    },
    {
      heading: "Wishlist",
      metrics: [
        {
          label: "Wishlist adds",
          value: formatCount(report.wishlist.added),
        },
        {
          label: "Active wishlist items",
          value: formatCount(report.wishlist.activeItems),
        },
        {
          label: "Matched Wishlist buyers",
          value: formatCount(report.wishlist.matchedBuyers),
        },
        {
          label: "Wishlist item conversion",
          value: formatPercentage(report.wishlist.itemConversionRate),
          description:
            "Distinct saved products later bought / distinct products saved in this reporting cohort.",
        },
        {
          label: "Wishlist buyer rate",
          value: formatPercentage(report.wishlist.buyerRate),
          description: `Unique matched buyers / ${formatCount(report.wishlist.eligibleSavers)} eligible savers in this reporting cohort.`,
        },
      ],
    },
  ];
}

export function formatReportingWindow(window) {
  const start = new Date(window?.start);
  const end = new Date(window?.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `Last ${window?.days || 7} days`;
  }
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${formatter.format(start)} – ${formatter.format(end)}`;
}
