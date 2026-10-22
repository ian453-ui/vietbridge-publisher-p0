-- Unapplied Sites candidate, schema only. Existing-admin/provenance bindings
-- have NO public provisioning route. Only tests inject synthetic bindings.
CREATE TABLE sites_approval_bindings(review_id TEXT PRIMARY KEY REFERENCES sites_reviews(id),binding_json TEXT NOT NULL);
CREATE TABLE sites_approval_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,review_id TEXT NOT NULL REFERENCES sites_reviews(id),subject_fingerprint TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('CONTENT_APPROVED','CONTENT_REJECTED','REVOKED')),actor_id TEXT NOT NULL,reason TEXT NOT NULL,checks_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX sites_approval_history ON sites_approval_events(review_id,sequence);
CREATE TABLE sites_approval_commands(command_id TEXT PRIMARY KEY,command_hash TEXT NOT NULL,event_id TEXT NOT NULL REFERENCES sites_approval_events(id));
CREATE TRIGGER sites_approval_event_no_update BEFORE UPDATE ON sites_approval_events BEGIN SELECT RAISE(ABORT,'APPROVAL_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER sites_approval_event_no_delete BEFORE DELETE ON sites_approval_events BEGIN SELECT RAISE(ABORT,'APPROVAL_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER sites_approval_command_no_update BEFORE UPDATE ON sites_approval_commands BEGIN SELECT RAISE(ABORT,'APPROVAL_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER sites_approval_command_no_delete BEFORE DELETE ON sites_approval_commands BEGIN SELECT RAISE(ABORT,'APPROVAL_AUDIT_IMMUTABLE'); END;
CREATE TABLE sites_upload_plans(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,account_id TEXT NOT NULL,review_id TEXT NOT NULL REFERENCES sites_reviews(id),subject_fingerprint TEXT NOT NULL,approval_event_id TEXT NOT NULL REFERENCES sites_approval_events(id),content_id TEXT NOT NULL UNIQUE REFERENCES sites_contents(id),job_id TEXT NOT NULL UNIQUE REFERENCES publisher_jobs(id),manifest_json TEXT NOT NULL,manifest_hash TEXT NOT NULL,created_at TEXT NOT NULL);
-- Closed synthetic rehearsal ledger. Never consumed by a real driver or route.
CREATE TABLE sites_synthetic_attempts(plan_id TEXT PRIMARY KEY REFERENCES sites_upload_plans(id),attempt_id TEXT NOT NULL UNIQUE,job_id TEXT NOT NULL UNIQUE REFERENCES publisher_jobs(id),snapshot_hash TEXT NOT NULL,actor_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('PREPARING','SUBMITTING','UNKNOWN','UPLOAD_FAILED','VERIFIED')),created_at TEXT NOT NULL);
CREATE TABLE sites_synthetic_objects(plan_id TEXT PRIMARY KEY REFERENCES sites_upload_plans(id),attempt_id TEXT NOT NULL,object_id TEXT NOT NULL,snapshot_hash TEXT NOT NULL,media_json TEXT NOT NULL);
CREATE TABLE sites_synthetic_readbacks(plan_id TEXT PRIMARY KEY REFERENCES sites_upload_plans(id),evidence_json TEXT NOT NULL);
