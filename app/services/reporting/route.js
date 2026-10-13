import applicationDb from "../../application-db.server.js";
import { providerAdapter } from "../handoff-processing/provider-adapter.js";
import {
  getMerchantReporting,
  MAX_REPORTING_DAYS,
  MIN_REPORTING_DAYS,
} from "./index.js";
import { parseReportingDays } from "./window.js";
import { authenticateMerchantShop } from "./shop-auth.js";

function jsonResponse(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function loadMerchantReporting(
  request,
  {
    authenticateAdmin,
    db = applicationDb,
    providerConfigured = providerAdapter.configured === true,
    now = new Date(),
  } = {},
) {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const { days, error: invalidDays } = parseReportingDays(
    new URL(request.url).searchParams,
  );
  if (invalidDays) {
    return jsonResponse(
      {
        error: "invalid_reporting_days",
        minimum: MIN_REPORTING_DAYS,
        maximum: MAX_REPORTING_DAYS,
      },
      400,
    );
  }

  if (!authenticateAdmin) {
    const { authenticate } = await import("../../shopify.server.js");
    authenticateAdmin = authenticate.admin;
  }
  try {
    const merchant = await authenticateMerchantShop(request, {
      authenticateAdmin,
      db,
      unavailableError: "reporting_unavailable",
    });
    if (merchant.response) return merchant.response;
    const report = await getMerchantReporting({
      db,
      shopId: merchant.shop.id,
      now,
      days,
      providerConfigured,
    });
    return jsonResponse(report);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(
      "Merchant reporting query failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return jsonResponse({ error: "reporting_unavailable" }, 503);
  }
}
