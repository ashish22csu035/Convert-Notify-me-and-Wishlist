import { ingestPaidOrderWebhook } from "./index.js";

export async function handlePaidOrderWebhook(
  request,
  { applicationDb, authenticateWebhook },
) {
  const {
    admin,
    payload,
    shop,
    topic,
    triggeredAt,
    webhookId,
  } = await authenticateWebhook(request);

  await ingestPaidOrderWebhook({
    admin,
    applicationDb,
    payload,
    shopDomain: shop,
    topic,
    triggeredAt,
    webhookId,
  });

  return new Response(null, { status: 200 });
}
