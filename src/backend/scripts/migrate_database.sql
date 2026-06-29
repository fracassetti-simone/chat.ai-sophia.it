-- Migration: Modulo Database (v2 — aggiunta accessLevel)
-- Eseguire con: psql $DATABASE_URL -f scripts/migrate_database.sql

CREATE TABLE IF NOT EXISTS "DbSchema" (
  "id"                  TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId"            TEXT         NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "name"                TEXT         NOT NULL,
  "icon"                TEXT         NOT NULL DEFAULT 'server-outline',
  "showInSidebar"       BOOLEAN      NOT NULL DEFAULT false,
  "description"         TEXT         NOT NULL DEFAULT '',
  "accessLevel"         TEXT         NOT NULL DEFAULT 'admin',
  "defaultRecordAccess" TEXT         NOT NULL DEFAULT 'admin',
  "fields"              JSONB        NOT NULL DEFAULT '[]',
  "createdAt"           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updatedAt"           TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "DbSchema_tenantId_idx" ON "DbSchema"("tenantId");

-- Aggiungi colonne mancanti se la tabella esiste già
ALTER TABLE "DbSchema" ADD COLUMN IF NOT EXISTS "accessLevel"         TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE "DbSchema" ADD COLUMN IF NOT EXISTS "defaultRecordAccess" TEXT NOT NULL DEFAULT 'admin';

CREATE TABLE IF NOT EXISTS "DbRecord" (
  "id"          TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "schemaId"    TEXT         NOT NULL REFERENCES "DbSchema"("id") ON DELETE CASCADE,
  "tenantId"    TEXT         NOT NULL,
  "data"        JSONB        NOT NULL DEFAULT '{}',
  "accessLevel" TEXT         NOT NULL DEFAULT 'admin',
  "accessUsers" JSONB        NOT NULL DEFAULT '[]',
  "createdAt"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "DbRecord_schemaId_idx" ON "DbRecord"("schemaId");
CREATE INDEX IF NOT EXISTS "DbRecord_tenantId_idx" ON "DbRecord"("tenantId");

ALTER TABLE "DbRecord" ADD COLUMN IF NOT EXISTS "accessLevel" TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE "DbRecord" ADD COLUMN IF NOT EXISTS "accessUsers" JSONB NOT NULL DEFAULT '[]';
