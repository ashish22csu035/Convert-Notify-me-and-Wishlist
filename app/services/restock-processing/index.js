import applicationDb from "../../application-db.server.js";

const MAX_TRANSACTION_ATTEMPTS = 3;

function isVariantGid(value) {
  return (
    typeof value === "string" &&
    /^gid:\/\/shopify\/ProductVariant\/[0-9]{1,20}$/.test(value)
  );
}

function validateInput({ shopId, variantShopifyId, restockCycle, restockDetected }) {
  if (
    typeof shopId !== "string" ||
    shopId.length === 0 ||
    !isVariantGid(variantShopifyId) ||
    !Number.isSafeInteger(restockCycle) ||
    restockCycle < 0 ||
    typeof restockDetected !== "boolean" ||
    (restockDetected && restockCycle === 0)
  ) {
    throw new TypeError("Restock processing input is invalid");
  }
}

function skippedSummary(reason, restockCycle) {
  return {
    processed: false,
    reason,
    restockCycle,
    eligibleCount: 0,
    createdCount: 0,
    alreadyProcessedCount: 0,
  };
}

function isRetryableTransactionError(error) {
  return error?.code === "P2034";
}

export async function processRestock({
  db = applicationDb,
  shopId,
  variantShopifyId,
  restockCycle,
  restockDetected,
}) {
  validateInput({ shopId, variantShopifyId, restockCycle, restockDetected });

  if (!restockDetected) {
    return skippedSummary("restock_not_detected", restockCycle);
  }

  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        async (transactionDb) => {
          const confirmedRestock =
            await transactionDb.variantAvailability.findFirst({
              where: {
                shopId,
                variantShopifyId,
                restockCycle,
                previousAvailable: false,
                latestAvailable: true,
              },
              select: { id: true },
            });

          if (!confirmedRestock) {
            return skippedSummary("restock_not_confirmed", restockCycle);
          }

          const pendingRequests = await transactionDb.notifyRequest.findMany({
            where: {
              shopId,
              variantShopifyId,
              status: "PENDING",
            },
            select: { id: true },
          });

          if (pendingRequests.length === 0) {
            return {
              processed: true,
              reason: "no_eligible_requests",
              restockCycle,
              eligibleCount: 0,
              createdCount: 0,
              alreadyProcessedCount: 0,
            };
          }

          const result = await transactionDb.handoffJob.createMany({
            data: pendingRequests.map(({ id }) => ({
              notifyRequestId: id,
              idempotencyKey: `restock-cycle:${restockCycle}`,
              status: "PENDING",
              attempts: 0,
            })),
            skipDuplicates: true,
          });

          return {
            processed: true,
            reason: "restock_jobs_processed",
            restockCycle,
            eligibleCount: pendingRequests.length,
            createdCount: result.count,
            alreadyProcessedCount: pendingRequests.length - result.count,
          };
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (
        !isRetryableTransactionError(error) ||
        attempt === MAX_TRANSACTION_ATTEMPTS - 1
      ) {
        throw error;
      }
    }
  }

  throw new Error("Restock processing could not be completed");
}
