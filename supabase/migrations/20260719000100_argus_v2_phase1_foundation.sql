-- ARGUS V2 Phase 1: persistent foundation only.
-- This migration creates no cron jobs, workers, crawlers, or browser-facing DB APIs.

create extension if not exists pgcrypto;

create type public.argus_site_mode as enum ('SPECIFIC_PAGE', 'ENTIRE_WEBSITE');
create type public.argus_site_state as enum ('DISCOVERING', 'ACTIVE', 'PAUSED', 'ERRORED', 'ARCHIVED');
create type public.argus_page_lifecycle as enum ('DISCOVERED', 'BASELINING', 'ACTIVE', 'CHANGED', 'UNREACHABLE', 'MISSING_CANDIDATE', 'REMOVED', 'REDIRECTED', 'IGNORED');
create type public.argus_scan_status as enum ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED');
create type public.argus_scan_trigger as enum ('MANUAL', 'SCHEDULED', 'INITIAL');
create type public.argus_event_type as enum ('CONTENT_CHANGED', 'NEW_PAGE', 'REMOVED_PAGE', 'REDIRECTED', 'REAPPEARED', 'TITLE_METADATA_CHANGED', 'STRUCTURE_CHANGED');
create type public.argus_severity as enum ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
create type public.argus_intelligence_kind as enum ('DETERMINISTIC', 'AI_ROLLUP');
create type public.argus_subscription_channel as enum ('IN_APP', 'EMAIL', 'WEB_PUSH');
create type public.argus_subscription_status as enum ('PENDING', 'VERIFIED', 'DISABLED', 'REVOKED');
create type public.argus_outbox_status as enum ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'CANCELLED');

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete set null,
  name text not null check (char_length(name) between 1 and 120),
  plan text not null default 'free' check (plan in ('free', 'pro', 'team')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table public.monitored_sites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  normalized_root_url text not null check (char_length(normalized_root_url) <= 2048),
  display_root_url text not null check (char_length(display_root_url) <= 2048),
  mode public.argus_site_mode not null,
  context_label text not null default '' check (char_length(context_label) <= 240),
  state public.argus_site_state not null default 'DISCOVERING',
  interval_seconds integer not null default 3600 check (interval_seconds in (900, 1800, 3600, 14400)),
  rules jsonb not null default '{}'::jsonb,
  discovery_enabled boolean not null default false,
  next_check_at timestamptz,
  last_scan_at timestamptz,
  scan_lease_until timestamptz,
  scan_lease_token uuid,
  retry_count integer not null default 0 check (retry_count >= 0),
  last_error_code text check (char_length(last_error_code) <= 80),
  last_error_message text check (char_length(last_error_message) <= 2000),
  last_error_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint monitored_sites_mode_discovery_check check (
    (mode = 'SPECIFIC_PAGE' and discovery_enabled = false) or mode = 'ENTIRE_WEBSITE'
  )
);
create unique index monitored_sites_workspace_root_mode_active_key on public.monitored_sites(workspace_id, normalized_root_url, mode) where archived_at is null;
create index monitored_sites_due_idx on public.monitored_sites(state, next_check_at) where archived_at is null and state in ('DISCOVERING', 'ACTIVE');
create index monitored_sites_workspace_idx on public.monitored_sites(workspace_id, created_at desc);

create table public.monitored_pages (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.monitored_sites(id) on delete cascade,
  canonical_url text not null check (char_length(canonical_url) <= 2048),
  canonical_url_hash text not null check (char_length(canonical_url_hash) between 32 and 128),
  title text check (char_length(title) <= 1000),
  lifecycle public.argus_page_lifecycle not null default 'DISCOVERED',
  discovery_source text check (char_length(discovery_source) <= 80),
  discovery_evidence jsonb not null default '{}'::jsonb,
  redirect_target_url text check (char_length(redirect_target_url) <= 2048),
  last_http_status integer check (last_http_status between 100 and 599),
  last_success_at timestamptz,
  last_checked_at timestamptz,
  consecutive_missing_count integer not null default 0 check (consecutive_missing_count >= 0),
  health jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (site_id, canonical_url_hash)
);
create index monitored_pages_site_lifecycle_idx on public.monitored_pages(site_id, lifecycle) where archived_at is null;

create table public.scan_runs (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.monitored_sites(id) on delete cascade,
  trigger public.argus_scan_trigger not null,
  status public.argus_scan_status not null default 'QUEUED',
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  scheduled_for timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  pages_attempted integer not null default 0 check (pages_attempted >= 0),
  pages_succeeded integer not null default 0 check (pages_succeeded >= 0),
  pages_changed integer not null default 0 check (pages_changed >= 0),
  pages_new integer not null default 0 check (pages_new >= 0),
  pages_removed integer not null default 0 check (pages_removed >= 0),
  pages_failed integer not null default 0 check (pages_failed >= 0),
  gemini_calls integer not null default 0 check (gemini_calls >= 0),
  retry_count integer not null default 0 check (retry_count >= 0),
  error_code text check (char_length(error_code) <= 80),
  redacted_error text check (char_length(redacted_error) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, idempotency_key)
);
create index scan_runs_site_created_idx on public.scan_runs(site_id, created_at desc);
create index scan_runs_status_idx on public.scan_runs(status, scheduled_for);

create table public.page_snapshots (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.monitored_pages(id) on delete cascade,
  scan_run_id uuid references public.scan_runs(id) on delete set null,
  content_hash text not null check (char_length(content_hash) between 32 and 128),
  normalized_text text not null check (octet_length(normalized_text) <= 262144),
  title text check (char_length(title) <= 1000),
  metadata_hash text check (char_length(metadata_hash) between 32 and 128),
  navigation_hash text check (char_length(navigation_hash) between 32 and 128),
  is_current boolean not null default false,
  is_changed_revision boolean not null default false,
  observed_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (page_id, content_hash)
);
create unique index page_snapshots_one_current_per_page on public.page_snapshots(page_id) where is_current;
create index page_snapshots_retention_idx on public.page_snapshots(expires_at) where expires_at is not null;
create index page_snapshots_page_observed_idx on public.page_snapshots(page_id, observed_at desc);

create table public.change_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  site_id uuid not null references public.monitored_sites(id) on delete cascade,
  page_id uuid not null references public.monitored_pages(id) on delete cascade,
  scan_run_id uuid references public.scan_runs(id) on delete set null,
  event_type public.argus_event_type not null,
  before_snapshot_id uuid references public.page_snapshots(id) on delete set null,
  after_snapshot_id uuid references public.page_snapshots(id) on delete set null,
  evidence jsonb not null default '{}'::jsonb,
  deterministic_metrics jsonb not null default '{}'::jsonb,
  compact_diff text check (octet_length(compact_diff) <= 20000),
  summary text check (char_length(summary) <= 2000),
  severity public.argus_severity,
  areas_affected jsonb not null default '[]'::jsonb,
  recommended_action text check (char_length(recommended_action) <= 2000),
  reasoning text check (char_length(reasoning) <= 4000),
  read_at timestamptz,
  occurred_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index change_events_page_type_snapshot_key on public.change_events(page_id, event_type, coalesce(before_snapshot_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(after_snapshot_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index change_events_workspace_unread_idx on public.change_events(workspace_id, read_at, occurred_at desc);
create index change_events_site_occurred_idx on public.change_events(site_id, occurred_at desc);
create index change_events_retention_idx on public.change_events(expires_at) where expires_at is not null;

create table public.site_intelligence (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.monitored_sites(id) on delete cascade,
  scan_run_id uuid references public.scan_runs(id) on delete set null,
  kind public.argus_intelligence_kind not null,
  payload jsonb not null default '{}'::jsonb,
  summary text check (char_length(summary) <= 4000),
  generated_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (site_id, scan_run_id, kind)
);
create index site_intelligence_site_generated_idx on public.site_intelligence(site_id, generated_at desc);

create table public.notification_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  site_id uuid references public.monitored_sites(id) on delete cascade,
  channel public.argus_subscription_channel not null,
  status public.argus_subscription_status not null default 'PENDING',
  minimum_severity public.argus_severity not null default 'MEDIUM',
  endpoint_reference text not null default '' check (char_length(endpoint_reference) <= 2000),
  credential_reference text check (char_length(credential_reference) <= 2000),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, site_id, channel, endpoint_reference)
);
create index notification_subscriptions_workspace_idx on public.notification_subscriptions(workspace_id, status);

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  change_event_id uuid not null references public.change_events(id) on delete cascade,
  subscription_id uuid references public.notification_subscriptions(id) on delete set null,
  channel public.argus_subscription_channel not null,
  status public.argus_outbox_status not null default 'PENDING',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  lease_until timestamptz,
  lease_token uuid,
  delivered_at timestamptz,
  provider_result jsonb not null default '{}'::jsonb,
  redacted_error text check (char_length(redacted_error) <= 2000),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (change_event_id, channel)
);
create index notification_outbox_due_idx on public.notification_outbox(status, next_attempt_at) where status in ('PENDING', 'FAILED');
create index notification_outbox_retention_idx on public.notification_outbox(expires_at) where expires_at is not null;

create or replace function public.argus_set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger workspaces_set_updated_at before update on public.workspaces for each row execute function public.argus_set_updated_at();
create trigger monitored_sites_set_updated_at before update on public.monitored_sites for each row execute function public.argus_set_updated_at();
create trigger monitored_pages_set_updated_at before update on public.monitored_pages for each row execute function public.argus_set_updated_at();
create trigger scan_runs_set_updated_at before update on public.scan_runs for each row execute function public.argus_set_updated_at();
create trigger notification_subscriptions_set_updated_at before update on public.notification_subscriptions for each row execute function public.argus_set_updated_at();
create trigger notification_outbox_set_updated_at before update on public.notification_outbox for each row execute function public.argus_set_updated_at();

alter table public.workspaces enable row level security;
alter table public.monitored_sites enable row level security;
alter table public.monitored_pages enable row level security;
alter table public.page_snapshots enable row level security;
alter table public.scan_runs enable row level security;
alter table public.change_events enable row level security;
alter table public.site_intelligence enable row level security;
alter table public.notification_subscriptions enable row level security;
alter table public.notification_outbox enable row level security;

create policy workspaces_owner_access on public.workspaces for all to authenticated using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy sites_workspace_owner_access on public.monitored_sites for all to authenticated using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = auth.uid())) with check (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = auth.uid()));
create policy pages_workspace_owner_access on public.monitored_pages for all to authenticated using (exists (select 1 from public.monitored_sites s join public.workspaces w on w.id = s.workspace_id where s.id = site_id and w.owner_user_id = auth.uid())) with check (exists (select 1 from public.monitored_sites s join public.workspaces w on w.id = s.workspace_id where s.id = site_id and w.owner_user_id = auth.uid()));
create policy snapshots_workspace_owner_access on public.page_snapshots for select to authenticated using (exists (select 1 from public.monitored_pages p join public.monitored_sites s on s.id = p.site_id join public.workspaces w on w.id = s.workspace_id where p.id = page_id and w.owner_user_id = auth.uid()));
create policy scans_workspace_owner_access on public.scan_runs for select to authenticated using (exists (select 1 from public.monitored_sites s join public.workspaces w on w.id = s.workspace_id where s.id = site_id and w.owner_user_id = auth.uid()));
create policy events_workspace_owner_access on public.change_events for all to authenticated using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = auth.uid())) with check (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = auth.uid()));
create policy intelligence_workspace_owner_access on public.site_intelligence for select to authenticated using (exists (select 1 from public.monitored_sites s join public.workspaces w on w.id = s.workspace_id where s.id = site_id and w.owner_user_id = auth.uid()));
create policy subscriptions_workspace_owner_access on public.notification_subscriptions for all to authenticated using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = auth.uid())) with check (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_user_id = auth.uid()));
create policy outbox_workspace_owner_access on public.notification_outbox for select to authenticated using (exists (select 1 from public.change_events e join public.workspaces w on w.id = e.workspace_id where e.id = change_event_id and w.owner_user_id = auth.uid()));

-- Phase 1 health RPC: returns no credentials, table data, or privileged details.
create or replace function public.argus_database_health()
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('ok', true, 'database', 'connected');
$$;
revoke all on function public.argus_database_health() from public;
grant execute on function public.argus_database_health() to service_role;
