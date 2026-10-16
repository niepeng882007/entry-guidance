ALTER TABLE "entry_plan" ADD COLUMN "trustedCurrent" BOOLEAN NOT NULL DEFAULT false;
-- All pre-migration rows came from the strict generation endpoint in ticket 06.
UPDATE "entry_plan" SET "trustedCurrent" = true;

CREATE TABLE "entry_verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "planId" TEXT NOT NULL REFERENCES "entry_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "owner" JSONB NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "entry_verification_planId_createdAt_idx" ON "entry_verification"("planId", "createdAt");
