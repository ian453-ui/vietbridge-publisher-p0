import test from 'node:test';import assert from 'node:assert/strict';
import {platformAssetBindings} from '../src/platform-asset-bindings.js';
import {ContentLibrary} from '../src/publisher-core/content-library.ts';import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
const assets=['social.png','wechat.png','body.png'].map((filename,i)=>({assetId:String(i),filename,path:'/fixture/'+filename}));
test('explicit platform covers preserve distinct identity/order/roles with no banner in body',()=>{
 const metadata={platform_assets:{facebook:[{filename:'social.png',role:'COVER'},{filename:'body.png',role:'BODY_INFOGRAPHIC'}],wechat_official_account:[{filename:'wechat.png',role:'COVER'},{filename:'body.png',role:'BODY_INFOGRAPHIC'}]}};
 const fb=platformAssetBindings(metadata,assets,'facebook'),wc=platformAssetBindings(metadata,assets,'wechat_official_account');assert.equal(fb[0].asset.filename,'social.png');assert.equal(wc[0].asset.filename,'wechat.png');assert.deepEqual(wc.map(x=>x.role),['cover','gallery_image']);assert.equal(wc[1].asset.filename,'body.png');assert.throws(()=>platformAssetBindings(metadata,assets,'xiaohongshu'),/MISSING/);
});
test('real index keeps platform cover roles distinct and explicit visual failure blocks readiness',()=>{
 const root=join(mkdtempSync(join(tmpdir(),'platform-covers-')),'Daily-901');mkdirSync(root);try{
 for(const name of ['social.png','wechat.png','body.png'])writeFileSync(join(root,name),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64'));
 for(const name of ['Daily-901-facebook-public.txt','Daily-901-wechat-public.md'])writeFileSync(join(root,name),'Title\n\nApproved body');
 const bindings={facebook:[{filename:'social.png',role:'COVER'},{filename:'body.png',role:'BODY_INFOGRAPHIC'}],wechat_official_account:[{filename:'wechat.png',role:'COVER'},{filename:'body.png',role:'BODY_INFOGRAPHIC'}]};
 writeFileSync(join(root,'manifest.json'),JSON.stringify({article_id:'Daily-901',title:'Title',active_assets:['social.png','wechat.png','body.png'],platform_assets:bindings,visual_review_issues:['SOCIAL_COVER_TEXT_OVERLAP_NOT_PASSED'],qa_status:'PENDING_FACT_QA',visual_qa_status:'PENDING',publication_authorized:false}));
 const item=new ContentLibrary({roots:[root],readOnly:true}).index()[0];assert.deepEqual(item.variantAssetRoles.wechat_official_account.map(b=>({filename:item.assets.find(a=>a.assetId===b.assetId).filename,role:b.role})),[{filename:'wechat.png',role:'cover'},{filename:'body.png',role:'gallery_image'}]);assert.equal(item.readiness,'BLOCKED');assert.ok(item.blockingReasons.includes('VISUAL_QA_PENDING'));assert.deepEqual(item.visualReviewIssues,['SOCIAL_COVER_TEXT_OVERLAP_NOT_PASSED']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('explicit platform image bindings reject missing, duplicated, swapped roles and ambiguous source files',()=>{
 for(const declared of [[],[{filename:'absent.png',role:'COVER'}],[{filename:'social.png',role:'BODY_INFOGRAPHIC'}],[{filename:'social.png',role:'COVER'},{filename:'social.png',role:'BODY_INFOGRAPHIC'}],[{filename:'social.png',role:'COVER'},{filename:'body.png',role:'COVER'}]])assert.throws(()=>platformAssetBindings({platform_assets:{facebook:declared}},assets,'facebook'));
 assert.throws(()=>platformAssetBindings({platform_assets:{facebook:[{filename:'social.png',role:'COVER'}]}},[...assets,assets[0]],'facebook'),/UNRESOLVED/);assert.equal(platformAssetBindings({},assets,'facebook'),null);
});
