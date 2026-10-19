const formatter=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});

/** VietBridge's operating day starts at 07:00 in Asia/Shanghai. */
export function operatingDay(value){
 const ms=typeof value==='number'?value:Date.parse(value);
 if(!Number.isFinite(ms))throw Error('INVALID_OPERATING_TIME');
 const parts=Object.fromEntries(formatter.formatToParts(new Date(ms)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
 const calendar=Date.UTC(parts.year,parts.month-1,parts.day);
 return new Date(calendar-(parts.hour<7?86400000:0)).toISOString().slice(0,10);
}
