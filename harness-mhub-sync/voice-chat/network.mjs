import * as http from 'node:http';

// Standalone Node fetch does not automatically follow the proxy environment
// used by Harness. Enable it explicitly while always keeping our bridges local.
export function configureVoiceNetwork({env=process.env,install=http.setGlobalProxyFromEnv}={}){
 const configured=!!(env.HTTPS_PROXY||env.https_proxy||env.HTTP_PROXY||env.http_proxy);
 const bypass=[env.NO_PROXY,env.no_proxy,'localhost','127.0.0.1','::1'].filter(Boolean).join(',');
 if(configured&&typeof install!=='function')return {externalProxy:false,localBypass:true,error:'当前Node不支持环境代理，请使用支持该功能的版本。'};
 try{if(configured)install({...env,NO_PROXY:bypass,no_proxy:bypass});return {externalProxy:configured,localBypass:true,error:null};}
 catch{return {externalProxy:false,localBypass:true,error:'环境代理配置无效，请检查HTTP_PROXY或HTTPS_PROXY。'};}
}
export async function probeImageNetwork({fetchImpl=fetch,network}={}){
 const started=Date.now();
 try{
  // No credential, no image generation, no billable operation.
  const response=await fetchImpl('https://api.openai.com/v1/models',{redirect:'error',signal:AbortSignal.timeout(12000)});
  await response.body?.cancel();
  return {reachable:true,status:response.status,elapsedMs:Date.now()-started,network,paidCalls:0};
 }catch(error){return {reachable:false,elapsedMs:Date.now()-started,cause:error.cause?.code??error.name,network,paidCalls:0};}
}
