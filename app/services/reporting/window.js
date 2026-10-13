export const DEFAULT_REPORTING_DAYS = 7;
export const MIN_REPORTING_DAYS = 1;
export const MAX_REPORTING_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseReportingDays(searchParams) {
  const values = searchParams.getAll("days");
  if (values.length > 1) return { error: true };
  if (values.length === 0) return { days: DEFAULT_REPORTING_DAYS };
  if (!/^\d+$/.test(values[0])) return { error: true };

  const days = Number(values[0]);
  if (
    !Number.isInteger(days) ||
    days < MIN_REPORTING_DAYS ||
    days > MAX_REPORTING_DAYS
  ) {
    return { error: true };
  }
  return { days };
}

export function getReportingWindow(now, days) {
  if (
    !(now instanceof Date) ||
    Number.isNaN(now.getTime()) ||
    !Number.isInteger(days) ||
    days < MIN_REPORTING_DAYS ||
    days > MAX_REPORTING_DAYS
  ) {
    throw new TypeError("Reporting window input is invalid");
  }
  const end = new Date(now.getTime());
  const start = new Date(end.getTime() - days * DAY_MS);
  return { start, end };
}
