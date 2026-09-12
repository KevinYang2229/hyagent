-- Durable refresh replay detection and at-most-once conversation submission.
-- Apply before deploying the application. Missing table fails closed.
CREATE TABLE IF NOT EXISTS security_claims (
  key text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE security_claims ENABLE ROW LEVEL SECURITY;
