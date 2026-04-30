-- Soft-delete for inbox conversations. Adds DELETED to ConversationStatus
-- so staff can remove threads from the inbox without losing the underlying
-- message history. All GET endpoints filter status != 'DELETED'.
ALTER TYPE "ConversationStatus" ADD VALUE 'DELETED';
