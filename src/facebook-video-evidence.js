// Shared original video result predicate; no transport or authority.
export function verifiedFacebookVideo(result,id,page,title,description){
  return result.id===id&&result.from?.id===page&&result.title===title&&String(result.description||'').trim()===description.trim()
    &&result.published===true&&result.status?.video_status==='ready'&&/^https:\/\/(?:www\.)?facebook\.com\//.test(result.permalink_url||'');
}
