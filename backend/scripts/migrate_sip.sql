-- Migration: aggiungi tabella SipClient
-- Eseguire con: psql $DATABASE_URL -f scripts/migrate_sip.sql

CREATE TABLE IF NOT EXISTS "SipClient" (
  "id"          TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId"    TEXT         NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "did"         TEXT         NOT NULL,
  "internal"    TEXT         NOT NULL DEFAULT '',
  "username"    TEXT         NOT NULL,
  "password"    TEXT         NOT NULL,
  "host"        TEXT         NOT NULL,
  "port"        INTEGER      NOT NULL DEFAULT 5060,
  "protocol"    TEXT         NOT NULL DEFAULT 'UDP',
  "useLocalIp"  BOOLEAN      NOT NULL DEFAULT false,
  "label"       TEXT,
  "createdAt"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "SipClient_tenantId_idx" ON "SipClient"("tenantId");
