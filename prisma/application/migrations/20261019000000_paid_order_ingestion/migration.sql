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
    INDEX `PaidOrderEvent_shopId_verifiedCustomerShopifyId_paidAt_idx` (`shopId`, `verifiedCustomerShopifyId`, `paidAt`),
    INDEX `PaidOrderEvent_shopId_customerEmailDeduplicationKey_paidAt_idx` (`shopId`, `customerEmailDeduplicationKey`, `paidAt`),
    INDEX `PaidOrderEvent_shopId_customerPhoneDeduplicationKey_paidAt_idx` (`shopId`, `customerPhoneDeduplicationKey`, `paidAt`),
    UNIQUE INDEX `PaidOrderEvent_shopId_shopifyWebhookId_key` (`shopId`, `shopifyWebhookId`),
    UNIQUE INDEX `PaidOrderEvent_shopId_orderShopifyId_key` (`shopId`, `orderShopifyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PaidOrderLine` (
    `id` VARCHAR(191) NOT NULL,
    `paidOrderEventId` VARCHAR(191) NOT NULL,
    `orderLineShopifyId` VARCHAR(128) NOT NULL,
    `productShopifyId` VARCHAR(128) NULL,
    `variantShopifyId` VARCHAR(128) NULL,
    INDEX `PaidOrderLine_productShopifyId_idx` (`productShopifyId`),
    INDEX `PaidOrderLine_variantShopifyId_idx` (`variantShopifyId`),
    UNIQUE INDEX `PaidOrderLine_paidOrderEventId_orderLineShopifyId_key` (`paidOrderEventId`, `orderLineShopifyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PaidOrderEvent`
    ADD CONSTRAINT `PaidOrderEvent_shopId_fkey`
    FOREIGN KEY (`shopId`) REFERENCES `Shop`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `PaidOrderLine`
    ADD CONSTRAINT `PaidOrderLine_paidOrderEventId_fkey`
    FOREIGN KEY (`paidOrderEventId`) REFERENCES `PaidOrderEvent`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
