CREATE TABLE model_credential (
  "userId" TEXT PRIMARY KEY REFERENCES auth_user(id) ON DELETE RESTRICT,
  id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL CHECK (version > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  "sealedCredential" TEXT,
  "keyVersion" INTEGER,
  "verifiedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("userId", id),
  CHECK ((state = 'active' AND "sealedCredential" IS NOT NULL AND "keyVersion" IS NOT NULL AND "keyVersion" > 0 AND "verifiedAt" IS NOT NULL)
    OR (state = 'revoked' AND "sealedCredential" IS NULL AND "keyVersion" IS NULL))
);
CREATE TABLE model_key_invalidation (
  "userId" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  reason TEXT NOT NULL CHECK (reason IN ('replaced', 'revoked')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("credentialId", version),
  FOREIGN KEY ("userId", "credentialId") REFERENCES model_credential("userId", id) ON DELETE RESTRICT
);
CREATE TABLE model_key_mutation (
  "userId" TEXT NOT NULL REFERENCES auth_user(id) ON DELETE RESTRICT,
  "requestId" TEXT NOT NULL,
  digest TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "requestId")
);
