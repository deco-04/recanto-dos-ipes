-- Extend MsgChannel enum to cover the GHL conversation hub's social
-- channels: Facebook DM and Google Business Profile messaging.
-- Postgres requires ALTER TYPE ADD VALUE for enum extension.
ALTER TYPE "MsgChannel" ADD VALUE IF NOT EXISTS 'FACEBOOK';
ALTER TYPE "MsgChannel" ADD VALUE IF NOT EXISTS 'GBP';
