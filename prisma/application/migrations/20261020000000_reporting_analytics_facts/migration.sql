ALTER TABLE `AnalyticsEvent`
    MODIFY `type` ENUM(
        'NOTIFY_REQUEST_CREATED',
        'NOTIFY_SENT',
        'NOTIFY_CLICKED',
        'RESTOCK_DETECTED',
        'HANDOFF_ACCEPTED',
        'HANDOFF_FAILED',
        'WISHLIST_ENTRY_CREATED',
        'WISHLIST_ENTRY_REMOVED',
        'PRODUCT_VIEWED',
        'ORDER_PLACED'
    ) NOT NULL,
    ADD COLUMN `verifiedCustomerShopifyId` VARCHAR(128) NULL,
    ADD COLUMN `orderShopifyId` VARCHAR(128) NULL,
    ADD COLUMN `sourceSurface` VARCHAR(64) NULL,
    ADD COLUMN `restockCycle` INTEGER NULL,
    ADD INDEX `AnalyticsEvent_shopId_verifiedCustomerShopifyId_occurredAt_idx` (`shopId`, `verifiedCustomerShopifyId`, `occurredAt`),
    ADD INDEX `AnalyticsEvent_shopId_sourceSurface_occurredAt_idx` (`shopId`, `sourceSurface`, `occurredAt`),
    ADD INDEX `AnalyticsEvent_shopId_variantShopifyId_restockCycle_idx` (`shopId`, `variantShopifyId`, `restockCycle`),
    ADD INDEX `AnalyticsEvent_shopId_orderShopifyId_idx` (`shopId`, `orderShopifyId`);
