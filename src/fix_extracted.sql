-- Fix campo extracted nella tabella Document
-- Imposta default stringa vuota e rende NOT NULL
ALTER TABLE "Document" ALTER COLUMN "extracted" SET DEFAULT '';
UPDATE "Document" SET "extracted" = '' WHERE "extracted" IS NULL;
ALTER TABLE "Document" ALTER COLUMN "extracted" SET NOT NULL;
