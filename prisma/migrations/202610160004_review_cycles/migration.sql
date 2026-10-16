CREATE TABLE "review_cycle" (
    "bindingId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    CONSTRAINT "review_cycle_pkey" PRIMARY KEY ("bindingId", "source", "id"),
    CONSTRAINT "review_cycle_source" CHECK ("source" IN ('binance', 'demo')),
    CONSTRAINT "review_cycle_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "binance_binding"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
