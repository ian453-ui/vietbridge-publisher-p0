import { createHash,randomBytes } from 'node:crypto';
import { existsSync,readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const scriptDir=dirname(fileURLToPath(import.meta.url));
const helper=resolve(scriptDir,'mac-keychain.swift');
const credentialsPath=process.env.GD_CREDENTIALS_PATH;
if(!credentialsPath||!existsSync(credentialsPath))throw new Error('GD_CREDENTIALS_PATH must point to the existing Desktop OAuth client JSON.');
const installed=JSON.parse(readFileSync(credentialsPath,'utf8')).installed;
if(!installed?.client_id||!installed?.client_secret||!installed?.token_uri)throw new Error('The configured OAuth client JSON is not a Desktop client.');
const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
const challenge=createHash('sha256').update(verifier).digest('base64url');
const server=createServer();
await new Promise<void>(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
const address=server.address();if(!address||typeof address==='string')throw new Error('Could not open a local OAuth callback.');
const redirectUri=`http://127.0.0.1:${address.port}`;
const callback=new Promise<string>((resolveCode,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('Google Drive OAuth timed out.')),10*60_000);timeout.unref();
  server.on('request',(req,res)=>{
    const query=new URL(req.url??'/',redirectUri).searchParams;
    if(query.get('state')!==state){res.writeHead(400,{'content-type':'text/plain'});res.end('Authorization state mismatch.');return;}
    if(query.get('error')){res.writeHead(400,{'content-type':'text/plain'});res.end('Google Drive authorization was not granted.');clearTimeout(timeout);reject(new Error('GOOGLE_DRIVE_AUTH_DECLINED'));server.close();return;}
    const code=query.get('code');if(!code){res.writeHead(400,{'content-type':'text/plain'});res.end('Authorization code missing.');return;}
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<h2>授权完成，可以关闭这个页面并返回 Publisher。</h2>');clearTimeout(timeout);resolveCode(code);server.close();
  });
});
const authUrl=new URL(installed.auth_uri??'https://accounts.google.com/o/oauth2/v2/auth');
for(const [key,value] of Object.entries({client_id:installed.client_id,redirect_uri:redirectUri,response_type:'code',scope:'https://www.googleapis.com/auth/drive.readonly',access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'}))authUrl.searchParams.set(key,value);
execFileSync('/usr/bin/open',[authUrl.toString()],{stdio:'ignore'});
console.log('已在系统浏览器打开 Google Drive 只读授权页面；请完成 Google 确认。');
let code:string;
try{code=await callback;}finally{server.close();}
const body=new URLSearchParams({code,client_id:installed.client_id,client_secret:installed.client_secret,redirect_uri:redirectUri,grant_type:'authorization_code',code_verifier:verifier});
const response=await fetch(installed.token_uri,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
if(!response.ok)throw new Error(`GOOGLE_DRIVE_TOKEN_EXCHANGE_HTTP_${response.status}`);
const result=await response.json() as {refresh_token?:string};
if(!result.refresh_token)throw new Error('Google did not return a refresh token; no credential was stored. Re-run authorization and approve offline access.');
execFileSync('/usr/bin/swift',[helper,'set','com.vietbridge.publisher.google-drive-refresh-token'],{input:result.refresh_token,encoding:'utf8',stdio:['pipe','ignore','ignore'],timeout:30_000});
console.log('已将 Drive 只读 refresh token 保存到当前 macOS 用户钥匙串；没有写入项目文件、SQLite 或 Google Drive。');
