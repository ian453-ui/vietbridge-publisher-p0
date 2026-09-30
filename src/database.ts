import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type Db = DatabaseSync;

export function openDatabase(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS hidden_history (job_id TEXT PRIMARY KEY REFERENCES jobs(job_id), hidden_at TEXT NOT NULL)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      account_id TEXT NOT NULL,
      package_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approval_ref TEXT,
      platform_id TEXT,
      platform_url TEXT,
      UNIQUE(article_id, platform, account_id, package_hash)
    );
    CREATE TABLE IF NOT EXISTS facebook_accounts (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, page_id TEXT NOT NULL,
      page_name TEXT NOT NULL, config_url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_preferences (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS state_transitions (
      transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS publication_intents (
      intent_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES jobs(job_id),
      operation TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      media_hashes_json TEXT NOT NULL,
      approval_ref TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS form_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      fields_json TEXT NOT NULL,
      fields_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      retained_until TEXT
    );
    CREATE TABLE IF NOT EXISTS profile_locks (
      profile_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profile_health (
      profile_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      status TEXT NOT NULL,
      chrome_version TEXT,
      profile_size_bytes INTEGER,
      devtools_ready INTEGER NOT NULL,
      editor_ready INTEGER NOT NULL,
      detail_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox_events (
      event_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error TEXT,
      mirrored_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS incidents (
      incident_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      last_state TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      regression_case_id TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS publication_batches (
      batch_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_mode TEXT NOT NULL,
      source_value TEXT,
      platforms_json TEXT NOT NULL,
      default_all_platforms INTEGER NOT NULL,
      control_state TEXT NOT NULL,
      pause_requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS content_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL,
      content_version TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      canonical_payload_json TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_locator TEXT,
      source_revision TEXT,
      staging_root TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(article_id, content_version, manifest_hash)
    );
    CREATE TABLE IF NOT EXISTS content_assets (
      asset_id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL REFERENCES content_snapshots(snapshot_id),
      role TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      original_locator TEXT NOT NULL,
      staging_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      mime_detected TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      source_revision TEXT,
      UNIQUE(snapshot_id, role, ordinal)
    );
    CREATE TABLE IF NOT EXISTS platform_attempts (
      attempt_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      attempt_number INTEGER NOT NULL,
      authorization_reason TEXT NOT NULL,
      worker_id TEXT,
      fencing_token INTEGER NOT NULL,
      safe_phase TEXT NOT NULL,
      external_resource_id TEXT,
      submit_started_at TEXT,
      submit_ack_at TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_class TEXT,
      UNIQUE(job_id, attempt_number),
      UNIQUE(job_id, fencing_token)
    );
    CREATE TABLE IF NOT EXISTS job_events (
      event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      attempt_id TEXT REFERENCES platform_attempts(attempt_id),
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_receipts (
      receipt_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      attempt_id TEXT REFERENCES platform_attempts(attempt_id),
      receipt_type TEXT NOT NULL,
      platform_post_id TEXT,
      platform_url TEXT,
      raw_status TEXT,
      evidence_json TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approval_records (
      approval_id TEXT PRIMARY KEY,
      approval_scope_hash TEXT NOT NULL,
      platform TEXT NOT NULL,
      account_id TEXT NOT NULL,
      visibility TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      UNIQUE(approval_scope_hash, approved_at)
    );
    CREATE TABLE IF NOT EXISTS attention_requests (
      attention_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES publication_batches(batch_id),
      job_id TEXT REFERENCES jobs(job_id),
      attempt_id TEXT REFERENCES platform_attempts(attempt_id),
      kind TEXT NOT NULL,
      message_code TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      status TEXT NOT NULL,
      resolution TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
    CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(mirrored_at, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_snapshots_job ON form_snapshots(job_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_batches_state ON publication_batches(control_state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assets_hash ON content_assets(sha256);
    CREATE INDEX IF NOT EXISTS idx_attempts_job ON platform_attempts(job_id, attempt_number DESC);
    CREATE INDEX IF NOT EXISTS idx_events_job ON job_events(job_id, event_seq);
    CREATE INDEX IF NOT EXISTS idx_receipts_job ON platform_receipts(job_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_attention_open ON attention_requests(status, created_at);
  `);
  for(const [name,type] of [['source_asset_id','TEXT'],['content_id','TEXT'],['filename','TEXT'],['qa_state','TEXT'],['source_drive_id','TEXT'],['source_folder_id','TEXT'],['source_path','TEXT'],['sequence','INTEGER']] as const){
    const columns=db.prepare('PRAGMA table_info(content_assets)').all() as {name:string}[];
    if(!columns.some(column=>column.name===name))db.exec(`ALTER TABLE content_assets ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_content_asset_source_identity ON content_assets(snapshot_id,source_asset_id) WHERE source_asset_id IS NOT NULL');
  ensureColumn(db, "publication_batches", "content_snapshot_id", "TEXT");
  ensureColumn(db, "publication_batches", "pause_requested_at", "TEXT");
  ensureColumn(db, "publication_batches", "terminated_at", "TEXT");
  ensureColumn(db, "jobs", "batch_id", "TEXT");
  ensureColumn(db, "jobs", "rendition_type", "TEXT");
  ensureColumn(db, "jobs", "payload_hash", "TEXT");
  ensureColumn(db, "jobs", "approval_scope_hash", "TEXT");
  ensureColumn(db, "jobs", "submit_safety_domain", "TEXT NOT NULL DEFAULT 'BEFORE_EXTERNAL_SUBMIT'");
  ensureColumn(db, "jobs", "current_attempt_id", "TEXT");
  ensureColumn(db, "jobs", "submitted_at", "TEXT");
  ensureColumn(db, "jobs", "published_at", "TEXT");
  ensureColumn(db, "jobs", "last_verified_at", "TEXT");
}

function ensureColumn(db: Db, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function transaction<T>(db: Db, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
