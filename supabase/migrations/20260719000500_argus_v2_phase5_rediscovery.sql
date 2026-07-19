-- ARGUS V2 Phase 5: separate Entire Website rediscovery cadence and lifecycle writes.
alter table public.monitored_sites
  add column rediscovery_interval_seconds integer not null default 86400 check (rediscovery_interval_seconds >= 3600),
  add column next_rediscovery_at timestamptz,
  add column last_rediscovery_at timestamptz;
create index monitored_sites_rediscovery_due_idx on public.monitored_sites(state, next_rediscovery_at)
  where archived_at is null and mode = 'ENTIRE_WEBSITE' and state = 'ACTIVE';
update public.monitored_sites set next_rediscovery_at = clock_timestamp() + make_interval(secs => rediscovery_interval_seconds)
  where mode = 'ENTIRE_WEBSITE' and state = 'ACTIVE' and archived_at is null and next_rediscovery_at is null;

create or replace function public.argus_claim_due_entire_website_rediscoveries(p_limit integer default 2, p_lease_seconds integer default 300)
returns table (site_id uuid, scan_run_id uuid, lease_token uuid, normalized_root_url text, context_label text, rules jsonb)
language plpgsql security definer set search_path = public as $$
declare claimed record; token uuid; run_id uuid; next_due timestamptz;
begin
  if p_limit < 1 or p_limit > 10 then raise exception 'ARGUS_INVALID_BATCH_LIMIT'; end if;
  for claimed in select * from public.monitored_sites where mode = 'ENTIRE_WEBSITE' and discovery_enabled and state = 'ACTIVE' and archived_at is null and next_rediscovery_at is not null and next_rediscovery_at <= clock_timestamp() and (scan_lease_until is null or scan_lease_until <= clock_timestamp()) order by next_rediscovery_at limit p_limit for update skip locked loop
    token := gen_random_uuid(); next_due := claimed.next_rediscovery_at;
    while next_due <= clock_timestamp() loop next_due := next_due + make_interval(secs => claimed.rediscovery_interval_seconds); end loop;
    insert into public.scan_runs (site_id, trigger, status, idempotency_key, scheduled_for, started_at, retry_count) values (claimed.id, 'SCHEDULED', 'RUNNING', 'rediscovery:' || claimed.id::text || ':' || extract(epoch from claimed.next_rediscovery_at)::bigint::text || ':' || claimed.retry_count::text, claimed.next_rediscovery_at, clock_timestamp(), claimed.retry_count) returning id into run_id;
    update public.monitored_sites set scan_lease_token = token, scan_lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds), next_rediscovery_at = next_due where id = claimed.id;
    site_id := claimed.id; scan_run_id := run_id; lease_token := token; normalized_root_url := claimed.normalized_root_url; context_label := claimed.context_label; rules := claimed.rules; return next;
  end loop;
end; $$;
create or replace function public.argus_complete_entire_website_rediscovery(p_site_id uuid, p_scan_run_id uuid, p_lease_token uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.scan_runs where id = p_scan_run_id and site_id = p_site_id and status in ('SUCCEEDED','PARTIAL')) then raise exception 'ARGUS_SCAN_NOT_COMPLETE'; end if;
  update public.monitored_sites set last_rediscovery_at = clock_timestamp(), last_scan_at = clock_timestamp(), scan_lease_until = null, scan_lease_token = null, retry_count = 0, last_error_code = null, last_error_message = null, last_error_at = null where id = p_site_id and mode = 'ENTIRE_WEBSITE' and scan_lease_token = p_lease_token;
  if not found then raise exception 'ARGUS_LEASE_NOT_OWNED'; end if;
end; $$;
create or replace function public.argus_fail_entire_website_rediscovery(p_site_id uuid, p_scan_run_id uuid, p_lease_token uuid, p_error_code text default 'REDISCOVERY_FAILED')
returns void language plpgsql security definer set search_path = public as $$
declare next_retry integer;
begin
  select retry_count + 1 into next_retry from public.monitored_sites where id = p_site_id and mode = 'ENTIRE_WEBSITE' and scan_lease_token = p_lease_token for update;
  if next_retry is null then raise exception 'ARGUS_LEASE_NOT_OWNED'; end if;
  update public.scan_runs set status = 'FAILED', completed_at = clock_timestamp(), error_code = left(coalesce(p_error_code, 'REDISCOVERY_FAILED'), 80), redacted_error = 'Entire Website rediscovery failed; existing inventory was retained.' where id = p_scan_run_id and site_id = p_site_id and status = 'RUNNING';
  update public.monitored_sites set scan_lease_until = null, scan_lease_token = null, retry_count = next_retry, next_rediscovery_at = clock_timestamp() + make_interval(secs => least(3600, 60 * (2 ^ least(next_retry - 1, 6))::integer)), last_error_code = left(p_error_code, 80), last_error_message = 'Entire Website rediscovery failed; existing inventory was retained.', last_error_at = clock_timestamp() where id = p_site_id;
end; $$;
create or replace function public.argus_record_page_lifecycle(p_page_id uuid, p_scan_run_id uuid, p_lifecycle public.argus_page_lifecycle, p_missing_count integer, p_redirect_target_url text default null, p_health jsonb default '{}'::jsonb, p_event_type public.argus_event_type default null, p_before_snapshot_id uuid default null, p_after_snapshot_id uuid default null, p_evidence jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.monitored_pages; s public.monitored_sites; e public.change_events;
begin
  select * into p from public.monitored_pages where id = p_page_id for update; if p.id is null then raise exception 'ARGUS_PAGE_NOT_FOUND'; end if;
  select * into s from public.monitored_sites where id = p.site_id;
  update public.monitored_pages set lifecycle = p_lifecycle, consecutive_missing_count = greatest(0, p_missing_count), redirect_target_url = p_redirect_target_url, health = coalesce(p_health, '{}'::jsonb), last_checked_at = clock_timestamp() where id = p_page_id;
  if p_event_type is not null then insert into public.change_events (workspace_id, site_id, page_id, scan_run_id, event_type, before_snapshot_id, after_snapshot_id, evidence, occurred_at) values (s.workspace_id, p.site_id, p_page_id, p_scan_run_id, p_event_type, p_before_snapshot_id, p_after_snapshot_id, coalesce(p_evidence, '{}'::jsonb), clock_timestamp()) on conflict do nothing returning * into e; end if;
  return jsonb_build_object('event', case when e.id is null then null else to_jsonb(e) end);
end; $$;
revoke all on function public.argus_claim_due_entire_website_rediscoveries(integer, integer) from public;
revoke all on function public.argus_complete_entire_website_rediscovery(uuid, uuid, uuid) from public;
revoke all on function public.argus_fail_entire_website_rediscovery(uuid, uuid, uuid, text) from public;
revoke all on function public.argus_record_page_lifecycle(uuid, uuid, public.argus_page_lifecycle, integer, text, jsonb, public.argus_event_type, uuid, uuid, jsonb) from public;
grant execute on function public.argus_claim_due_entire_website_rediscoveries(integer, integer) to service_role;
grant execute on function public.argus_complete_entire_website_rediscovery(uuid, uuid, uuid) to service_role;
grant execute on function public.argus_fail_entire_website_rediscovery(uuid, uuid, uuid, text) to service_role;
grant execute on function public.argus_record_page_lifecycle(uuid, uuid, public.argus_page_lifecycle, integer, text, jsonb, public.argus_event_type, uuid, uuid, jsonb) to service_role;
