CREATE TABLE "binance_egress" (
  "id" TEXT PRIMARY KEY,
  "blockedUntil" TIMESTAMP(3) NOT NULL DEFAULT '1970-01-01',
  "activeId" TEXT,
  "activeUntil" TIMESTAMP(3) NOT NULL DEFAULT '1970-01-01',
  "nextArchiveAt" TIMESTAMP(3) NOT NULL DEFAULT '1970-01-01',
  "limitsAt" TIMESTAMP(3) NOT NULL DEFAULT '1970-01-01',
  "budgets" JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE "binance_read_request" (
  "id" TEXT PRIMARY KEY,
  "priority" TEXT NOT NULL CHECK ("priority" IN ('foreground', 'archive')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "binance_read_request_priority_createdAt_idx" ON "binance_read_request"("priority", "createdAt");
