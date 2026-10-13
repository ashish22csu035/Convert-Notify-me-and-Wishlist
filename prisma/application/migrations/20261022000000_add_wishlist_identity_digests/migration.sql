ALTER TABLE `AnalyticsEvent`
    ADD COLUMN `emailIdentityDigest` VARCHAR(64) NULL,
    ADD COLUMN `phoneIdentityDigest` VARCHAR(64) NULL;
