-- Migration: Multi-agente
-- Eseguire con: psql $DATABASE_URL -f scripts/migrate_agents.sql

CREATE TABLE IF NOT EXISTS "Agent" (
  "id"           TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId"     TEXT         NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "name"         TEXT         NOT NULL,
  "description"  TEXT         NOT NULL DEFAULT '',
  "avatar"       TEXT,
  "isDefault"    BOOLEAN      NOT NULL DEFAULT false,
  "mainPrompt"   TEXT         NOT NULL DEFAULT '',
  "personality"  TEXT         NOT NULL DEFAULT '',
  "rules"        TEXT         NOT NULL DEFAULT '',
  "context"      TEXT         NOT NULL DEFAULT '',
  "instructions" TEXT         NOT NULL DEFAULT '',
  "createdAt"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Agent_tenantId_idx" ON "Agent"("tenantId");

CREATE TABLE IF NOT EXISTS "AgentVersion" (
  "id"           TEXT         NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "agentId"      TEXT         NOT NULL REFERENCES "Agent"("id") ON DELETE CASCADE,
  "tenantId"     TEXT         NOT NULL,
  "mainPrompt"   TEXT         NOT NULL DEFAULT '',
  "personality"  TEXT         NOT NULL DEFAULT '',
  "rules"        TEXT         NOT NULL DEFAULT '',
  "context"      TEXT         NOT NULL DEFAULT '',
  "instructions" TEXT         NOT NULL DEFAULT '',
  "savedBy"      TEXT,
  "note"         TEXT,
  "createdAt"    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "AgentVersion_agentId_createdAt_idx" ON "AgentVersion"("agentId", "createdAt");
CREATE INDEX IF NOT EXISTS "AgentVersion_tenantId_idx" ON "AgentVersion"("tenantId");

CREATE TABLE IF NOT EXISTS "ConversationAgent" (
  "conversationId" TEXT        NOT NULL PRIMARY KEY REFERENCES "Conversation"("id") ON DELETE CASCADE,
  "agentId"        TEXT        NOT NULL REFERENCES "Agent"("id") ON DELETE CASCADE,
  "assignedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "ExternalChatAgent" (
  "chatId"     TEXT        NOT NULL PRIMARY KEY REFERENCES "ExternalChat"("id") ON DELETE CASCADE,
  "agentId"    TEXT        NOT NULL REFERENCES "Agent"("id") ON DELETE CASCADE,
  "assignedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
