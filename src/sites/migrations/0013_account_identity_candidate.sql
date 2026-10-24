-- Candidate only. Register through the official Sites migration flow before deployment.
CREATE TABLE sites_account_identity_events (
 id TEXT PRIMARY KEY NOT NULL,
 workspace TEXT NOT NULL,
 account_id TEXT NOT NULL,
 actor_user_id TEXT NOT NULL,
 old_identity TEXT,
 new_identity TEXT NOT NULL,
 evidence_note TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(workspace,account_id) REFERENCES sites_account_details(workspace,account_id)
);
CREATE INDEX sites_account_identity_events_scope ON sites_account_identity_events(workspace,account_id,created_at);
