import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {parse} from 'yaml';

type Json = Record<string,any>;
export class WechatDraftReader {
  private token='';
  private request:typeof fetch;
  constructor(request:typeof fetch=fetch) {this.request=request;}
  private async post(path:string,body:Json,token=false):Promise<Json> {
    try {
      const response=await this.request('https://api.weixin.qq.com/'+(path.startsWith('datacube/')?path:'cgi-bin/'+path)+(token?'?access_token='+encodeURIComponent(this.token):''),{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30_000)
      });
      if(!response.ok) throw new Error('HTTP '+response.status);
      const data=await response.json() as Json;
      if(data.errcode) throw new Error('微信接口错误码 '+Number(data.errcode));
      return data;
    }catch(error){
      // Never propagate fetch URLs, API errmsg, credentials or request bodies.
      const message=error instanceof Error?error.message:'';
      throw new Error(/^(微信接口错误码 \d+|HTTP \d+)$/.test(message)?message:'微信公众号接口读取失败或超时，不能据此判断草稿不存在');
    }
  }
  private async connect():Promise<void> {
    if(this.token)return;
    const file=readFileSync(resolve(homedir(),'.config/vietbridge-social/credentials.env'),'utf8');
    const value=(key:string)=>process.env[key]||file.match(new RegExp('^(?:export\\s+)?'+key+'\\s*=\\s*(.*)$','m'))?.[1]?.trim().replace(/^(["'])(.*)\1$/,'$2');
    const appid=value('WECHAT_APP_ID'),secret=value('WECHAT_APP_SECRET');
    if(!appid||!secret)throw new Error('公众号凭据未配置');
    const data=await this.post('stable_token',{grant_type:'client_credential',appid,secret,force_refresh:false});
    if(!data.access_token)throw new Error('公众号凭据验证未返回有效结果');
    this.token=String(data.access_token);
  }
  async get(mediaId:string):Promise<Json>{await this.connect();return this.post('draft/get',{media_id:mediaId},true);}
  async list(offset=0):Promise<Json>{await this.connect();return this.post('draft/batchget',{offset,count:20,no_content:0},true);}
  async publishedList(offset=0):Promise<Json>{await this.connect();return this.post('freepublish/batchget',{offset,count:20,no_content:0},true);}
  async articleSummary(date:string):Promise<Json>{await this.connect();return this.post('datacube/getarticlesummary',{begin_date:date,end_date:date},true);}
  async articleTotal(date:string):Promise<Json>{await this.connect();return this.post('datacube/getarticletotal',{begin_date:date,end_date:date},true);}
  async delete(mediaId:string):Promise<void>{await this.connect();await this.post('draft/delete',{media_id:mediaId},true);}
}

export function verifyWechatDraft(markdown:string,draft:Json):boolean {
  const front=markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if(!front)return false;
  const expected=parse(front[1]);
  const articles=draft.news_item;
  if(!Array.isArray(articles)||articles.length!==1)return false;
  const item=articles[0];
  const plain=(s:string)=>s
    // Wenyan appends reference numbers after linked source labels. They are
    // renderer-generated annotations, not a change to the approved copy.
    .replace(/<sup\b[^>]*\bclass=["'][^"']*\bfootnote\b[^"']*["'][^>]*>[\s\S]*?<\/sup>/giu,'')
    .replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,'');
  const expectedText=(s:string)=>plain(s
    .replace(/^\s*(?:>\s*)?(?:\d+[.)、]|[-*+])\s+/u,'')
    .replace(/!\[[^\]]*\]\([^)]+\)/g,'')
    .replace(/\[([^\]]+)\]\([^)]+\)/g,'$1')
    .replace(/[*_~`]/g,''));
  const body=markdown.slice(front[0].length).split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#')&&!s.startsWith('![')&&!/^\|?\s*:?-{3,}/.test(s));
  const cover=Boolean(item.thumb_media_id)||/^https?:\/\/mmbiz\.qpic\.cn\//i.test(String(item.thumb_url||''));
  const rendered=plain(String(item.content||''));
  const headingColor=(value:string)=>{
    const hex=value.match(/\bcolor\s*:\s*#([0-9a-f]{6})\b/iu)?.[1];
    if(hex)return hex.toUpperCase();
    const rgb=value.match(/\bcolor\s*:\s*rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/iu);
    return rgb?rgb.slice(1).map(part=>Number(part).toString(16).padStart(2,'0')).join('').toUpperCase():undefined;
  };
  const expectedHeadings=markdown.slice(front[0].length).split(/\r?\n/u).flatMap(line=>{
    const md=line.match(/^(#{2,3})\s+(.+)$/u),html=line.match(/^<h([23])\b[^>]*>([\s\S]*?)<\/h\1>$/iu);
    if(md)return [{level:md[1].length,text:plain(md[2]),color:headingColor(md[2])}];
    if(html)return [{level:Number(html[1]),text:plain(html[2]),color:headingColor(line)}];
    return [];
  });
  const actualHeadings=[...String(item.content||'').matchAll(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/giu)].map(match=>({level:Number(match[1]),text:plain(match[2]),html:match[0]}));
  return item.title===expected.title && (!expected.author||item.author===expected.author) && cover
    && expectedHeadings.every((heading,index)=>actualHeadings[index]?.level===heading.level&&actualHeadings[index]?.text.includes(heading.text)&&(!heading.color||headingColor(actualHeadings[index].html)===heading.color))
    && body.length>0 && body.every(paragraph=>{
      if(paragraph.startsWith('|'))return paragraph.split('|').map(cell=>expectedText(cell)).filter(Boolean).every(cell=>rendered.includes(cell));
      const expectedParagraph=expectedText(paragraph);return !expectedParagraph||rendered.includes(expectedParagraph);
    });
}
