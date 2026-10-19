import {extname} from 'node:path';
import {hashFile} from './publisher-core/file-hash.ts';
import {platformOf,retainsPreparationEffects} from './publisher-platforms.js';
const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
// Compare what the browser publishes, not bookkeeping title/tags/author or paths.
// The old approved bytes come from retained immutable asset records.
export function matchesRetainedFacebookPublication(db,row,snapshot,candidateJobId=null){
 if(!retainsPreparationEffects(row))return false;
 const old=row.snapshot||JSON.parse(row.snapshot_json);
 if(platformOf(old)!=='facebook'||platformOf(snapshot)!=='facebook'||(old.targetPageId||old.externalId)!==(snapshot.targetPageId||snapshot.externalId)||clean(old.body)!==clean(snapshot.body))return false;
 const video=media=>media.some(path=>extname(path).toLowerCase()==='.mp4');
 if(video(old.media)!==video(snapshot.media)||video(old.media)&&clean(old.title)!==clean(snapshot.title)||old.media.length!==snapshot.media.length)return false;
 const prior=db.prepare('SELECT sha256 FROM publisher_job_assets WHERE job_id=? ORDER BY ordinal').all(row.id);
 if(prior.length!==old.media.length||prior.some(a=>!/^[a-f0-9]{64}$/.test(a.sha256)))throw Error('RETAINED_PREPARATION_MEDIA_EVIDENCE_INCOMPLETE');
 let hashes;
 if(candidateJobId){const assets=db.prepare('SELECT sha256 FROM publisher_job_assets WHERE job_id=? ORDER BY ordinal').all(candidateJobId);if(assets.length!==snapshot.media.length)throw Error('CANDIDATE_APPROVED_MEDIA_INCOMPLETE');hashes=assets.map(a=>a.sha256);}
 else hashes=snapshot.media.map(path=>hashFile(path).sha256);
 return prior.every((a,i)=>a.sha256===hashes[i]);
}
