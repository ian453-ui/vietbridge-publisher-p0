// API responses must be JSON. A tunnel or login page must never be parsed as customer data.
export async function readApiJson(response,{label='数据'}={}){
 const status=response.status,contentType=response.headers?.get?.('content-type')||'';
 const destination=new URL(response.url||'/api/',globalThis.location?.origin||'https://publisher.vietbridge.one');
 const error=(message,retryable=false)=>Object.assign(new Error(message),{retryable});
 if(status===401||destination.pathname==='/login')throw error('登录已失效，请重新登录 Publisher');
 if(status===403)throw error('当前登录无权读取'+label+'，请检查客户权限');
 if(!/^application\/json(?:\s*;|\s*$)/i.test(contentType)){
  const transient=status===200||[502,503,504].includes(status);
  throw error(label+'连接返回页面而非 JSON（HTTP '+status+'）；请检查连接后重新加载所选客户',transient);
 }
 let value;try{value=await response.json();}catch{throw error(label+'响应不是有效 JSON（HTTP '+status+'）；请重新加载所选客户');}
 if(!response.ok)throw error(value?.error||label+'读取失败（HTTP '+status+'）',[502,503,504].includes(status));
 return value;
}
