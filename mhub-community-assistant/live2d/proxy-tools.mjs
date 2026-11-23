import fs from 'node:fs';
import path from 'node:path';
import {live2dToolDefinitions} from './tools.mjs';

// Harness is an optional client of the same standalone Live2D service.
export function live2dTools(stateDir,{fetchImpl=fetch}={}) {
 return live2dToolDefinitions.map(({properties,required=[],...definition})=>({
  ...definition,parameters:{type:'object',properties,required,additionalProperties:false},timeoutMs:20000,
  output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
  async execute(args,exec={}) {
   if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!Object.hasOwn(properties,key))||required.some(key=>!Object.hasOwn(args,key)))throw Error('Live2D 工具参数不完整或含未知字段。');
   const host=JSON.parse(fs.readFileSync(path.join(stateDir,'live2d/host.json'),'utf8'));
   if(host.baseUrl!=='http://127.0.0.1:18782'||host.api!=='/api/mhub-community/live2d'||!/^[a-f0-9]{64}$/.test(host.token))throw Error('内置 Live2D 连接资料无效，请启动迈从大肥鱼后台。');
   const response=await fetchImpl(host.baseUrl+host.api+'/tool',{method:'POST',headers:{'content-type':'application/json','x-pet-token':host.token},body:JSON.stringify({name:definition.name,args}),redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(18000),...(exec.signal?[exec.signal]:[])])});
   const value=await response.json();if(!response.ok||value.ok===false)throw Error(value.message||value.error||'Live2D 工具未完成操作。');return value;
  }
 }));
}
