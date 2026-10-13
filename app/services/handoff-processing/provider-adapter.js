export const providerAdapter = {
  configured: false,
  async sendRestockNotification() {
    return {
      outcome: "permanent_failure",
      errorCode: "provider_not_configured",
    };
  },
};
