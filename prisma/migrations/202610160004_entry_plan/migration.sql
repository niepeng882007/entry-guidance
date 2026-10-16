CREATE TABLE "entry_plan" (
  "id" TEXT PRIMARY KEY,
  "bindingId" TEXT NOT NULL REFERENCES "binance_binding"("id") ON DELETE RESTRICT,
  "userId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "input" JSONB NOT NULL,
  "plan" JSONB NOT NULL,
  "owner" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "entry_plan_userId_bindingId_idx" ON "entry_plan"("userId", "bindingId");
