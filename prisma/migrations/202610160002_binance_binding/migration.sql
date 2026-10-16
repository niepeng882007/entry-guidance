-- CreateTable
CREATE TABLE "binance_binding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'binance-live',
    "uid" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "authorizationVersion" INTEGER NOT NULL DEFAULT 1,
    "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    "keyVersion" INTEGER NOT NULL,
    "sealedCredential" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "binance_binding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "binding_mutation" (
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "binding_mutation_pkey" PRIMARY KEY ("userId","requestId")
);

-- CreateIndex
CREATE INDEX "binance_binding_userId_idx" ON "binance_binding"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "binance_binding_source_uid_key" ON "binance_binding"("source", "uid");

-- AddForeignKey
ALTER TABLE "binance_binding" ADD CONSTRAINT "binance_binding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "binding_mutation" ADD CONSTRAINT "binding_mutation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE UNIQUE INDEX "binance_binding_one_active_user" ON "binance_binding"("userId") WHERE "state" = 'active';
ALTER TABLE "binance_binding" ADD CONSTRAINT "binance_binding_source" CHECK ("source" = 'binance-live');
ALTER TABLE "binance_binding" ADD CONSTRAINT "binance_binding_state" CHECK ("state" IN ('active', 'archived'));
ALTER TABLE "binance_binding" ADD CONSTRAINT "binance_binding_versions" CHECK ("authorizationVersion" > 0 AND "credentialVersion" > 0 AND "keyVersion" > 0);
