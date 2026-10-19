const uncertain=new Set(['PENDING','PREPARING','PROCESSING','WAITING_FOR_USER','UNKNOWN','SUBMITTING','RECONCILE_PENDING','READY']);
export function combinationState(jobs,accountId,content,groupId,contents=[]){const ids=new Set([content.id,...contents.filter(c=>c.content_hash&&c.content_hash===content.content_hash).map(c=>c.id)]);const matches=jobs.filter(j=>j.account_id===accountId&&j.group_id===groupId&&ids.has(j.content_id));if(matches.some(j=>j.state==='PUBLISHED'))return 'PUBLISHED';if(matches.some(j=>uncertain.has(j.state)))return 'PENDING';return 'UNPUBLISHED';}
export function nextRecommendation({contents,groups,jobs,accountId,selectedGroupIds=[]}){const available=groups.filter(g=>g.account_id===accountId&&g.enabled&&g.membership_status==='JOINED'),pool=selectedGroupIds.length?available.filter(g=>selectedGroupIds.includes(g.id)):available;for(const content of [...contents].sort((a,b)=>String(a.title||'').localeCompare(String(b.title||''),'zh',{numeric:true})||String(a.id).localeCompare(String(b.id)))){const ids=pool.filter(g=>combinationState(jobs,accountId,content,g.id,contents)==='UNPUBLISHED').map(g=>g.id);if(ids.length)return {contentId:content.id,groupIds:ids};}return null;}
export function visibleSelect(inputs,value){for(const input of inputs){if(input.disabled||input.closest?.('[hidden]'))continue;if('selected'in input)input.selected=value;else input.checked=value;input.dispatchEvent?.(new Event('change',{bubbles:true}));}}
export function chunks(values,size=5){return Array.from({length:Math.ceil(values.length/size)},(_,i)=>values.slice(i*size,(i+1)*size));}

export function contentVersionLabel(content){
 const source=content?.library_source,id=String(content?.id||''),short=id.slice(0,8);
 const versions=Number.isSafeInteger(source?.content_revision)&&source.content_revision>0&&Number.isSafeInteger(source?.visual_revision)&&source.visual_revision>0?`正文${source.content_revision}/图片${source.visual_revision}`:'版本未核实';
 const title=content?.title||source?.article_id||id;
 return [source?.article_id&&!title.includes(source.article_id)?source.article_id:null,title,source?versions:null,source?.version_state==='CURRENT'?'当前版':source?.version_state==='HISTORICAL'?'历史版':source?'来源版本未核实':null,'UUID '+short].filter(Boolean).join(' · ');
}
