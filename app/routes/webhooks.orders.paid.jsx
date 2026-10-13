import applicationDb from "../application-db.server";
import { authenticate } from "../shopify.server";
import { handlePaidOrderWebhook } from "../services/order-ingestion/route-handler.js";

export const action = ({ request }) =>
  handlePaidOrderWebhook(request, {
    applicationDb,
    authenticateWebhook: (webhookRequest) =>
      authenticate.webhook(webhookRequest),
  });
