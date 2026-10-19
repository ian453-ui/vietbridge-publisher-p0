// Session-only edits, isolated by customer, operating account and selected content.
export class PublisherFormDrafts {
  constructor(){this.values=new Map();this.selections=new Map();this.preferences=new Map();}
  resolve(workspace,account,preferred,contents){
    const key=this.key(workspace,account,'');
    if(preferred&&this.preferences.get(key)!==preferred){this.preferences.set(key,preferred);this.select(workspace,account,preferred);}
    const current=this.selected(workspace,account);
    return contents.some(c=>c.id===current)?current:undefined;
  }
  selected(workspace,account){return this.selections.get(this.key(workspace,account,''));}
  select(workspace,account,content){this.selections.set(this.key(workspace,account,''),content);}
  key(workspace,account,content){return JSON.stringify([workspace,account,content]);}
  get(workspace,account,content){return this.values.get(this.key(workspace,account,content));}
  set(workspace,account,content,payload){this.select(workspace,account,content);this.values.set(this.key(workspace,account,content),{...payload,tags:[...(payload.tags||[])]});}
}

export function publisherPayload(content,platform,draft){
  if(content?.library_source&&!content.platform_payloads?.[platform]&&(platform!=='facebook'||Object.keys(content.platform_payloads||{}).length>0))return {blockedReason:'此稿尚无该平台公开文案，请先补齐并重新选用内容',body:'',tags:[],media:[]};
  if(content?.platform_eligibility?.[platform]?.allowed===false)return {blockedReason:content.platform_eligibility[platform].blockedReason,body:'',tags:[],media:[]};
  const base=content?.platform_payloads?.[platform]||content||{};
  const tags=base.tags?.length?base.tags:platform==='facebook'&&content?.library_source?.article_id==='CNVISA-FB-021'
    ?['LPTravel','VisaTrungQuoc','TetDuongLich2027']:[];
  return {...base,tags,...draft};
}
