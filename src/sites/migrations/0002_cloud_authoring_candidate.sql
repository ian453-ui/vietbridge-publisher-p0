-- Unapplied candidate for the isolated Sites database after 0001.
-- Not a local Publisher migration. Generate/register with the official starter
-- before hosted application; no seeds, credentials, permissions or request DDL.
CREATE TABLE sites_workspaces (
 id TEXT PRIMARY KEY NOT NULL,
 owner_user_id TEXT NOT NULL,
 name TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(id,owner_user_id)
);
CREATE INDEX sites_workspaces_owner ON sites_workspaces(owner_user_id,id);
CREATE TABLE sites_account_details (
 workspace TEXT NOT NULL,
 account_id TEXT NOT NULL,
 display_name TEXT NOT NULL,
 platform TEXT NOT NULL CHECK(platform IN ('facebook','xiaohongshu','wechat_official_account','wechat_channels')),
 external_identity TEXT,
 authorization_state TEXT NOT NULL CHECK(authorization_state='UNCONFIGURED'),
 created_at TEXT NOT NULL,
 PRIMARY KEY(workspace,account_id),
 FOREIGN KEY(workspace) REFERENCES sites_workspaces(id),
 FOREIGN KEY(workspace,account_id) REFERENCES facebook_accounts(workspace,id)
);
CREATE TABLE sites_contents (
 id TEXT PRIMARY KEY NOT NULL,
 workspace TEXT NOT NULL REFERENCES sites_workspaces(id),
 account_id TEXT NOT NULL,
 content_id TEXT NOT NULL,
 slug TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 title TEXT NOT NULL,
 body TEXT NOT NULL,
 variants_json TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 source_status TEXT NOT NULL CHECK(source_status='MANUAL_UNVERIFIED'),
 created_at TEXT NOT NULL,
 UNIQUE(workspace,account_id,content_id,slug,revision),
 UNIQUE(workspace,id),
 FOREIGN KEY(workspace,account_id) REFERENCES facebook_accounts(workspace,id)
);
CREATE TABLE sites_job_snapshots (
 job_id TEXT PRIMARY KEY NOT NULL REFERENCES publisher_jobs(id),
 workspace TEXT NOT NULL,
 content_id TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,
 FOREIGN KEY(workspace,content_id) REFERENCES sites_contents(workspace,id)
);
CREATE TABLE sites_authoring_commands (
 owner_user_id TEXT NOT NULL,
 command_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('WORKSPACE','ACCOUNT','CONTENT','TASK')),
 command_hash TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 committed INTEGER NOT NULL DEFAULT 0 CHECK(committed IN (0,1)),
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user_id,command_id)
);
