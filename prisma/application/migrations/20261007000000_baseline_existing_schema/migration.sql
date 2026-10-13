-- CreateTable
CREATE TABLE `analyticsevent` (
    `id` VARCHAR(191) NOT NULL,
    `shopId` VARCHAR(191) NOT NULL,
    `eventKey` VARCHAR(191) NOT NULL,
    `type` ENUM('NOTIFY_REQUEST_CREATED', 'NOTIFY_SENT', 'NOTIFY_CLICKED', 'WISHLIST_ENTRY_CREATED', 'WISHLIST_ENTRY_REMOVED', 'PRODUCT_VIEWED', 'ORDER_PLACED') NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `productShopifyId` VARCHAR(128) NULL,
    `variantShopifyId` VARCHAR(128) NULL,
    `notifyRequestId` VARCHAR(191) NULL,
    `wishlistEntryId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AnalyticsEvent_notifyRequestId_occurredAt_idx`(`notifyRequestId` ASC, `occurredAt` ASC),
    UNIQUE INDEX `AnalyticsEvent_shopId_eventKey_key`(`shopId` ASC, `eventKey` ASC),
    INDEX `AnalyticsEvent_shopId_productShopifyId_occurredAt_idx`(`shopId` ASC, `productShopifyId` ASC, `occurredAt` ASC),
    INDEX `AnalyticsEvent_shopId_type_occurredAt_idx`(`shopId` ASC, `type` ASC, `occurredAt` ASC),
    INDEX `AnalyticsEvent_wishlistEntryId_occurredAt_idx`(`wishlistEntryId` ASC, `occurredAt` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `handoffjob` (
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

    INDEX `HandoffJob_notifyRequestId_createdAt_idx`(`notifyRequestId` ASC, `createdAt` ASC),
    UNIQUE INDEX `HandoffJob_notifyRequestId_idempotencyKey_key`(`notifyRequestId` ASC, `idempotencyKey` ASC),
    INDEX `HandoffJob_status_retryAt_idx`(`status` ASC, `retryAt` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifyrequest` (
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

    INDEX `NotifyRequest_shopId_productShopifyId_variantShopifyId_idx`(`shopId` ASC, `productShopifyId` ASC, `variantShopifyId` ASC),
    INDEX `NotifyRequest_shopId_status_createdAt_idx`(`shopId` ASC, `status` ASC, `createdAt` ASC),
    INDEX `NotifyRequest_shopId_variantShopifyId_contactDeduplicationKe_idx`(`shopId` ASC, `variantShopifyId` ASC, `contactDeduplicationKey` ASC, `status` ASC),
    INDEX `NotifyRequest_shopId_verifiedCustomerShopifyId_status_idx`(`shopId` ASC, `verifiedCustomerShopifyId` ASC, `status` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ordermatch` (
    `id` VARCHAR(191) NOT NULL,
    `shopId` VARCHAR(191) NOT NULL,
    `orderShopifyId` VARCHAR(128) NOT NULL,
    `source` ENUM('NOTIFY_REQUEST', 'WISHLIST_ENTRY') NOT NULL,
    `notifyRequestId` VARCHAR(191) NULL,
    `wishlistEntryId` VARCHAR(191) NULL,
    `orderCreatedAt` DATETIME(3) NOT NULL,
    `matchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `orderTotal` DECIMAL(12, 2) NULL,
    `currencyCode` VARCHAR(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `OrderMatch_notifyRequestId_matchedAt_idx`(`notifyRequestId` ASC, `matchedAt` ASC),
    INDEX `OrderMatch_shopId_matchedAt_idx`(`shopId` ASC, `matchedAt` ASC),
    UNIQUE INDEX `OrderMatch_shopId_orderShopifyId_notifyRequestId_key`(`shopId` ASC, `orderShopifyId` ASC, `notifyRequestId` ASC),
    UNIQUE INDEX `OrderMatch_shopId_orderShopifyId_wishlistEntryId_key`(`shopId` ASC, `orderShopifyId` ASC, `wishlistEntryId` ASC),
    INDEX `OrderMatch_wishlistEntryId_matchedAt_idx`(`wishlistEntryId` ASC, `matchedAt` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shop` (
    `id` VARCHAR(191) NOT NULL,
    `shopifyShopId` VARCHAR(128) NOT NULL,
    `domain` VARCHAR(255) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Shop_domain_key`(`domain` ASC),
    UNIQUE INDEX `Shop_shopifyShopId_key`(`shopifyShopId` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `variantavailability` (
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

    INDEX `VariantAvailability_shopId_latestAvailable_lastCheckedAt_idx`(`shopId` ASC, `latestAvailable` ASC, `lastCheckedAt` ASC),
    INDEX `VariantAvailability_shopId_productShopifyId_idx`(`shopId` ASC, `productShopifyId` ASC),
    UNIQUE INDEX `VariantAvailability_shopId_variantShopifyId_key`(`shopId` ASC, `variantShopifyId` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wishlistentry` (
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

    INDEX `WishlistEntry_shopId_productShopifyId_isActive_idx`(`shopId` ASC, `productShopifyId` ASC, `isActive` ASC),
    INDEX `WishlistEntry_shopId_verifiedCustomerShopifyId_isActive_save_idx`(`shopId` ASC, `verifiedCustomerShopifyId` ASC, `isActive` ASC, `savedAt` ASC),
    UNIQUE INDEX `WishlistEntry_shopId_verifiedCustomerShopifyId_productShopif_key`(`shopId` ASC, `verifiedCustomerShopifyId` ASC, `productShopifyId` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `analyticsevent` ADD CONSTRAINT `AnalyticsEvent_notifyRequestId_fkey` FOREIGN KEY (`notifyRequestId`) REFERENCES `notifyrequest`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `analyticsevent` ADD CONSTRAINT `AnalyticsEvent_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `analyticsevent` ADD CONSTRAINT `AnalyticsEvent_wishlistEntryId_fkey` FOREIGN KEY (`wishlistEntryId`) REFERENCES `wishlistentry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `handoffjob` ADD CONSTRAINT `HandoffJob_notifyRequestId_fkey` FOREIGN KEY (`notifyRequestId`) REFERENCES `notifyrequest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifyrequest` ADD CONSTRAINT `NotifyRequest_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ordermatch` ADD CONSTRAINT `OrderMatch_notifyRequestId_fkey` FOREIGN KEY (`notifyRequestId`) REFERENCES `notifyrequest`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ordermatch` ADD CONSTRAINT `OrderMatch_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ordermatch` ADD CONSTRAINT `OrderMatch_wishlistEntryId_fkey` FOREIGN KEY (`wishlistEntryId`) REFERENCES `wishlistentry`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `variantavailability` ADD CONSTRAINT `VariantAvailability_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wishlistentry` ADD CONSTRAINT `WishlistEntry_shopId_fkey` FOREIGN KEY (`shopId`) REFERENCES `shop`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
