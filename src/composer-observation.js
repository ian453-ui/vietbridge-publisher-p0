import {createHash} from 'node:crypto';
import {readFileSync,realpathSync,existsSync} from 'node:fs';
import {join,basename} from 'node:path';
import {boundedRead,observeReadiness,safeComposerUrl} from './publisher-core/facebook-readiness-observation.ts';

export function assertPendingObservationLease(executor,snapshot){
  const resource=realpathSync(snapshot.profileDir),key=createHash('sha256').update(resource).digest('hex'),folder=join(executor.resources.directory,key);
  let owner;try{owner=JSON.parse(readFileSync(join(folder,'owner.json'),'utf8'));}catch{throw Error('OBSERVATION_PENDING_LEASE_REQUIRED');}
  if(owner.resource!==resource||owner.owner!=='operator:'+snapshot.profileId||owner.phase!=='PENDING'||existsSync(join(folder,'readback')))throw Error('OBSERVATION_OWNER_OR_LEASE_BUSY');
}
function matchesComposer(page,asset){
  try{const u=new URL(page.url());return u.protocol==='https:'&&u.hostname==='business.facebook.com'&&/^\/latest\/composer\/?$/.test(u.pathname)&&!u.username&&!u.password&&!u.hash&&u.searchParams.get('asset_id')===asset&&[...u.searchParams].every(([k])=>k==='asset_id')&&u.searchParams.getAll('asset_id').length===1;}catch{return false;}
}
// No create/navigate/close/scroll/fill/trial/click calls. Reads existing pages only.
export async function observeRetainedComposer(context,snapshot,progress=()=>{}, {stepMs=1500,samples=3,intervalMs=250}={}){
  const result={kind:'COMPOSER_OBSERVATION',conclusion:'INCOMPLETE',absenceProven:false,activeActorVerified:false,actorEvidence:'FROZEN_PROFILE_MAPPING_ONLY',startedAt:new Date().toISOString(),samples:[]};
  const check=()=>{if(!matchesComposer(page,snapshot.targetPageId))throw Error('OBSERVATION_COMPOSER_CHANGED');};
  progress({...result,stage:'SELECT_EXISTING_COMPOSER'});
  const pages=context.pages();if(pages.length>32)throw Error('OBSERVATION_PAGE_LIMIT');
  const composers=pages.filter(p=>matchesComposer(p,snapshot.targetPageId));
  if(composers.length!==1)throw Error('OBSERVATION_COMPOSER_MISSING_OR_AMBIGUOUS');
  const page=composers[0];result.safeUrl=safeComposerUrl(page.url());
  const form=async()=>{
    check();
    const data=await boundedRead(()=>page.evaluate(({caption,name})=>{
      const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
      const editors=[...document.querySelectorAll('[contenteditable="true"]')];
      const destinations=[...document.querySelectorAll('[role="combobox"]')].filter(e=>e.getAttribute('aria-label')===`Post to ${name}`);
      return {editorCount:editors.length,bodyMatches:editors.length===1&&norm(editors[0].innerText)===norm(caption),destinationCount:destinations.length};
    },{caption:snapshot.body,name:snapshot.expectedIdentity}),stepMs);
    check();if(!data.bodyMatches||data.editorCount!==1||data.destinationCount!==1)throw Error('OBSERVATION_FROZEN_FORM_MISMATCH');return data;
  };
  result.form=await form();
  for(let i=0;i<samples;i++){
    progress({...result,stage:'READ_ONLY_SAMPLING'});check();
    const sample=await boundedRead(()=>observeReadiness(page,snapshot.media.map(path=>basename(path))),stepMs);check();result.samples.push(sample);
    if(i+1<samples)await new Promise(resolve=>setTimeout(resolve,intervalMs));
  }
  result.form=await form();result.finishedAt=new Date().toISOString();result.stage='FINISHED';
  // This is current-scene evidence, not live actor authentication, platform
  // absence proof, readiness/trial acceptance or permission to resubmit.
  return result;
}
