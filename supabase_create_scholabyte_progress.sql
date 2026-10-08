-- Creates the scholabyte_progress table (one row per student/staff member's
-- ScholaByte progress: saved Textbook/CBT state + a summary for teachers).
-- Same id/data/updated_at shape and RLS lock-down as every other table:
-- only service_role (the app's server functions) can read/write it.

CREATE TABLE IF NOT EXISTS public.scholabyte_progress (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON TABLE public.scholabyte_progress TO service_role;
REVOKE ALL ON TABLE public.scholabyte_progress FROM anon, authenticated;

ALTER TABLE public.scholabyte_progress ENABLE ROW LEVEL SECURITY;
