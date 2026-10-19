import {groupNameMatches} from './group-filters.js';

/** Random selection is a new one-shot choice, never an addition to old choices. */
export function randomGroupIds(groups,accountId,count,filters={},random=()=>crypto.getRandomValues(new Uint32Array(1))[0]/4294967296) {
  if(!Number.isInteger(count)||count<1||count>100)throw Error('随机选组数量必须为 1–100');
  const pool=[...new Map(groups.filter(g=>g.account_id===accountId&&g.enabled&&g.membership_status==='JOINED'&&groupNameMatches(g.name,filters)).map(g=>[g.id,g])).values()];
  const size=Math.min(count,pool.length);
  for(let i=0;i<size;i++) {
    const draw=random();if(!Number.isFinite(draw)||draw<0||draw>=1)throw Error('随机数无效');
    const j=i+Math.floor(draw*(pool.length-i));[pool[i],pool[j]]=[pool[j],pool[i]];
  }
  return pool.slice(0,size).map(g=>g.id);
}

export function replaceGroupSelection(inputs,ids=[]) {
  const chosen=new Set(ids);
  for(const input of inputs)input.checked=!input.disabled&&!input.closest('label')?.hidden&&chosen.has(input.dataset.group);
}
