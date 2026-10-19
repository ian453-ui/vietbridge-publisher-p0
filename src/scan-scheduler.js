/** Scheduled discovery only: this scheduler never publishes, likes or replies. */
export class ScanScheduler {
  constructor(store,facebook,{now=()=>Date.now()}={}){
    this.store=store;this.facebook=facebook;this.now=now;this.running=false;
    store.db.exec('CREATE TABLE IF NOT EXISTS scan_schedule(workspace TEXT NOT NULL,account_id TEXT NOT NULL,next_at INTEGER NOT NULL,last_status TEXT,last_error TEXT,PRIMARY KEY(workspace,account_id))');
  }
  tick(){
    if(this.stopped)return Promise.resolve();
    if(this.inflight)return this.inflight;
    this.inflight=this.runTick().finally(()=>{this.inflight=null;});return this.inflight;
  }
  async runTick(){
    if(this.running)return;this.running=true;
    try{
      const settings=this.store.db.prepare('SELECT * FROM proactive_settings WHERE enabled=1 AND global_enabled=1 AND account_enabled=1').all();
      for(const setting of settings){
        if(this.stopped)break;
        const account=this.store.db.prepare('SELECT * FROM facebook_accounts WHERE id=? AND workspace=? AND enabled=1').get(setting.account_id,setting.workspace);if(!account)continue;
        const old=this.store.db.prepare('SELECT * FROM scan_schedule WHERE workspace=? AND account_id=?').get(setting.workspace,account.id);
        if(old&&old.next_at>this.now())continue;
        const next=this.now()+Math.max(15,setting.scan_interval_min)*60000;
        this.store.db.prepare("INSERT INTO scan_schedule VALUES(?,?,?,'RUNNING',NULL) ON CONFLICT(workspace,account_id) DO UPDATE SET next_at=excluded.next_at,last_status='RUNNING',last_error=NULL").run(setting.workspace,account.id,next);
        try{await this.facebook.scanProactiveEngagement(setting.workspace,account.id);this.store.db.prepare("UPDATE scan_schedule SET last_status='OK' WHERE workspace=? AND account_id=?").run(setting.workspace,account.id);}
        catch(error){this.store.db.prepare("UPDATE scan_schedule SET last_status='BLOCKED',last_error=? WHERE workspace=? AND account_id=?").run(String(error.message||error).slice(0,500),setting.workspace,account.id);}
      }
    }finally{this.running=false;}
  }
  start(){this.stopped=false;if(!this.timer){this.timer=setInterval(()=>this.tick().catch(()=>{}),60000);this.timer.unref();}return this;}
  stop(){this.stopped=true;clearInterval(this.timer);this.timer=null;return this.inflight||Promise.resolve();}
}
