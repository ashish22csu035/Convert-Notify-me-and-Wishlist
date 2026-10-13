-- CreateTable
CREATE TABLE `Shop` (
    `id` VARCHAR(191) NOT NULL,
    `shopifyShopId` VARCHAR(128) NOT NULL,
    `domain` VARCHAR(255) NOT NULL,
    `notifyEnabled` BOOLEAN NOT NULL DEFAULT true,
    `wishlistEnabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Shop_shopifyShopId_key`(`shopifyShopId`),
    UNIQUE INDEX `Shop_domain_key`(`domain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NotifyRequest` (
    `id` VARCHAR(191) NOT NULL,
    `shopId` VARCHAR(191) NOT NULL,
    `productShopifyId` VARCHAR(128) NOT NULL,
    `variantShopifyId` VARCHAR(128) NOT NULL,
    `verifiedCustomerShopifyId` VARCHAR(128) NULL,
    `normalizedContact` VARCHAR(320) NOT NULL,
    `contactDeduplicationKey` VARCHAR(128) NOT NULL,
    `channel` ENUM('EMAIL', 'SMS') NOT NULL,
    `consentText` TEXT NOT NULL,
    `consentVersion` VARCHAR(64) NOT NULL,
    `consentedAt` DATETIME(3) NOT NULL,
    `source` ENUM('THEME_APP_EXTENSION', 'STOREFRONT', 'ADMIN', 'API', 'IMPORT') NOT NULL,
    `status` ENUM('PENDING', 'ACTIVE', 'NOTIFIED', 'CLOSED', 'UNSUBSCRIBED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `closedAt` DATETIME(3) NULL,

    INDEX `NotifyRequest_shopId_variantShopifyId_contactDeduplicationKe_idx`(`shopId`, `variantShopifyId`, `contactDeduplicationKey`, `status`),
    INDEX `NotifyRequest_shopId_productShopifyId_variantShopifyId_idx`(`shopId`, `productShopifyId`, `variantShopifyId`),
    INDEX `NotifyRequest_shopId_verifiedCustomerShopifyId_status_idx`(`shopId`, `verifiedCustomerShopifyId`, `status`),
    INDEX `NotifyRequest_shopId_status_createdAt_idx`(`shopId`, `status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WishlistEntry` (
    `id` VARCHAR(191) NOT NULL,
    `shopId` VARCHAR(191) NOT NULL,
    `verifiedCustomerShopifyId` VARCHAR(128) NOT NULL,
    `productShopifyId` VARCHAR(128) NOT NULL,
    `preferredVariantShopifyId` VARCHAR(128) NULL,
    `savedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `deactivatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `WishlistEntry_shopId_verifiedCustomerShopifyId_isActive_save_idx`(`shopId`, `verifiedCustomerShopifyId`, `isActive`, `savedAt`),
    INDEX `WishlistEntry_shopId_productShopifyId_isActive_idx`(`shopId`, `productShopifyId`, `isActive`),
    UNIQUE INDEX `WishlistEntry_shopId_verifiedCustomerShopifyId_productShopif_key`(`shopId`, `verifiedCustomerShopifyId`, `productShopifyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `VariantAvailability` (
    `id` VARCHAR(191) NOT NULL,
    `shopId` VARCHAR(191) NOT NULL,
    `productShopifyId` VARCHAR(128) NOT NULL,
    `variantShopifyId` VARCHAR(128) NOT NULL,
    `previousAvailable` BOOLEAN NULL,
    `latestAvailable` BOOLEAN NOT NULL,
    `lastCheckedAt` DATETIME(3) NOT NULL,
    `restockCycle` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `VariantAvailability_shopId_productShopifyId_idx`(`shopId`, `productShopifyId`),
    INDEX `VariantAvailability_shopId_latestAvailable_lastCheckedAt_idx`(`shopId`, `latestAvailable`, `lastCheckedAt`),
    UNIQUE INDEX `VariantAvailability_shopId_variantShopifyId_key`(`shopId`, `variantShopifyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HandoffJob` (
    `id` VARCHAR(191) NOT NULL,
    `notifyRequestId` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `retryAt` DATETIME(3) NULL,
    `providerReference` VARCHAR(191) NULL,
    `sanitizedErrorCode` VARCHAR(100) NULL,
    `sanitizedErrorMessage` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `HandoffJob_status_retryAt_idx`(`status`, `retryAt`),
    INDEX `HandoffJob_notifyRequestId_createdAt_idx`(`notifyRequestId`, `createdAt`),
    UNIQUE INDEX `HandoffJob_notifyRequestId_idempotencyKey_key`(`notifyRequestId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AnalyticsEvent` (
    `id` VARCHAR(191) NOT NULL,
    `shopId` VARCHAR(191) NOT NULL,
    `eventKey` VARCHAR(191) NOT NULL,
    `type` ENUM('NOTIFY_REQUEST_CREATED', 'NOTIFY_SENT', 'NOTIFY_CLICKED', 'WISHLIST_CLICKED', 'RESTOCK_DETECTED', 'HANDOFF_ACCEPTED', 'HANDOFF_FAILED', 'WISHLIST_ENTRY_CREATED', 'WISHLIST_ENTRY_REMOVED', 'PRODUCT_VIEWED', 'ORDER_PLACED') NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `productShopifyId` VARCHAR(128) NULL,
    `variantShopifyId` VARCHAR(128) NULL,
    `verifiedCustomerShopifyId` VARCHAR(128) NULL,
    `emailIdentityDigest` VARCHAR(64) NULL,
    `phoneIdentityDigest` VARCHAR(64) NULL,
    `notifyRequestId` VARCHAR(191) NULL,
    `wishlistEntryId` VARCHAR(191) NULL,
    `orderShopifyId` VARCHAR(128) NULL,
    `sourceSurface` VARCHAR(64) NULL,
    `restockCycle` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AnalyticsEvent_shopId_type_occurredAt_idx`(`shopId`, `type`, `occurredAt`),
    INDEX `AnalyticsEvent_shopId_productShopifyId_occurredAt_idx`(`shopId`, `productShopifyId`, `occurredAt`),
    INDEX `AnalyticsEvent_shopId_verifiedCustomerShopifyId_occurredAt_idx`(`shopId`, `verifiedCustomerShopifyId`, `occurredAt`),
    INDEX `AnalyticsEvent_shopId_sourceSurface_occurredAt_idx`(`shopId`, `sourceSurface`, `occurredAt`),
    INDEX `AnalyticsEvent_shopId_variantShopifyId_restockCycle_idx`(`shopId`, `variantShopifyId`, `restockCycle`),
    INDEX `AnalyticsEvent_shopId_orderShopifyId_idx`(`shopId`, `orderShopifyId`),
    INDEX `AnalyticsEvent_notifyRequestId_occurredAt_idx`(`notifyRequestId`, `occurredAt`),
    INDEX `AnalyticsEvent_wishlistEntryId_occurredAt_idx`(`wishlistEntryId`, `occurredAt`),
    UNIQUE INDEX `AnalyticsEvent_shopId_eventKey_key`(`shopId`, `eventKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaidOrderEvent` (
    `id` VARCHAR(191) NOT NULL,
    `shopId` VARCHAR(191) NOT NULL,
    `shopifyWebhookId` VARCHAR(191) NOT NULL,
    `orderShopifyId` VARCHAR(128) NOT NULL,
    `orderCreatedAt` DATETIME(3) NOT NULL,
    `paidAt` DATETIME(3) NULL,
    `verifiedCustomerShopifyId` VARCHAR(128) NULL,
    `customerEmailDeduplicationKey` VARCHAR(64) NULL,
    `customerPhoneDeduplicationKey` VARCHAR(64) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PaidOrderEvent_shopId_verifiedCustomerShopifyId_paidAt_idx`(`shopId`, `verifiedCustomerShopifyId`, `paidAt`),
    INDEX `PaidOrderEvent_shopId_customerEmailDeduplicationKey_paidAt_idx`(`shopId`, `customerEmailDeduplicationKey`, `paidAt`),
    INDEX `PaidOrderEvent_shopId_customerPhoneDeduplicationKey_paidAt_idx`(`shopId`, `customerPhoneDeduplicationKey`, `paidAt`),
    UNIQUE INDEX `PaidOrderEvent_shopId_shopifyWebhookId_key`(`shopId`, `shopifyWebhookId`),
    UNIQUE INDEX `PaidOrderEvent_shopId_orderShopifyId_key`(`shopId`, `orderShopifyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaidOrderLine` (
    `id` VARCHAR(191) NOT NULL,
    `paidOrderEventId` VARCHAR(191) NOT NULL,
    `orderLineShopifyId` VARCHAR(128) NOT NULL,
    `productShopifyId` VARCHAR(128) NULL,
    `variantShopifyId` VARCHAR(128) NULL,

    INDEX `PaidOrderLine_productShopifyId_idx`(`productShopifyId`),
    INDEX `PaidOrderLine_variantShopifyId_idx`(`variantShopifyId`),
    UNIQUE INDEX `PaidOrderLine_paidOrderEventId_orderLineShopifyId_key`(`paidOrderEventId`, `orderLineShopifyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderMatch` (
    `id` VARCHAR(191) NOT NULL,
    `shopId` VARCHAR(191) NOT NULL,
    `orderShopifyId` VARCHAR(128) NOT NULL,
    `orderLineShopifyId` VARCHAR(128) NULL,
    `paidOrderLineId` VARCHAR(191) NULL,
    `source` ENUM('NOTIFY_REQUEST', 'WISHLIST_ENTRY') NOT NULL,
    `notifyRequestId` VARCHAR(191) NULL,
    `wishlistEntryId` VARCHAR(191) NULL,
    `orderCreatedAt` DATETIME(3) NOT NULL,
    `paidAt` DATETIME(3) NULL,
    `matchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `orderTotal` DECIMAL(12, 2) NULL,
    `currencyCode` VARCHAR(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `OrderMatch_shopId_matchedAt_idx`(`shopId`, `matchedAt`),
    INDEX `OrderMatch_notifyRequestId_matchedAt_idx`(`notifyRequestId`, `matchedAt`),
    INDEX `OrderMatch_wishlistEntryId_matchedAt_idx`(`wishlistEntryId`, `matchedAt`),
    UNIQUE INDEX `OrderMatch_shopId_orderShopifyId_orderLineShopifyId_source_key`(`shopId`, `orderShopifyId`, `orderLineShopifyId`, `source`),
    UNIQUE INDEX `OrderMatch_paidOrderLineId_source_key`(`paidOrderLineId`, `source`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `NotifyRequest` ADD CONSTRAINT `NotifyRequest_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WishlistEntry` ADD CONSTRAINT `WishlistEntry_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `VariantAvailability` ADD CONSTRAINT `VariantAvailability_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HandoffJob` ADD CONSTRAINT `HandoffJob_notifyRequestId_fkey` FOREIGN KEY (`notifyRequestId`) REFERENCES `NotifyRequest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AnalyticsEvent` ADD CONSTRAINT `AnalyticsEvent_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AnalyticsEvent` ADD CONSTRAINT `AnalyticsEvent_notifyRequestId_fkey` FOREIGN KEY (`notifyRequestId`) REFERENCES `NotifyRequest`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AnalyticsEvent` ADD CONSTRAINT `AnalyticsEvent_wishlistEntryId_fkey` FOREIGN KEY (`wishlistEntryId`) REFERENCES `WishlistEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaidOrderEvent` ADD CONSTRAINT `PaidOrderEvent_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaidOrderLine` ADD CONSTRAINT `PaidOrderLine_paidOrderEventId_fkey` FOREIGN KEY (`paidOrderEventId`) REFERENCES `PaidOrderEvent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderMatch` ADD CONSTRAINT `OrderMatch_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderMatch` ADD CONSTRAINT `OrderMatch_paidOrderLineId_fkey` FOREIGN KEY (`paidOrderLineId`) REFERENCES `PaidOrderLine`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderMatch` ADD CONSTRAINT `OrderMatch_notifyRequestId_fkey` FOREIGN KEY (`notifyRequestId`) REFERENCES `NotifyRequest`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderMatch` ADD CONSTRAINT `OrderMatch_wishlistEntryId_fkey` FOREIGN KEY (`wishlistEntryId`) REFERENCES `WishlistEntry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

