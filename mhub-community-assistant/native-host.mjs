import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {startHostBackend,createHostStatusWriter} from './host-startup.mjs';
import { apply as applyTools, name } from './dsh-plugin.mjs';
import {PANEL_PREFIX,PANEL_ASSET_ROUTES,PANEL_API_ROUTES,PANEL_GET_ROUTES,PANEL_VERSION} from './panel-service.mjs';
import {attachHarnessCompanion} from './companion/harness-adapter.mjs';
import {LearningClient} from './learning-client.mjs';
import {createNativeProxy} from './native-proxy.mjs';
import {atomicJson} from './companion/config.mjs';
import {runtimeVersion} from '../harness-mhub-sync/runtime-version.mjs';
// Capture at module load, so reapplying cached code cannot claim a newer disk version.
const loadedRuntimeVersion=runtimeVersion();
if(process.versions.electron)try{atomicJson(fileURLToPath(new URL('state/companion/module-loaded.json',import.meta.url)),{pid:process.pid,at:Date.now(),version:PANEL_VERSION,stage:'imported'});}catch{}
export { name };
// Task/balance/voice hosting must not wait for an optional tool registry.
export const inject=[];
export function attachLearningLifecycle(ctx,scheduler){scheduler.start();let closed=false;const close=async()=>{if(closed)return;closed=true;await scheduler.stop();};ctx.effect(()=>close);return close;}
export async function apply(ctx, config = {}, {startBackend=startHostBackend}={}) {
  const moduleRoot=path.dirname(fileURLToPath(import.meta.url));
  if(config.stateDir!==undefined&&(typeof config.stateDir!=='string'||config.stateDir.length>1024||config.stateDir.includes('\0')))throw Error('插件数据目录无效。');
  const stateDir=path.resolve(moduleRoot,config.stateDir??'state');
  let currentStage='loading',backend={phase:'checking'};
  const hostStatus=createHostStatusWriter({file:path.join(stateDir,'companion/native-host-status.json'),version:PANEL_VERSION,runtimeVersion:loadedRuntimeVersion});
  const record=(stage,error)=>{currentStage=stage;hostStatus.record(stage,backend,error);};
  record('loading');
  const startupAbort=new AbortController();ctx.effect(()=>()=>{hostStatus.close();startupAbort.abort(Error('插件已停止。'));});
  const bridgeFiber=ctx.inject(['agents','sessions','settings'],owner=>{try{attachHarnessCompanion(owner,stateDir);record('attached');}catch(error){record('failed',error);throw error;}});
  ctx.effect(()=>()=>bridgeFiber.dispose());
  const toolFiber=ctx.inject(['tools'],owner=>applyTools(owner,config));
  ctx.effect(()=>()=>toolFiber.dispose());
  const scheduler=new LearningClient({stateDir,version:PANEL_VERSION}),handler=createNativeProxy({owner:scheduler.owner,stateDir});
  // Reuse the existing guard. The timer below belongs to this plugin only;
  // it does not keep automatic learning running after Harness is closed.
  if(process.platform==='win32'){
    const result=await startBackend({root:moduleRoot,stateDir,signal:startupAbort.signal,onState:value=>{backend=value;record(currentStage);}});
    void result.ready;
  }
  // Disposal can occur while the Windows launcher is still awaiting spawn.
  // A late result must not register a fresh scheduler or connection afterward.
  startupAbort.signal.throwIfAborted();
  attachLearningLifecycle(ctx,scheduler);
  const fiber = ctx.inject(['connection'], owner => {
    for (const suffix of [...PANEL_ASSET_ROUTES,...PANEL_API_ROUTES]) {
      owner.connection.fetch.register({ path: PANEL_PREFIX + suffix, methods: PANEL_ASSET_ROUTES.includes(suffix)?['GET']:PANEL_GET_ROUTES.includes(suffix)?['GET','POST']:['POST'], requestBody: 'buffered', fetch: handler });
    }
  });
  ctx.effect(() => () => fiber.dispose());
  let connected = false; try { connected = Boolean(ctx.get('connection')); } catch {}
  if (connected) try { await fiber.await(); } catch (error) { await fiber.dispose(); throw error; }
}
export default { name, inject, apply };
