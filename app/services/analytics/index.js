export async function createAnalyticsEventOnce(transactionDb, data) {
  try {
    const event = await transactionDb.analyticsEvent.create({ data });
    return { created: true, event };
  } catch (error) {
    if (error?.code === "P2002") {
      return { created: false, duplicate: true };
    }
    throw error;
  }
}
