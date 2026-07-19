-- ARGUS V2 Phase 3: database-owned scheduling/lease primitives.
-- No cron job is enabled by this migration; deployment must configure Vault secrets first.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create or replace function public.argus_configure_specific_page_schedule(p_site_id uuid, p_interval_seconds integer default null)
returns public.monitored_sites language plpgsql security definer set search_path = public as $$
declare updated_site public.monitored_sites;
begin
  if p_interval_seconds is not null and p_interval_seconds not in (900, 1800, 3600, 14400) then raise exception 'ARGUS_INVALID_INTERVAL'; end if;
  update public.monitored_sites set interval_seconds = coalesce(p_interval_seconds, interval_seconds), next_check_at = case when p_interval_seconds is null then null else clock_timestamp() + make_interval(secs => p_interval_seconds) end, retry_count = 0, last_error_code = null, last_error_message = null, last_error_at = null
  where id = p_site_id and mode = 'SPECIFIC_PAGE' and archived_at is null returning * into updated_site;
  if updated_site.id is null then raise exception 'ARGUS_SITE_NOT_FOUND'; end if;
  return updated_site;
end;
$$;

create or replace function public.argus_claim_due_specific_page_scans(p_limit integer default 5, p_lease_seconds integer default 300)
returns table (site_id uuid, page_id uuid, scan_run_id uuid, lease_token uuid, canonical_url text, context_label text, rules jsonb)
language plpgsql security definer set search_path = public, extensions as $$
declare claimed record; token uuid; run_id uuid; next_due timestamptz;
begin
  if p_limit < 1 or p_limit > 25 then raise exception 'ARGUS_INVALID_BATCH_LIMIT'; end if;
  for claimed in
    select s.*, p.id as claimed_page_id, p.canonical_url as claimed_url
    from public.monitored_sites s
    join public.monitored_pages p on p.site_id = s.id and p.archived_at is null
    where s.mode = 'SPECIFIC_PAGE' and s.state = 'ACTIVE' and s.archived_at is null
      and s.next_check_at is not null and s.next_check_at <= clock_timestamp()
      and (s.scan_lease_until is null or s.scan_lease_until <= clock_timestamp())
    order by s.next_check_at
    limit p_limit
    for update of s skip locked
  loop
    token := gen_random_uuid();
    next_due := claimed.next_check_at;
    while next_due <= clock_timestamp() loop next_due := next_due + make_interval(secs => claimed.interval_seconds); end loop;
    insert into public.scan_runs (site_id, trigger, status, idempotency_key, scheduled_for, started_at, pages_attempted, retry_count)
    values (claimed.id, 'SCHEDULED', 'RUNNING', 'scheduled:' || claimed.id::text || ':' || extract(epoch from claimed.next_check_at)::bigint::text || ':' || claimed.retry_count::text, claimed.next_check_at, clock_timestamp(), 1, claimed.retry_count)
    returning id into run_id;
    update public.monitored_sites set scan_lease_token = token, scan_lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds), next_check_at = next_due where id = claimed.id;
    site_id := claimed.id; page_id := claimed.claimed_page_id; scan_run_id := run_id; lease_token := token; canonical_url := claimed.claimed_url; context_label := claimed.context_label; rules := claimed.rules; return next;
  end loop;
end;
$$;

create or replace function public.argus_complete_scheduled_scan(p_site_id uuid, p_scan_run_id uuid, p_lease_token uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.scan_runs where id = p_scan_run_id and site_id = p_site_id and status = 'SUCCEEDED') then raise exception 'ARGUS_SCAN_NOT_SUCCEEDED'; end if;
  update public.monitored_sites set last_scan_at = clock_timestamp(), scan_lease_until = null, scan_lease_token = null, retry_count = 0, last_error_code = null, last_error_message = null, last_error_at = null
  where id = p_site_id and scan_lease_token = p_lease_token;
  if not found then raise exception 'ARGUS_LEASE_NOT_OWNED'; end if;
end;
$$;

create or replace function public.argus_fail_scheduled_scan(p_site_id uuid, p_scan_run_id uuid, p_lease_token uuid, p_error_code text default 'CHECK_FAILED')
returns void language plpgsql security definer set search_path = public as $$
declare next_retry integer; retry_delay integer;
begin
  select retry_count + 1 into next_retry from public.monitored_sites where id = p_site_id and scan_lease_token = p_lease_token for update;
  if next_retry is null then raise exception 'ARGUS_LEASE_NOT_OWNED'; end if;
  retry_delay := least(3600, 60 * (2 ^ least(next_retry - 1, 6))::integer) + floor(random() * 30)::integer;
  update public.monitored_sites set scan_lease_until = null, scan_lease_token = null, retry_count = next_retry, next_check_at = clock_timestamp() + make_interval(secs => retry_delay), last_error_code = left(coalesce(p_error_code, 'CHECK_FAILED'), 80), last_error_message = 'Scheduled check failed; the previous successful snapshot was retained.', last_error_at = clock_timestamp() where id = p_site_id;
end;
$$;

create or replace function public.argus_enable_phase3_scheduler()
returns void language plpgsql security definer set search_path = public, extensions, vault, cron as $$
declare scheduler_url text; scheduler_secret text;
begin
  select decrypted_secret into scheduler_url from vault.decrypted_secrets where name = 'argus_scheduler_url' limit 1;
  select decrypted_secret into scheduler_secret from vault.decrypted_secrets where name = 'argus_cron_secret' limit 1;
  if scheduler_url is null or scheduler_secret is null then raise exception 'ARGUS_SCHEDULER_VAULT_SECRETS_MISSING'; end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'argus-phase3-minute-dispatch';
  perform cron.schedule('argus-phase3-minute-dispatch', '* * * * *', format($job$
    select net.http_post(url := %L, headers := jsonb_build_object('Content-Type', 'application/json', 'x-argus-cron-secret', %L), body := '{}'::jsonb);
  $job$, scheduler_url, scheduler_secret));
end;
$$;

create or replace function public.argus_disable_phase3_scheduler()
returns void language plpgsql security definer set search_path = public, cron as $$
begin perform cron.unschedule(jobid) from cron.job where jobname = 'argus-phase3-minute-dispatch'; end;
$$;

revoke all on function public.argus_claim_due_specific_page_scans(integer, integer) from public;
revoke all on function public.argus_configure_specific_page_schedule(uuid, integer) from public;
revoke all on function public.argus_complete_scheduled_scan(uuid, uuid, uuid) from public;
revoke all on function public.argus_fail_scheduled_scan(uuid, uuid, uuid, text) from public;
revoke all on function public.argus_enable_phase3_scheduler() from public;
revoke all on function public.argus_disable_phase3_scheduler() from public;
grant execute on function public.argus_claim_due_specific_page_scans(integer, integer) to service_role;
grant execute on function public.argus_configure_specific_page_schedule(uuid, integer) to service_role;
grant execute on function public.argus_complete_scheduled_scan(uuid, uuid, uuid) to service_role;
grant execute on function public.argus_fail_scheduled_scan(uuid, uuid, uuid, text) to service_role;
grant execute on function public.argus_enable_phase3_scheduler() to service_role;
grant execute on function public.argus_disable_phase3_scheduler() to service_role;
