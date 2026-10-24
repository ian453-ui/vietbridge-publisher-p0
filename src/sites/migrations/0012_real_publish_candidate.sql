-- Candidate only. Register/apply with the official Sites migration mechanism.
-- No credentials, customer seeds, account authorizations or request-time DDL.
CREATE TABLE sites_real_media (
 workspace TEXT NOT NULL, account_id TEXT NOT NULL, content_id TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 9), object_id TEXT NOT NULL,
 sha256 TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>0),
 created_at TEXT NOT NULL, PRIMARY KEY(content_id,ordinal), UNIQUE(object_id),
 FOREIGN KEY(workspace,account_id) REFERENCES sites_account_details(workspace,account_id),
 FOREIGN KEY(content_id) REFERENCES sites_contents(id),
 FOREIGN KEY(object_id) REFERENCES sites_objects(id)
);
CREATE TABLE sites_real_reviews (
 content_id TEXT PRIMARY KEY REFERENCES sites_contents(id), workspace TEXT NOT NULL,
 account_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
 receipt_hash TEXT NOT NULL, source_refs_json TEXT NOT NULL, checks_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('OWNER_REVIEWED','REVOKED')),
 reviewed_at TEXT NOT NULL, revoked_at TEXT,
 FOREIGN KEY(workspace,account_id) REFERENCES sites_account_details(workspace,account_id)
);
CREATE TABLE sites_real_jobs (
 job_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, account_id TEXT NOT NULL,
 content_id TEXT NOT NULL REFERENCES sites_contents(id), owner_user_id TEXT NOT NULL,
 site_snapshot_hash TEXT NOT NULL, qa_receipt_hash TEXT NOT NULL,
 manifest_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('FROZEN','PREPARE_INTENT','PREPARED','SUBMIT_INTENT','UNKNOWN','PUBLISHED','PUBLISHED_ID_PENDING','DRAFT_WRITTEN','BLOCKED')),
 prepare_command_id TEXT, submit_command_id TEXT, local_job_id TEXT,
 local_snapshot_hash TEXT, readback_json TEXT, created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, UNIQUE(workspace,account_id,content_id),
 FOREIGN KEY(workspace,account_id) REFERENCES sites_account_details(workspace,account_id)
);
CREATE INDEX sites_real_jobs_scope ON sites_real_jobs(workspace,account_id,created_at);
