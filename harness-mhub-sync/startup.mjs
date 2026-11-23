import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {writeJson} from './resilience.mjs';
import {readDeviceLink,requireDeviceLink,automaticStopAllowsResume} from './device-link-mode.mjs';
import {probeMhubDebug} from './dependency-probe.mjs';
import {controllerOverdue} from './runtime-version.mjs';
import {prepareDriver} from './driver-startup.mjs';

const exec=promisify(execFile),ROOT=path.dirname(fileURLToPath(import.meta.url));
const read=async file=>{try{return JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));}catch{return null;}};
const alive=pid=>{try{if(!Number.isSafeInteger(pid)||pid<1)return false;process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
const pause=(ms,signal)=>new Promise((resolve,reject)=>{signal?.throwIfAborted();const done=()=>{signal?.removeEventListener('abort',abort);resolve();};const timer=setTimeout(done,ms);const abort=()=>{clearTimeout(timer);reject(signal.reason);};signal?.addEventListener('abort',abort,{once:true});});
export async function runtimeProbe({signal}={}){
 try{const {stdout}=await exec(await resolveControlPython(),['-X','utf8',path.join(ROOT,'runtime_probe.py')],{windowsHide:true,timeout:3500,maxBuffer:32768,signal});return JSON.parse(stdout);}
 catch(error){signal?.throwIfAborted();throw Error(error.code==='ENOENT'?'缺少本机进程检测组件，请检查已有 Python 环境。':'本机进程检测超时或不可用，已停止本次启动；可以重试。');}
}
async function installationSettings(root,readFile=fs.readFile){
 try{const data=JSON.parse((await readFile(path.resolve(root,'../runtime.settings.json'),'utf8')).replace(/^\uFEFF/,''));if(!data||typeof data!=='object'||Array.isArray(data))throw Error();return data;}
 catch(error){if(error.code==='ENOENT')return null;throw Error('运行环境配置无法读取，原文件已保留。');}
}
export async function resolveControlPython({env=process.env,home=homedir(),root=ROOT,stat=fs.stat,readFile=fs.readFile}={}){
 const settings=env.DAFEIYU_CONTROL_PYTHON?null:await installationSettings(root,readFile);
 const configured=env.DAFEIYU_CONTROL_PYTHON||settings?.python;
 const candidates=configured?[configured]:[
  path.resolve(root,'../.venv/Scripts/python.exe'),
  path.join(root,'runtime','python','python.exe'),
 ];
 for(const file of candidates){try{if((await stat(file)).isFile())return file;}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}}
 throw Object.assign(Error('进程检测 Python 不可用，请配置 DAFEIYU_CONTROL_PYTHON。'),{code:'ENOENT'});
}
async function fetchOk(url,fetchImpl,signal,timeout=700){
 try{return (await fetchImpl(url,{signal:AbortSignal.any([AbortSignal.timeout(timeout),...(signal?[signal]:[])])})).ok;}catch{signal?.throwIfAborted();return false;}
}
function localOrigin(value){try{const u=new URL(value);return u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password?u.origin:null;}catch{return null;}}
async function detachedNode(script,root){
 const child=spawn(process.execPath,[script,'--hold'],{cwd:root,windowsHide:true,detached:true,stdio:'ignore'});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return child.pid;
}
export async function resolveMhubExecutable({env=process.env,stat=fs.stat,root=ROOT,readFile=fs.readFile}={}){
 const dirs=[env.ProgramW6432,env.ProgramFiles,env['ProgramFiles(x86)']].filter(Boolean);
 const settings=env.DAFEIYU_MHUB_EXECUTABLE?null:await installationSettings(root,readFile);
 const configured=env.DAFEIYU_MHUB_EXECUTABLE||settings?.mhub;
 const candidates=configured?[configured]:[...new Set(dirs.map(dir=>path.join(dir,'M HUB','MCHOSE HUB.exe')))];
 for(const file of candidates){
  try{if((await stat(file)).isFile())return file;}
  catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
 }
 throw Error('找不到 M HUB 安装程序，请确认 M HUB 已安装。');
}
export function unavailableMhubMessage(meta){
 const mains=meta?.mhubMain;
 if(mains?.some(row=>row.debugRequested===true))return 'M HUB 已带联动参数启动，但 49763 接口没有响应。已保留当前驱动；请从托盘退出后等待自动恢复。';
 if(mains?.length&&mains.every(row=>row.debugRequested===false))return 'M HUB 当前是普通启动，未开放联动接口。请从右下角托盘退出 M HUB，再点恢复联动；无需修改设备配置。';
 return 'M HUB 正在运行，但联动接口没有响应，暂时无法核对启动参数。请从托盘退出 M HUB 后等待自动恢复；未重复启动驱动。';
}
export async function launchMhub({spawnImpl=spawn,execImpl=exec,resolveExecutable=resolveMhubExecutable,root=ROOT}={}){
 const executable=await resolveExecutable();
 // Chromium errors are retained locally for the next cold-boot diagnosis.
 // Only errors are logged; do not enable verbose network/request logging.
 const args=['--remote-debugging-address=127.0.0.1','--remote-debugging-port=49763','--enable-logging=file','--log-level=2','--log-file='+path.join(root,'mhub-startup.chromium.log')];
 const receipt={executable,startedAt:Date.now(),port:49763,diagnosticLog:path.join(root,'mhub-startup.chromium.log')};
 try{
  const pid=await new Promise((resolve,reject)=>{const child=spawnImpl(executable,args,{windowsHide:true,detached:true,stdio:'ignore'});child.once('spawn',()=>resolve(child.pid));child.once('error',reject);child.unref();});
  return {...receipt,method:'direct',pid:pid??null};
 }catch(error){
  if(!['EACCES','EPERM'].includes(error.code))throw error;
  // Shell launch handles Windows executable elevation/compatibility settings;
  // direct CreateProcess can be denied even when Start-Process works normally.
  try{const result=await execImpl('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; $launchArgs=ConvertFrom-Json -InputObject $env:DAFEIYU_MHUB_ARGS; (Start-Process -FilePath $env:DAFEIYU_MHUB_EXECUTABLE -ArgumentList $launchArgs -WindowStyle Hidden -PassThru).Id"],{env:{...process.env,DAFEIYU_MHUB_EXECUTABLE:executable,DAFEIYU_MHUB_ARGS:JSON.stringify(args.map(arg=>'\"'+arg+'\"'))},windowsHide:true,timeout:8000,maxBuffer:8192});const pid=Number(result?.stdout?.trim());return {...receipt,method:'shell',pid:Number.isSafeInteger(pid)&&pid>0?pid:null};}
  catch{throw Error('Windows 未能启动 M HUB，请先从桌面打开 M HUB 后重试；若提示普通启动，请从托盘退出后再恢复联动。');}
 }
}
export class SyncStartup{
 constructor({root=ROOT,fetchImpl=fetch,probe=runtimeProbe,startSupervisor=detachedNode,startMhub,clock=Date.now,isAlive=alive,driverStartup={}}={}){
  Object.assign(this,{root,fetch:fetchImpl,probe,startSupervisor,clock,isAlive,driverStartup});this.pending=null;this.file=path.join(root,'startup-status.json');
  this.startMhub=startMhub??(()=>launchMhub({root:this.root}));
 }
 async status(phase,message,extra={}){const record={phase,message,id:this.id,at:this.clock(),startedAt:this.startedAt,deadlineAt:this.startedAt+30000,...(this.driverLaunch?{driverLaunch:this.driverLaunch}:{}),...extra};await writeJson(pathToFileURL(this.file),record);return record;}
 async request({automatic=false}={}){
  requireDeviceLink(this.root);
  if(this.reserving||this.pending)return {pending:true,requestId:this.id,duplicate:true};
  this.reserving=true;
  try{
  this.id=randomUUID();this.startedAt=this.clock();this.abort=new AbortController();this.driverLaunch=null;
  await this.status('starting','正在检查连接…',{stage:'checking'});
  const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(28000)]);
  const task=this.execute(signal,{automatic}).catch(error=>this.status('failed',signal.aborted?'本次连接等待已结束，请查看 M HUB 状态后重试。':error.message,{stage:'failed'})).finally(()=>{if(this.pending===task)this.pending=null;});
  this.pending=task;void task.catch(error=>{this.lastError=error.message;});return {pending:true,requestId:this.id};
  }finally{this.reserving=false;}
 }
 cancel(){this.abort?.abort(Error('启动已取消'));}
 async execute(signal,{automatic=false}={}){
  requireDeviceLink(this.root);
  const checkAutomaticStop=()=>{if(automatic&&!automaticStopAllowsResume(this.root))throw Error('用户已停止设备联动，本次启动已取消。');};
  checkAutomaticStop();
  const pid=Number(await fs.readFile(path.join(this.root,'run.pid'),'utf8').catch(()=>0)),health=await read(path.join(this.root,'controller-health.json'));
  const stalled=controllerOverdue(health,pid,health?.startedAt??health?.lastProgressAt??this.startedAt,this.clock());
  if(this.isAlive(pid)&&health?.pid===pid&&this.clock()-health.at>=0&&this.clock()-health.at<5000&&health.phase==='running'&&health.connection?.state==='ready'&&!stalled)return this.status('started','设备联动已经运行。',{stage:'ready'});
  const meta=await this.probe({signal});signal.throwIfAborted();
  if(meta.hidAvailable===false)throw Error('当前启动环境无法加载 HID 驱动依赖，请使用本机正常权限启动联动；未创建新的设备控制进程。');
  const supervised=meta.supervisor.matches===true;
  if(!supervised&&(meta.controller.matches===null||meta.supervisor.matches===null))throw Error('Windows 不允许核对旧联动进程，未重复启动。请检查进程权限。');
  const sourceFile=path.join(this.root,'source-origin.json'),origin='http://127.0.0.1:18782';
  if(!await fetchOk(origin+'/api/mhub-community/companion/manifest',this.fetch,signal))throw Error('内部伙伴后台尚未就绪，请先启动迈从大肥鱼插件。无需启动原版大肥鱼或 AuraBot。');
  await writeJson(pathToFileURL(sourceFile),{origin});
  await prepareDriver({probeDebug:()=>probeMhubDebug(this.fetch,signal),probeRuntime:()=>this.probe({signal}),launch:()=>this.startMhub(),
   signal,clock:this.clock,wait:pause,describeUnavailable:unavailableMhubMessage,
   check:async()=>{requireDeviceLink(this.root);checkAutomaticStop();const intent=await read(path.resolve(this.root,'../mhub-community-assistant/state/runtime-intent.json'));if(intent?.sync===false&&intent.at>=this.startedAt)throw Error('用户已停止设备联动，本次启动已取消。');},
   onStage:(stage,message)=>this.status('starting',message,{stage}),
   persist:async record=>{this.driverLaunch=record;await writeJson(pathToFileURL(path.join(this.root,'mhub-launch.json')),record);},...this.driverStartup});
  if(supervised)return this.status('started','依赖连接已恢复，现有联动守护正在重新接入设备。',{stage:'initializing'});
  await this.status('starting','M HUB 已连接，正在启动设备通道…',{stage:'starting-controller'});
  for(const [name,identity] of [['run.pid',meta.controller],['supervisor.pid',meta.supervisor]]){
   const file=path.join(this.root,name),recorded=Number(await fs.readFile(file,'utf8').catch(()=>0));
   if(recorded&&recorded===identity.pid&&identity.matches===false)await fs.rm(file,{force:true});
  }
  signal.throwIfAborted();
  const intentFile=path.resolve(this.root,'../mhub-community-assistant/state/runtime-intent.json');
  const cancelled=async()=>{const intent=await read(intentFile);return !readDeviceLink(this.root).enabled||automatic&&!automaticStopAllowsResume(this.root)||intent?.sync===false&&intent.at>=this.startedAt;};
  if(await cancelled())throw Error('用户已停止设备联动，本次启动已取消。');
  await fs.rm(path.join(this.root,'stop.request'),{force:true});
  if(signal.aborted||await cancelled()){await fs.writeFile(path.join(this.root,'stop.request'),'stop');signal.throwIfAborted();throw Error('用户已停止设备联动，本次启动已取消。');}
  const childPid=await this.startSupervisor(path.join(this.root,'supervisor.mjs'),this.root);if(signal.aborted){await fs.writeFile(path.join(this.root,'stop.request'),'stop');signal.throwIfAborted();}
  return this.status('started','联动守护已启动，正在等待 M HUB 界面和设备初始化。',{stage:'initializing',supervisorPid:childPid});
 }
}
export async function ensureConnections({root=ROOT,fetchImpl=fetch,probe=runtimeProbe,driverStartup={}}={}){
 requireDeviceLink(root);
 const signal=AbortSignal.timeout(10000),source='http://127.0.0.1:18782';
 const [debug,sourceReady]=await Promise.all([probeMhubDebug(fetchImpl,signal),fetchOk(source+'/api/mhub-community/companion/manifest',fetchImpl,signal)]);
 if(sourceReady)await writeJson(pathToFileURL(path.join(root,'source-origin.json')),{origin:source});
 if(debug.ready&&sourceReady)return;
 if(debug.state==='occupied')throw Error(debug.error);
 const meta=await probe({signal});
 if(!debug.ready&&meta.debugListeners?.some(row=>row.ownerAlive===false))throw Error('旧 M HUB 已退出，但 49763 端口仍未释放；请完整退出驱动或保存工作后重启 Windows。');
 if(meta.hidAvailable===false)throw Error('联动进程的运行权限不足，无法加载 HID 依赖；请使用本机正常权限重新启动联动。');
 if(!sourceReady)throw Error('内部伙伴后台暂未就绪，等待本项目后台自动恢复。');
 if(!debug.ready)await prepareDriver({probeDebug:()=>probeMhubDebug(fetchImpl,signal),probeRuntime:()=>probe({signal}),launch:()=>launchMhub({root}),
  signal,wait:pause,describeUnavailable:unavailableMhubMessage,
  check:async()=>{requireDeviceLink(root);if(await fs.access(path.join(root,'stop.request')).then(()=>true,()=>false))throw Error('用户已停止设备联动。');},
  persist:record=>writeJson(pathToFileURL(path.join(root,'mhub-launch.json')),record),...driverStartup});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 if(process.argv[2]==='--mhub-only')await ensureConnections();
 else{const start=new SyncStartup();await start.request();await start.pending;const status=await read(start.file);console.log(JSON.stringify(status));if(status?.phase==='failed')process.exitCode=1;}
}
