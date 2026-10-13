import { runNotifyRestockWorker } from "../services/notify-restock-worker/index.js";
import { runNotifyPurchaseMatchingWorker } from "../services/purchase-matching/index.js";

export async function runScheduledNotifyRestockWorker() {
  const restock = await runNotifyRestockWorker({
    resolveAdmin: async (shopDomain) => {
      const { unauthenticated } = await import("../shopify.server.js");
      return unauthenticated.admin(shopDomain);
    },
  });
  const purchaseMatching = await runNotifyPurchaseMatchingWorker();
  const hasErrors = [restock, purchaseMatching].some((summary) =>
    ["failed", "completed_with_errors"].includes(summary.status),
  );

  return {
    ...restock,
    status: hasErrors ? "completed_with_errors" : restock.status,
    purchaseMatching,
  };
}
