/** Explicit newer QA defeats legacy READY/filename flags. Missing QA metadata
 * keeps historical client manifests compatible; it does not assert new QA proof. */
export function clientManifestQa(manifest,entry){
 const states=[manifest,entry].filter(x=>Object.hasOwn(x,'qa_status')).map(x=>typeof x.qa_status==='string'?x.qa_status.trim().toUpperCase():'UNKNOWN');
 const blocked=states.some(x=>x!=='PASS');
 return {explicit:states.length>0,states,blocked,assetState:states.includes('FAIL')?'FAIL':blocked?'UNKNOWN':'PASS'};
}
