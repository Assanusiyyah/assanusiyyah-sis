-- Creates the chart_of_accounts table, matching the same id/data/updated_at
-- shape as every other table this app uses (see functions/api/db.js).
-- Includes the same RLS hardening applied to the rest of the schema:
-- service_role gets full access (used by the app's server-side functions),
-- RLS is enabled with no anon/authenticated policies, so this new table is
-- locked down the same way as everything else from the start.

CREATE TABLE IF NOT EXISTS public.chart_of_accounts (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON TABLE public.chart_of_accounts TO service_role;

ALTER TABLE public.chart_of_accounts ENABLE ROW LEVEL SECURITY;
