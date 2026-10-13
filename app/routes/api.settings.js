import { authenticate } from "../shopify.server.js";
import applicationDb from "../application-db.server.js";
import { authenticateMerchantShop } from "../services/reporting/shop-auth.js";
import { getSettingsResponse, updateFeatureSettings } from "../services/settings.server.js";

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function merchant(request) {
  return authenticateMerchantShop(request, {
    authenticateAdmin: authenticate.admin,
    db: applicationDb,
  });
}

export async function loader({ request }) {
  const result = await merchant(request);
  if (result.response) return result.response;
  return json(await getSettingsResponse(applicationDb, result.shop));
}

export async function action({ request }) {
  if (request.method !== "PATCH") return json({ error: "method_not_allowed" }, 405);
  const result = await merchant(request);
  if (result.response) return result.response;
  if ((request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() !== "application/json") {
    return json({ error: "invalid_request" }, 400);
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > 4096) return json({ error: "invalid_request" }, 400);
  let body;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 4096) return json({ error: "invalid_request" }, 400);
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const saved = await updateFeatureSettings(applicationDb, result.shop, body);
  return saved ? json(saved) : json({ error: "invalid_settings" }, 400);
}
