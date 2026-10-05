import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/database.ts';
import { TaskService } from '../src/task-service.ts';
import { PublisherStore } from '../src/publisher-store.ts';

test('batch list equals individual details and does not query per job', () => {
  const root = mkdtempSync(join(tmpdir(), 'publisher-batch-list-'));
  const db = openDatabase(join(root, 'db.sqlite'));
  try {
    const tasks = new TaskService(db, { roots: [], stagingRoot: join(root, 'staging') });
    const store = new PublisherStore(db), time = '2026-10-05T00:00:00.000Z';
    for (let i = 0; i < 40; i++) {
      const batch = `batch-${i}`, job = `job-${i}`;
      db.prepare(`INSERT INTO publication_batches(batch_id,title,source_mode,platforms_json,default_all_platforms,control_state,created_at,updated_at)
        VALUES(?,?,?,'["facebook"]',0,'RUNNING',?,?)`).run(batch, batch, 'ledger', time, time);
      store.createJob({ jobId: job, articleId: `article-${i}`, platform: 'facebook', accountId: 'page', packageHash: `hash-${i}` });
      db.prepare('UPDATE jobs SET batch_id=? WHERE job_id=?').run(batch, job);
      store.transition(job, 'FACT_CHECK');
      if (i === 0) {
        db.prepare('INSERT INTO hidden_history(job_id,hidden_at) VALUES(?,?)').run(job, time);
        const insert = db.prepare(`INSERT INTO attention_requests(attention_id,batch_id,job_id,kind,message_code,detail_json,status,created_at)
          VALUES(?,?,?,'LOGIN',?,'{}','OPEN',?)`);
        insert.run('a', batch, job, 'OLD_LOGIN', time);
        insert.run('b', batch, job, 'NEW_LOGIN', '2026-10-05T00:00:01.000Z');
      }
    }
    const expected = tasks.listBatches().map(batch => tasks.getBatch(String(batch.batch_id)));
    const original = db.prepare.bind(db);
    let count = 0;
    db.prepare = ((...args: Parameters<typeof db.prepare>) => { count++; return original(...args); }) as typeof db.prepare;
    const batches = tasks.listBatches();
    assert.deepEqual(batches, expected);
    assert.equal(count, 3, 'number of queries must stay constant as jobs accumulate');
    assert.equal(batches.length, 40);
    const first = batches.find(batch => batch.batch_id === 'batch-0')!;
    const jobs = first.jobs as Record<string, unknown>[];
    assert.equal(jobs.length, 1, 'multiple open attention requests must not duplicate a job');
    assert.equal(jobs[0].attention_code, 'NEW_LOGIN');
    assert.equal(jobs[0].history_hidden, true);
    count=0;
    const scoped=tasks.listBatches(['batch-0','batch-1']);
    assert.equal(scoped.length,2);assert.equal(count,3,'scoped history must still use exactly three queries');
    assert.deepEqual(scoped.map(batch=>batch.batch_id).sort(),['batch-0','batch-1']);
    assert.deepEqual(tasks.listBatches([]),[]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
