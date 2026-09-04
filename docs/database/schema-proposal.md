# Proposed Schema Extensions

## Table: snapshot_audits
- id: uuid primary key
- site_id: foreign key -> sites.id
- diff_hash: sha256 text
- execution_latency_ms: integer
- recorded_at: timestamp with time zone
