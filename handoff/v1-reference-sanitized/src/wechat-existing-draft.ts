import { verifyExactWechatDraft } from './wechat-draft-reader.ts';
import {parse} from 'yaml';

type Reader={get(id:string):Promise<any>;list(offset:number):Promise<any>;publishedList(offset:number):Promise<any>};
/** Reads only. Errors, changing counts and truncated inventories never prove deletion. */
export async function inspectExistingWechatDraft(reader:Reader,scope:{account:string;expectedAccount:string;mediaId:string;markdown:string}) {
  if(!scope.account||scope.account!==scope.expectedAccount||!scope.mediaId)throw Error('WECHAT_DRAFT_SCOPE_MISMATCH');
  try {
    const exact=await reader.get(scope.mediaId);
    if(!verifyExactWechatDraft(scope.markdown,exact))throw Error('WECHAT_DRAFT_BODY_MISMATCH');
    return {outcome:'DRAFT_EXISTS',mediaId:scope.mediaId,account:scope.account,complete:false};
  } catch(error) {
    if(!(error instanceof Error)||error.message!=='微信接口错误码 40007')throw error;
  }
  let drafts:any[],published:any[];
  try{drafts=await readCompleteWechatInventory(offset=>reader.list(offset));published=await readCompleteWechatInventory(offset=>reader.publishedList(offset));}
  catch(error){if(error instanceof Error&&error.message==='WECHAT_INVENTORY_DETAILS_INCOMPLETE')return {outcome:'INCOMPLETE',account:scope.account,mediaId:scope.mediaId,complete:false,reason:error.message};throw error;}
  if(drafts.some(item=>String(item.media_id)===scope.mediaId))throw Error('WECHAT_DRAFT_READ_CONFLICT');
  const matches=published.filter(item=>verifyExactWechatDraft(scope.markdown,item.content));
  if(matches.length)return {outcome:'PUBLICATION_OBSERVED',account:scope.account,complete:true,objects:matches.map(item=>({id:String(item.article_id||item.media_id),urls:(item.content?.news_item||[]).map((n:any)=>String(n.url||''))}))};
  // A matching replacement is still a draft: no duplicate recreation.
  if(drafts.some(item=>verifyExactWechatDraft(scope.markdown,item.content)))return {outcome:'REPLACEMENT_DRAFT_EXISTS',account:scope.account,complete:true};
  // A similar article whose complete frozen text could not be attributed is
  // conflicting evidence, never proof of absence (including changed rendering).
  const front=scope.markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  const title=front?parse(front[1])?.title:undefined;
  if([...drafts,...published].some(item=>item.content.news_item.some((article:any)=>article.title===title)))return {outcome:'BODY_CONFLICT',account:scope.account,mediaId:scope.mediaId,complete:false};
  return {outcome:'DRAFT_DELETED',account:scope.account,mediaId:scope.mediaId,complete:true,draftCount:drafts.length,publishedCount:published.length};
}

export async function readCompleteWechatInventory(read:(offset:number)=>Promise<any>) {
    let total:number|undefined;const items:any[]=[];const seen=new Set<string>();
    for(let offset=0;offset<500;offset+=20){
      const page=await read(offset),count=Number(page.item_count),nextTotal=Number(page.total_count);
      if(!Number.isInteger(count)||count<0||count>20||!Number.isInteger(nextTotal)||nextTotal<0||!Array.isArray(page.item)||page.item.length!==count||total!==undefined&&total!==nextTotal)throw Error('WECHAT_INVENTORY_INCOMPLETE');
      total=nextTotal;
      for(const item of page.item){const id=String(item.media_id||item.article_id||'');if(!id||seen.has(id))throw Error('WECHAT_INVENTORY_INCOMPLETE');seen.add(id);items.push(item);}
      if(offset+count===total){
        if(items.some(item=>!readableWechatInventoryItem(item)))throw Error('WECHAT_INVENTORY_DETAILS_INCOMPLETE');
        return items;
      }
      if(count!==20||offset+count>total)throw Error('WECHAT_INVENTORY_INCOMPLETE');
    }
    throw Error('WECHAT_INVENTORY_INCOMPLETE');
  }

function readableWechatInventoryItem(item:any):boolean{
  const articles=item.content?.news_item;
  return !item.truncated&&!item.no_content&&!item.content?.truncated&&Array.isArray(articles)&&articles.length>0&&articles.length<=8&&articles.every((article:any)=>typeof article.title==='string'&&Boolean(article.title.trim())&&typeof article.content==='string'&&Boolean(article.content.replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;|\s/g,'').trim())&&!article.truncated);
}
