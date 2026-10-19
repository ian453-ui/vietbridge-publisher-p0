export function groupFilterTerms(value){
  return String(value??'').split(/[,，;；\n]+/).map(x=>x.trim().toLocaleLowerCase()).filter(Boolean).slice(0,20);
}

export function groupNameMatches(name,{include='',exclude=''}={}){
  const title=String(name??'').toLocaleLowerCase();
  const includes=groupFilterTerms(include),excludes=groupFilterTerms(exclude);
  return (!includes.length||includes.some(term=>title.includes(term)))&&!excludes.some(term=>title.includes(term));
}
