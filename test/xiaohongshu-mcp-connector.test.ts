import test from "node:test";
import assert from "node:assert/strict";
import { findOwnFeed, XiaohongshuMcpConnector, XiaohongshuToolError } from "../src/xiaohongshu-mcp-connector.ts";

test('login tool deadline is classified without exposing connector details',async()=>{
  const connector=new XiaohongshuMcpConnector() as any;
  connector.connect=async()=>{};
  connector.client={callTool:async()=>({isError:true,content:[{type:'text',text:'工具 check_login_status 执行时发生内部错误: context deadline exceeded'}]})};
  await assert.rejects(connector.loginStatus(),(error:unknown)=>{
    assert.ok(error instanceof XiaohongshuToolError);
    assert.equal(error.category,'TIMEOUT');
    assert.match(error.message,/未提交/);
    assert.doesNotMatch(error.message,/context deadline/);
    return true;
  });
});

test('transport timeout is bounded and classified before any submit',async()=>{
  const connector=new XiaohongshuMcpConnector() as any;
  connector.connect=async()=>{};
  connector.client={callTool:async(_input:unknown,_schema:unknown,options:{timeout:number})=>{
    assert.equal(options.timeout,75_000);
    throw new Error('MCP error -32001: Request timed out');
  }};
  await assert.rejects(connector.loginStatus(),(error:unknown)=>{
    assert.ok(error instanceof XiaohongshuToolError);
    assert.equal(error.category,'TIMEOUT');
    return true;
  });
});

test('empty login username resolves from own profile instead of the next status line',async()=>{
  const connector=new XiaohongshuMcpConnector() as any;
  const calls:string[]=[];
  connector.callText=async(name:string)=>{
    calls.push(name);
    if(name==='check_login_status')return '✅ 已登录\n用户名: \n\n你可以使用其他功能了。';
    return JSON.stringify({userBasicInfo:{nickname:'Vietbridge 越南商学院'}});
  };
  assert.deepEqual(await connector.loginStatus(),{loggedIn:true,accountId:'username:Vietbridge 越南商学院'});
  assert.deepEqual(calls,['check_login_status','get_my_profile']);
});

test('missing profile identity does not authorize a different account',async()=>{
  const connector=new XiaohongshuMcpConnector() as any;
  connector.close=async()=>{};
  connector.callText=async(name:string)=>name==='check_login_status'?'已登录\n用户名: \n你可以使用其他功能了。':JSON.stringify({userBasicInfo:{}});
  assert.deepEqual(await connector.loginStatus(),{loggedIn:true,accountId:undefined});
});

test('incomplete first profile is retried before declaring account mismatch',async()=>{
  const connector=new XiaohongshuMcpConnector() as any;
  let reads=0,closes=0;
  connector.close=async()=>{closes++};
  connector.callText=async(name:string)=>name==='check_login_status'?'已登录\n用户名: ':JSON.stringify({userBasicInfo:++reads===1?{}:{nickname:'Vietbridge 越南商学院'}});
  assert.equal((await connector.loginStatus()).accountId,'username:Vietbridge 越南商学院');
  assert.equal(reads,2);assert.equal(closes,1);
});

test('stalled profile read reconnects once without submitting',async()=>{
  const connector=new XiaohongshuMcpConnector() as any;
  let reads=0,closes=0;
  connector.close=async()=>{closes++};
  connector.callText=async(name:string)=>{
    if(name==='check_login_status')return '已登录\n用户名: ';
    reads++;
    if(reads===1)throw new XiaohongshuToolError(name,'TIMEOUT');
    return JSON.stringify({userBasicInfo:{nickname:'Vietbridge 越南商学院'}});
  };
  assert.equal((await connector.loginStatus()).accountId,'username:Vietbridge 越南商学院');
  assert.equal(reads,2);
  assert.equal(closes,1);
});

test("current-profile readback requires exact title and exact author", () => {
  const response = JSON.stringify({ feeds: [
    { id: "note-1", xsecToken: "token", noteCard: { displayTitle: "越南工会经费2%", user: { nickname: "Vietbridge 越南商学院" } } },
    { id: "note-2", noteCard: { displayTitle: "越南工会经费2%", user: { nickname: "其他账号" } } }
  ] });
  assert.deepEqual(findOwnFeed(response, "越南工会经费2%", "Vietbridge 越南商学院"), { id: "note-1", xsecToken: "token" });
  assert.equal(findOwnFeed(response, "越南工会经费", "Vietbridge 越南商学院"), undefined);
  assert.equal(findOwnFeed("not-json", "越南工会经费2%", "Vietbridge 越南商学院"), undefined);
  const crossItems=JSON.stringify({feeds:[{id:'a',noteCard:{displayTitle:'目标标题',user:{nickname:'别的作者'}}},{id:'b',noteCard:{displayTitle:'其他标题',user:{nickname:'本人'}}}]});
  assert.equal(findOwnFeed(crossItems,'目标标题','本人'),undefined);
});

test("profile readback remains usable when search is temporarily unavailable",async()=>{
  const connector=new XiaohongshuMcpConnector() as any;
  connector.callText=async(name:string)=>{
    if(name==='get_my_profile')return JSON.stringify({feeds:[{id:'newest',noteCard:{displayTitle:'别的内容',user:{nickname:'Vietbridge 越南商学院'}}}]});
    throw new Error('temporary VPN failure');
  };
  const result=await connector.findPublished({accountId:'username:Vietbridge 越南商学院',payloadFingerprint:'hash',title:'目标内容'});
  assert.equal(result.status,'unavailable');
  assert.deepEqual(result.evidence,{reason:'own_profile_checked_search_temporarily_unavailable',ownProfileReadback:true});
});

test("exact search match skips the broken profile-sidebar navigation",async()=>{
  const connector=new XiaohongshuMcpConnector() as any;
  connector.callText=async(name:string)=>{
    assert.equal(name,'search_feeds');
    return JSON.stringify({feeds:[{id:'note-72',noteCard:{displayTitle:'目标内容',user:{nickname:'Vietbridge 越南商学院'}}}]});
  };
  const result=await connector.findPublished({accountId:'username:Vietbridge 越南商学院',payloadFingerprint:'hash',title:'目标内容'});
  assert.equal(result.status,'match');
  assert.equal(result.noteId,'note-72');
});

test("readback health uses a parseable search result without depending on the broken profile sidebar",async()=>{
  const connector=new XiaohongshuMcpConnector() as any;
  connector.callText=async(name:string,args:Record<string,unknown>)=>{
    assert.equal(name,'search_feeds');
    assert.equal(args.keyword,'越南');
    return JSON.stringify({feeds:[{},{}]});
  };
  assert.deepEqual(await connector.readbackHealth(),{ok:true,feedCount:2});
  connector.callText=async()=>'{broken';
  assert.deepEqual(await connector.readbackHealth(),{ok:false,feedCount:0});
});
