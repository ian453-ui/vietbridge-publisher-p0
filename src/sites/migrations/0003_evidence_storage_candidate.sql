-- Unapplied candidate: generate/register with the official Sites starter.
-- Schema only. No request-time DDL, credentials, seeding or real authorization.
CREATE TABLE sites_write_assertions(ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE sites_task_bindings(task_id TEXT PRIMARY KEY,workspace TEXT NOT NULL,account_id TEXT NOT NULL,identity_hash TEXT,
 FOREIGN KEY(workspace,account_id) REFERENCES sites_account_details(workspace,account_id));
CREATE TABLE metric_targets(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES sites_task_bindings(task_id),workspace TEXT NOT NULL,account_id TEXT NOT NULL,publication_job_id TEXT NOT NULL UNIQUE REFERENCES publisher_jobs(id),target_json TEXT NOT NULL,
 FOREIGN KEY(workspace,account_id) REFERENCES sites_account_details(workspace,account_id));
CREATE TABLE metric_series(id TEXT PRIMARY KEY,target_id TEXT NOT NULL REFERENCES metric_targets(id),selector_json TEXT NOT NULL);
CREATE TABLE metric_observations(id TEXT PRIMARY KEY,series_id TEXT NOT NULL REFERENCES metric_series(id),observed_at TEXT NOT NULL,observation_json TEXT NOT NULL,unavailable_reason TEXT,created_at TEXT NOT NULL,collection_origin TEXT NOT NULL CHECK(collection_origin IN ('COLLECTOR','OFFLINE')));
CREATE INDEX metric_observation_history ON metric_observations(series_id,observed_at,id);
CREATE TABLE metric_raw_evidence(observation_id TEXT PRIMARY KEY REFERENCES metric_observations(id),sha256 TEXT NOT NULL,data BLOB NOT NULL);
CREATE TABLE metric_collection_attempts(id TEXT PRIMARY KEY,series_id TEXT NOT NULL REFERENCES metric_series(id),state TEXT NOT NULL CHECK(state IN ('RUNNING','FAILED','RECORDED')),started_at TEXT NOT NULL,finished_at TEXT,reason TEXT,generation INTEGER NOT NULL CHECK(generation>0),UNIQUE(series_id,generation));
CREATE TABLE metric_attempt_observations(attempt_id TEXT PRIMARY KEY REFERENCES metric_collection_attempts(id),observation_id TEXT NOT NULL REFERENCES metric_observations(id));
CREATE TABLE sites_objects(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,account_id TEXT NOT NULL,object_key TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes>0),mime TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('STAGED','READY','CORRUPT')),created_at TEXT NOT NULL,
 FOREIGN KEY(workspace,account_id) REFERENCES sites_account_details(workspace,account_id));
CREATE TABLE sites_reviews(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES sites_task_bindings(task_id),request_revision INTEGER NOT NULL,workspace TEXT NOT NULL,account_id TEXT NOT NULL,request_json TEXT NOT NULL,result_json TEXT NOT NULL,report_json TEXT NOT NULL,envelope_hash TEXT NOT NULL,result_fingerprint TEXT NOT NULL,state TEXT NOT NULL CHECK(state='REVIEW_REQUIRED'),created_at TEXT NOT NULL,UNIQUE(task_id,request_revision),
 FOREIGN KEY(workspace,account_id) REFERENCES sites_account_details(workspace,account_id));
CREATE TABLE sites_review_assets(review_id TEXT NOT NULL REFERENCES sites_reviews(id),source_id TEXT NOT NULL,artifact_id TEXT NOT NULL,object_id TEXT NOT NULL REFERENCES sites_objects(id),PRIMARY KEY(review_id,source_id,artifact_id));
