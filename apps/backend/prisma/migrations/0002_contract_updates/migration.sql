-- DropIndex
DROP INDEX "ActivityLog_clientEventId_key";

-- AlterTable
ALTER TABLE "TenantPolicy" ADD COLUMN     "activeWindowOnly" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "excludedApps" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "mediaRetentionDays" INTEGER,
ADD COLUMN     "recordingBitrateKbps" INTEGER NOT NULL DEFAULT 1500,
ADD COLUMN     "recordingDailyCapMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "screenshotDailyCap" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_tenantId_idx" ON "RefreshToken"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityLog_deviceId_clientEventId_key" ON "ActivityLog"("deviceId", "clientEventId");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

