-- ARGUS V2 Phase 4: bounded initial Entire Website discovery summary.
alter table public.scan_runs
  add column discovery_summary jsonb not null default '{}'::jsonb;
