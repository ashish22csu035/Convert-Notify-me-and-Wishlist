import { authenticate } from "../shopify.server.js";
import applicationDb from "../application-db.server.js";
import { readFeatureSettings } from "../services/settings.server.js";

export async function loader({ request }) {
  let context;
  try {
    context = await authenticate.public.appProxy(request);
  } catch {
    return Response.json({ error: "unauthenticated" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const url = new URL(request.url);
  const signedShop = url.searchParams.get("shop")?.toLowerCase();
  const sessionShop = context.session?.shop?.toLowerCase();
  if (!sessionShop || signedShop !== sessionShop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(sessionShop)) {
    return Response.json({ error: "shop_unverified" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const settings = await readFeatureSettings(applicationDb, sessionShop);
  return Response.json({ notifyEnabled: settings.notifyEnabled, wishlistEnabled: settings.wishlistEnabled }, {
    headers: { "Cache-Control": "no-store" },
  });
}
