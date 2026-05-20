-- Per-move clock chosen by the challenge initiator.
--
-- Nullable so existing challenge rows continue to mean "use the
-- adapter default (30000ms = 30s)". New rows store one of:
--   15000  (15s/move)
--   30000  (30s/move — default)
--   45000  (45s/move)
--   60000  (60s/move)
-- Validation is enforced in the API layer; the DB column is intentionally
-- permissive (plain integer) so we can introduce more presets without a
-- migration.
ALTER TABLE challenges
  ADD COLUMN IF NOT EXISTS clock_budget_ms integer;
