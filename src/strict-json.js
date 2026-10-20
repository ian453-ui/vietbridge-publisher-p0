/** JSON syntax stays native; a second bounded scan rejects duplicate decoded keys. */
export function parseStrictJson(text){
 const parsed=JSON.parse(text);
 let i=0;
 const ws=()=>{while(/\s/.test(text[i]||'')&&i<text.length)i++;};
 const string=()=>{
  const start=i++;
  while(i<text.length){if(text[i]==='\\'){i+=2;continue;}if(text[i++]==='"')break;}
  return JSON.parse(text.slice(start,i));
 };
 const value=depth=>{
  if(depth>128)throw Error('JSON_NESTING_LIMIT');
  ws();
  if(text[i]==='"'){string();return;}
  if(text[i]==='{'){
   i++;ws();const keys=new Set();
   if(text[i]==='}'){i++;return;}
   while(i<text.length){
    ws();const key=string();if(keys.has(key))throw Error('DUPLICATE_JSON_KEY');keys.add(key);
    ws();i++;value(depth+1);ws();if(text[i++]==='}')return;
   }
  }else if(text[i]==='['){
   i++;ws();if(text[i]===']'){i++;return;}
   while(i<text.length){value(depth+1);ws();if(text[i++]===']')return;}
  }else{while(i<text.length&&!/[\s,\]}]/.test(text[i]))i++;}
 };
 value(0);
 return parsed;
}
