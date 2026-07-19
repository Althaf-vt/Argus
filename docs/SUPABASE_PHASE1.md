# ARGUS V2 Phase 1: Supabase foundation

Phase 1 adds a server-only, version-controlled Postgres foundation. The existing V1 browser pipeline, localStorage snapshots/history/results, and browser scheduler remain the active authority until Phase 2.

## Environment

Set these server-only variables locally and in Vercel. Do not prefix any of them with `VITE_`.

```dotenv
GEMINI_API_KEY=your_server_only_key_here
SUPABASE_URL=your_supabase_project_url_here
SUPABASE_SECRET_KEY=your_supabase_server_secret_key_here
```

`SUPABASE_SECRET_KEY` is used only by files under `api/`. It must never be imported by `src/` or returned to a browser.

## Apply the migration

The complete Phase 1 schema is in:

`supabase/migrations/20260719000100_argus_v2_phase1_foundation.sql`

No remote database operation is performed by this repository. To apply it through the Supabase dashboard:

1. Open the Argus Supabase project.
2. Open **SQL Editor** and select **New query**.
3. Paste the migration file contents exactly once and run it.
4. Confirm that the nine Phase 1 tables appear under **Table Editor**.
5. Do not create cron jobs, Edge Functions, or database tables manually outside this migration.

Alternatively, after installing/linking the Supabase CLI locally, use the standard migration workflow against the intended development project. Do not put database passwords or project secrets in this repository.

## Verify connectivity

After the migration is applied and server environment variables are configured, make a `GET` request to `/api/health/database` through the Vercel deployment or `vercel dev`. The successful response is limited to:

```json
{ "ok": true, "database": "connected" }
```

The endpoint intentionally does not return table data, connection strings, or credentials. A failure returns only `database: "unavailable"`.

## Phase 1 boundary

The migration establishes workspaces, monitored sites/pages, snapshots, scan runs, change events, intelligence, subscriptions, and outbox persistence with RLS policies. It does **not** create a scheduler, worker, crawler, server-side scan path, localStorage migration, or frontend database dependency. Those changes begin in later phases.
