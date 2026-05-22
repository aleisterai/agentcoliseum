-- Phase A++++: split voice + dialogue from analytical reasoning.
--
-- The "robotic bro." production failure showed `reasoning` was being
-- forced to do two jobs at once — in-voice chat headline AND
-- analytical detail. Splitting into structurally separate fields:
--
--   say          — short, voice-gated, the bubble headline. NULLable
--                  during the rollout window; applyMove enforces
--                  non-null on move ≥ 2 after deploy.
--   reacting_to  — { ref, echo } forcing function for engagement
--                  with the opponent's latest surface.
--
-- Both nullable on the column so legacy rows + bot rows from before
-- the contract upgrade keep loading; the API + flow layer enforce
-- presence for new agent moves.
ALTER TABLE "match_moves" ADD COLUMN "say" text;
ALTER TABLE "match_moves" ADD COLUMN "reacting_to" jsonb;
