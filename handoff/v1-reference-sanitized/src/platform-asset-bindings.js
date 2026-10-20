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

/** The same frozen selection is used for submission and reviewer previews. */
export function frozenPlatformAssets(canonical,assets,platform){
 if(!canonical.platformAssets)return assets;
 const bindings=canonical.platformAssets[platform];
 if(!Array.isArray(bindings)||!bindings.length||new Set(bindings.map(b=>b.assetId)).size!==bindings.length)throw Error('FROZEN_PLATFORM_ASSET_UNVERIFIED');
 return bindings.map((b,i)=>{const matches=assets.filter(a=>a.source_asset_id===b.assetId);if(matches.length!==1||b.role!==(i===0?'cover':'gallery_image'))throw Error('FROZEN_PLATFORM_ASSET_UNVERIFIED');return {...matches[0],role:b.role,ordinal:i+1,sequence:i};});
}
