-- Prisma does not run a migration in a transaction and may fail to record a
-- statement that did commit; IF NOT EXISTS lets the migration run again after
-- `prisma migrate resolve --rolled-back`.
-- CreateIndex
CREATE INDEX IF NOT EXISTS "PendingSignal_createdAt_idx" ON "PendingSignal"("createdAt");
