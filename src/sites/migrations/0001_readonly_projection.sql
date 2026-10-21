-- Candidate schema for a NEW isolated Sites read projection only.
-- Not a migration for the full local Publisher DB; no request-time DDL or seeds.
CREATE TABLE facebook_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  workspace TEXT NOT NULL,
  UNIQUE(workspace,id)
);
CREATE TABLE publisher_content_sources (
  workspace TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  content_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  PRIMARY KEY(workspace,source_id,revision)
);
CREATE TABLE publisher_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace TEXT NOT NULL,
  account_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('DRAFT','READY','PREPARING','SUBMITTING','PUBLISHED','DRAFT_WRITTEN','PUBLISHED_ID_PENDING','CANCELLED','BLOCKED','UNKNOWN')),
  attempt_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace,account_id) REFERENCES facebook_accounts(workspace,id),
  UNIQUE(workspace,account_id,content_id,snapshot_hash)
);
CREATE INDEX publisher_jobs_scope ON publisher_jobs(workspace,account_id,created_at DESC,id DESC);
CREATE TABLE sites_project_memberships (
  user_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role='READER'),
  revoked_at TEXT,
  PRIMARY KEY(user_id,workspace,account_id),
  FOREIGN KEY(workspace,account_id) REFERENCES facebook_accounts(workspace,id)
);
