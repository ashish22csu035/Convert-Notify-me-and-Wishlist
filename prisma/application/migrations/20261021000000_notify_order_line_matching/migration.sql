ALTER TABLE `ordermatch`
    DROP INDEX `OrderMatch_shopId_orderShopifyId_notifyRequestId_key`,
    DROP INDEX `OrderMatch_shopId_orderShopifyId_wishlistEntryId_key`,
    ADD COLUMN `orderLineShopifyId` VARCHAR(128) NULL,
    ADD COLUMN `paidOrderLineId` VARCHAR(191) NULL,
    ADD COLUMN `paidAt` DATETIME(3) NULL,
    ADD UNIQUE INDEX `OrderMatch_shopId_orderShopifyId_orderLineShopifyId_source_key`
        (`shopId`, `orderShopifyId`, `orderLineShopifyId`, `source`),
    ADD UNIQUE INDEX `OrderMatch_paidOrderLineId_source_key`
        (`paidOrderLineId`, `source`),
    ADD CONSTRAINT `OrderMatch_paidOrderLineId_fkey`
        FOREIGN KEY (`paidOrderLineId`) REFERENCES `PaidOrderLine`(`id`)
        ON DELETE SET NULL ON UPDATE CASCADE;
