-- ARGUS V2 Phase 2: one explicit unauthenticated demo workspace plus atomic page commits.
create unique index workspaces_argus_default_workspace_key
  on public.workspaces ((settings->>'argus_system_key'))
  where settings->>'argus_system_key' = 'default' and archived_at is null;

create or replace function public.argus_get_default_workspace()
returns public.workspaces language plpgsql security definer set search_path = public as $$
declare workspace_row public.workspaces;
begin
  select * into workspace_row from public.workspaces where settings->>'argus_system_key' = 'default' and archived_at is null limit 1;
  if workspace_row.id is null then
    insert into public.workspaces (name, settings) values ('ARGUS Demo Workspace', '{"argus_system_key":"default","ownership":"transitional_unauthenticated"}'::jsonb) returning * into workspace_row;
  end if;
  return workspace_row;
end;
$$;

create or replace function public.argus_commit_page_observation(
  p_page_id uuid, p_scan_run_id uuid, p_expected_current_snapshot_id uuid,
  p_content_hash text, p_normalized_text text, p_title text, p_observed_at timestamptz,
  p_is_changed_revision boolean, p_event jsonb default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare current_snapshot_id uuid; new_snapshot public.page_snapshots; new_event public.change_events; page_row public.monitored_pages; site_row public.monitored_sites;
begin
  select * into page_row from public.monitored_pages where id = p_page_id for update;
  if page_row.id is null then raise exception 'ARGUS_PAGE_NOT_FOUND'; end if;
  select * into site_row from public.monitored_sites where id = page_row.site_id;
  select id into current_snapshot_id from public.page_snapshots where page_id = p_page_id and is_current = true;
  if current_snapshot_id is distinct from p_expected_current_snapshot_id then raise exception 'ARGUS_SNAPSHOT_CONFLICT'; end if;
  update public.page_snapshots set is_current = false where page_id = p_page_id and is_current = true;
  select * into new_snapshot from public.page_snapshots where page_id = p_page_id and content_hash = p_content_hash;
  if new_snapshot.id is null then
    insert into public.page_snapshots (page_id, scan_run_id, content_hash, normalized_text, title, is_current, is_changed_revision, observed_at)
    values (p_page_id, p_scan_run_id, p_content_hash, p_normalized_text, left(p_title, 1000), true, p_is_changed_revision, p_observed_at)
    returning * into new_snapshot;
  else
    update public.page_snapshots set is_current = true, scan_run_id = p_scan_run_id, observed_at = p_observed_at, title = left(p_title, 1000), is_changed_revision = p_is_changed_revision where id = new_snapshot.id returning * into new_snapshot;
  end if;
  if p_event is not null then
    insert into public.change_events (workspace_id, site_id, page_id, scan_run_id, event_type, before_snapshot_id, after_snapshot_id, evidence, deterministic_metrics, compact_diff, summary, severity, areas_affected, recommended_action, reasoning, occurred_at)
    values (site_row.workspace_id, page_row.site_id, p_page_id, p_scan_run_id, 'CONTENT_CHANGED', current_snapshot_id, new_snapshot.id, coalesce(p_event->'evidence','{}'::jsonb), coalesce(p_event->'deterministic_metrics','{}'::jsonb), left(coalesce(p_event->>'compact_diff',''), 20000), left(p_event->>'summary', 2000), (p_event->>'severity')::public.argus_severity, coalesce(p_event->'areas_affected','[]'::jsonb), left(p_event->>'recommended_action', 2000), left(p_event->>'reasoning', 4000), p_observed_at)
    returning * into new_event;
  end if;
  update public.monitored_pages set lifecycle = case when p_event is null then 'ACTIVE'::public.argus_page_lifecycle else 'CHANGED'::public.argus_page_lifecycle end, title = left(p_title, 1000), last_checked_at = p_observed_at, last_success_at = p_observed_at, last_http_status = 200, consecutive_missing_count = 0 where id = p_page_id;
  return jsonb_build_object('snapshot', to_jsonb(new_snapshot), 'event', case when new_event.id is null then null else to_jsonb(new_event) end);
end;
$$;
revoke all on function public.argus_get_default_workspace() from public;
revoke all on function public.argus_commit_page_observation(uuid, uuid, uuid, text, text, text, timestamptz, boolean, jsonb) from public;
grant execute on function public.argus_get_default_workspace() to service_role;
grant execute on function public.argus_commit_page_observation(uuid, uuid, uuid, text, text, text, timestamptz, boolean, jsonb) to service_role;
