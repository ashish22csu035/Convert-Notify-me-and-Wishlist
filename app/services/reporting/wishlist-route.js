import applicationDb from "../../application-db.server.js";
import { getWishlistAnalytics } from "./wishlist.js";
import { parseReportingDays } from "./window.js";
import { authenticateMerchantShop } from "./shop-auth.js";

function jsonResponse(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function loadWishlistAnalytics(
  request,
  { authenticateAdmin, db = applicationDb, now = new Date() } = {},
) {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  const { days, error: invalidDays } = parseReportingDays(
    new URL(request.url).searchParams,
  );
  if (invalidDays) return jsonResponse({ error: "invalid_reporting_days" }, 400);

  try {
    const merchant = await authenticateMerchantShop(request, {
      authenticateAdmin,
      db,
      unavailableError: "wishlist_analytics_unavailable",
    });
    if (merchant.response) return merchant.response;
    const report = await getWishlistAnalytics({
      db,
      admin: merchant.admin,
      shopId: merchant.shop.id,
      now,
      days,
    });
    return jsonResponse(report);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(
      "Wishlist analytics query failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return jsonResponse({ error: "wishlist_analytics_unavailable" }, 503);
  }
}
