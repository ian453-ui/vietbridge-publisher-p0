-- Candidate for the existing private Sites D1 database. Register through the
-- official deployment path; never run request-time DDL or create a new Site.
CREATE TABLE sites_production_leads (
 id TEXT PRIMARY KEY NOT NULL,
 workspace TEXT NOT NULL REFERENCES sites_workspaces(id),
 owner_user_id TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('URL','MANUAL')),
 original_url TEXT,
 canonical_url TEXT,
 title TEXT NOT NULL,
 brief TEXT NOT NULL,
 connector_id TEXT NOT NULL,
 event_id TEXT NOT NULL,
 event_hash TEXT NOT NULL,
 source_hash TEXT NOT NULL,
 parent_lead_id TEXT,
 rights_status TEXT NOT NULL CHECK(rights_status='UNVERIFIED'),
 created_at TEXT NOT NULL,
 UNIQUE(workspace,id),
 UNIQUE(workspace,connector_id,event_id),
 FOREIGN KEY(workspace,parent_lead_id) REFERENCES sites_production_leads(workspace,id)
);
CREATE INDEX sites_production_leads_source ON sites_production_leads(workspace,source_hash,created_at);
CREATE TABLE sites_production_jobs (
 id TEXT PRIMARY KEY NOT NULL,
 workspace TEXT NOT NULL REFERENCES sites_workspaces(id),
 lead_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('WAITING_PROVIDER','PAUSED','CANCELLED','OUTCOME_UNKNOWN')),
 revision INTEGER NOT NULL CHECK(revision>0),
 provider_state TEXT NOT NULL CHECK(provider_state='UNCONFIGURED'),
 qa_state TEXT NOT NULL CHECK(qa_state='BLOCKED'),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(workspace,id),
 UNIQUE(workspace,lead_id),
 FOREIGN KEY(workspace,lead_id) REFERENCES sites_production_leads(workspace,id)
);
CREATE INDEX sites_production_jobs_recent ON sites_production_jobs(workspace,created_at DESC,id DESC);
CREATE TABLE sites_production_commands (
 owner_user_id TEXT NOT NULL,
 command_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('CREATE','ACTION')),
 command_hash TEXT NOT NULL,
 lead_id TEXT NOT NULL,
 job_id TEXT NOT NULL,
 applied INTEGER NOT NULL CHECK(applied IN (0,1)),
 result_revision INTEGER,
 result_state TEXT,
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user_id,command_id)
);
