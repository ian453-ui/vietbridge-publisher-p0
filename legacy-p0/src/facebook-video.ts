import {readFileSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,basename} from 'node:path';
import {execFileSync} from 'node:child_process';
import axios, {type AxiosRequestConfig} from 'axios';
import {normalizeLocalConfig,parseConfig} from './facebook-accounts.ts';

type Json=Record<string,any>;
// Meta's official Page.create_video supports source uploads to /{page-id}/videos.
// Tokens are held in memory, never included in URLs, receipts or thrown messages.
export class FacebookVideo {
  private token='';
  private page='';
  private version='v25.0';
  private request?:typeof fetch;
  private readonly configFile:string;
  private readonly expectedName:string;
  constructor(request?:typeof fetch,configFile=resolve(homedir(),'.config/vietbridge-social/credentials.env'),expectedName='VietBridge Group'){this.request=request;this.configFile=configFile;this.expectedName=expectedName;}
  private async call(path:string,init:RequestInit={},token=this.token):Promise<Json>{
    const submitting=init.method==='POST',url='https://graph.facebook.com/'+this.version+'/'+path,timeout=submitting?900_000:30_000;
    let result:Json,status=0;
    try{
      if(this.request){const response=await this.request(url,{...init,headers:{...init.headers,Authorization:'Bearer '+token},signal:AbortSignal.timeout(timeout),redirect:'error'});status=response.status;result=await response.json() as Json;}
      else{const headers=Object.fromEntries(new Headers(init.headers).entries());const config:AxiosRequestConfig={url,method:init.method||'GET',headers:{...headers,Authorization:'Bearer '+token},data:init.body,timeout,maxRedirects:0,validateStatus:()=>true,maxBodyLength:Infinity,maxContentLength:Infinity,proxy:systemHttpsProxy()};const response=await axios.request(config);status=response.status;result=response.data as Json;}
    }catch{throw new Error(submitting?'Facebook 视频上传连接中断；任务已进入只读核对，禁止自动重发':'Facebook 只读接口暂时连接失败；尚未提交，可安全重试');}
    if(!result||typeof result!=='object')throw new Error('Facebook 返回无法解析的结果，需核对平台记录');
    if(status<200||status>=300||result.error)throw new Error('Facebook 接口错误 HTTP '+status+' code '+Number(result.error?.code||0)+' subcode '+Number(result.error?.error_subcode||0));
    return result;
  }
  async connect(expectedPage:string):Promise<void>{
    if(this.token&&this.page===expectedPage)return;
    const config=parseConfig(normalizeLocalConfig(this.configFile));
    const value=(key:string)=>config[key];
    this.page=value('FB_PAGE_ID')||'';
    if(!/^\d+$/.test(this.page)||this.page!==expectedPage)throw new Error('Facebook 目标主页与配置不一致');
    const version=value('FB_GRAPH_API_VERSION');if(version&&/^v\d+\.\d+$/.test(version))this.version=version;
    // The Page connector refreshes its user token into a private cache. The
    // credentials file may still contain the now-invalid predecessor token.
    const cacheFile=process.env.VIETBRIDGE_FB_TOKEN_CACHE_FILE||'/Users/a1-6/claude/fb-mcp/fb-user-token.json';
    const candidates=facebookUserTokenCandidates(config,cacheFile,this.page);
    if(!candidates.length)throw new Error('Facebook 缺少有效既有授权；不自动连接新账号');
    let lastError:unknown;
    for(const user of candidates){
      try{
        const accounts=await this.call('me/accounts?fields=id,name,access_token,tasks&limit=100',{},user);
        const page=accounts.data?.find((p:Json)=>p.id===this.page&&p.name===this.expectedName&&p.tasks?.includes('CREATE_CONTENT'));
        if(!page?.access_token)throw new Error('Facebook 主页身份或发布权限未核实');
        this.token=page.access_token;
        return;
      }catch(error){lastError=error;}
    }
    throw lastError;
  }
  async list():Promise<Json>{return this.call(this.page+'/videos?fields=id,title,description,published,permalink_url&limit=100');}
  async upload(file:string,title:string,description:string):Promise<Json>{
    if(!this.token)throw new Error('Facebook 尚未核实账号');
    const size=statSync(file).size;if(size<=0||size>100_000_000)throw new Error('本地视频超出当前单次上传大小限制');
    const form=new FormData();
    form.set('source',new Blob([readFileSync(file)],{type:'video/mp4'}),basename(file));
    form.set('title',title);form.set('description',description);form.set('published','true');
    // Never retry a mutation, including after a timeout.
    return this.call(this.page+'/videos',{method:'POST',body:form});
  }
  async get(id:string):Promise<Json>{
    if(!/^\d+$/.test(id))throw new Error('Facebook 视频 ID 无效');
    const result=await this.call(id+'?fields=id,title,description,published,status,permalink_url,from');
    if(/^\/(?:reel|watch|[^/]+\/videos)\//.test(String(result.permalink_url||'')))result.permalink_url='https://www.facebook.com'+result.permalink_url;
    return result;
  }
}

export function facebookUserTokenCandidates(config:Record<string,string>,cacheFile:string,pageId:string):string[]{
  const tokens:string[]=[];
  try{
    const info=statSync(cacheFile);
    if(info.isFile()&&(info.mode&0o077)===0){
      const cached=JSON.parse(readFileSync(cacheFile,'utf8')) as {token?:unknown;pageId?:unknown};
      if(cached.pageId===pageId&&typeof cached.token==='string'&&cached.token)tokens.push(cached.token);
    }
  }catch{/* Missing or invalid cache falls back to the account's own config. */}
  if(config.FB_USER_ACCESS_TOKEN&&!tokens.includes(config.FB_USER_ACCESS_TOKEN))tokens.push(config.FB_USER_ACCESS_TOKEN);
  return tokens;
}

export function systemHttpsProxy():AxiosRequestConfig['proxy']{
  try{return parseSystemHttpsProxy(execFileSync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8',timeout:2000}));}catch{/* direct connection remains available */}
  return false;
}
export function parseSystemHttpsProxy(raw:string):AxiosRequestConfig['proxy']{const enabled=/HTTPSEnable\s*:\s*1/.test(raw),host=raw.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1],port=Number(raw.match(/HTTPSPort\s*:\s*(\d+)/)?.[1]);return enabled&&host&&Number.isInteger(port)&&port>0?{protocol:'http',host,port}:false;}

export function verifiedFacebookVideo(result:Json,id:string,page:string,title:string,description:string):boolean{
  return result.id===id&&result.from?.id===page&&result.title===title&&String(result.description||'').trim()===description.trim()
    &&result.published===true&&result.status?.video_status==='ready'&&/^https:\/\/(?:www\.)?facebook\.com\//.test(result.permalink_url||'');
}
