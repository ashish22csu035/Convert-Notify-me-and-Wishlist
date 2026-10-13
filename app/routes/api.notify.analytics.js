import applicationDb from "../application-db.server.js";
import { authenticate } from "../shopify.server.js";
import { handleNotifyClick } from "../services/analytics/notify-click.js";

export const loader = async () =>
  Response.json(
    { error: "method_not_allowed" },
    { status: 405, headers: { "Cache-Control": "no-store" } },
  );

export const action = ({ request }) =>
  handleNotifyClick(request, {
    applicationDb,
    authenticateProxy: (proxyRequest) =>
      authenticate.public.appProxy(proxyRequest),
  });
