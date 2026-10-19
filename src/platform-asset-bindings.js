/** Explicit per-platform assets; never infers one platform's cover for another. */
export function platformAssetBindings(metadata,assets,platform){
 const maps=metadata.platform_assets;if(maps===undefined)return null;
 const declared=maps?.[platform];if(!Array.isArray(declared)||!declared.length)throw Error('PLATFORM_ASSETS_MISSING:'+platform);
 const seen=new Set();return declared.map((entry,index)=>{
  if(!entry||typeof entry.filename!=='string'||seen.has(entry.filename)||entry.role!==(index===0?'COVER':'BODY_INFOGRAPHIC'))throw Error('PLATFORM_ASSET_ROLE_INVALID:'+platform);
  seen.add(entry.filename);const found=assets.filter(a=>a.filename===entry.filename);if(found.length!==1)throw Error('PLATFORM_ASSET_UNRESOLVED:'+platform);
  return {asset:found[0],role:index===0?'cover':'gallery_image',ordinal:index};
 });
}
