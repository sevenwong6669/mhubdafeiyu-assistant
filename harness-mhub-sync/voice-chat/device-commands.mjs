import {captureIntent,checkIntent,cancelLocalIntent} from '../../mhub-community-assistant/device-intent.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {prepareDeviceAsset,targetInPrompt} from '../../mhub-community-assistant/device-assets.mjs';
import {latestDeviceAsset,importRgbDraft,queueRgbAsset,queueSpeakerAsset,queueDefaultTheme} from '../../mhub-community-assistant/device-asset-import.mjs';
import {internalImageConfig} from '../../mhub-community-assistant/companion/image-config.mjs';

export function parseDeviceCommand(text){
 if(typeof text!=='string'||text.length>2000)return null;
 const prompt=text.trim().replace(/^(?:(?:呃|嗯|那个|现在|然后|麻烦你|麻烦|好的|好|那)[，,、\s]*)+/, '');
 if(/怎么|如何|怎样|为什么|多少钱|举例|例如|他说|她说|你说|我觉得|我认为|我感觉|我看到|我发现/.test(prompt))return null;
 if(/(?:不要|别|不想|不需要).{0,8}(?:停止|关闭|关掉|恢复|切回|回到|还原)/.test(prompt))return null;
 if(/(?:恢复|切回|回到|还原).{0,8}(?:默认.{0,3}大肥鱼|大肥鱼.{0,5}(?:主题|动画|画面))|(?:恢复|切回|回到|还原)(?:到)?大肥鱼[。！!\s]*$/.test(prompt))return {kind:'restore-default'};
 if(/(?:停止|关掉|关闭|停掉).{0,5}(?:设备动画|键盘动画|动画|动图)|恢复.{0,5}(?:原来|原本|之前).{0,4}(?:灯光|灯效)/.test(prompt))return {kind:'stop'};
 if(/(?:动画|动图|生图|画).{0,8}(?:好了吗|好了没|进度|做到哪)|(?:查看|查询).{0,4}(?:生成进度|动画进度)/.test(prompt))return {kind:'status'};
 if(/(?:不要|别|暂时不).{0,6}(?:生成|生图|制作|播放|放|做|画)|不想|不需要|只是(?:问|讨论)|怎么|如何|怎样|为什么|多少钱|不能|不会|不支持|举例|例如|他说|她说|你说/.test(prompt))return null;
 const device=/键盘|音箱.{0,6}(?:屏幕|小屏)|小屏幕|神光同步|全设备灯效|桌上.{0,8}设备|所有设备|全部设备|设备一起|GT\s*75|Ace\s*75/i.test(prompt);
 if(device&&/(?:做|制作|生成|画|弄)/.test(prompt)&&/回原/.test(prompt))return {kind:'clarify',message:'你是想做红色火焰动画吗？请再说一遍“给我的键盘生成红色火焰动画”，我听清后再开始。'};
 if(/(?:重播|重新播放|再播放一次)|(?:刚才|上次).{0,18}(?:用到|用上|播放|应用|导入)|(?:用上|播放|应用|导入).{0,12}(?:刚才|上次)/.test(prompt))return {kind:'apply',target:device?(targetInPrompt(prompt)??(/键盘/.test(prompt)?'keyboard':null)):null};
 if(!/^(?:请|帮|给|让|把|为|我|能|可以|你能|你可以|你帮|你给|再|重新|做|生成|制作|画|(?:所有设备|全部设备|设备一起|神光同步|全设备灯效|键盘)[，,\s]*(?:一起|生成|制作|做|播放|放))/.test(prompt))return null;
 if(!device||!/(?:做|制作|生成|画(?:一|个|条|只|张|出|动画)|弄|设计|播放|放(?:个|一|彩虹|烟花|海浪))/.test(prompt)||!/(?:动图|动画|GIF|火焰|泡泡|海浪|流星|烟花|游泳|摆尾|眨眼)/i.test(prompt))return null;
 if(/键盘/.test(prompt)&&/音箱.{0,6}(?:屏幕|小屏)|小屏幕/.test(prompt))throw Error('键盘灯效和音箱小屏需要分别适配，请分两次说要制作的动画。');
 const target=targetInPrompt(prompt)??(/桌上.{0,8}设备|所有设备|全部设备|设备一起/.test(prompt)?'sync':'keyboard'),frame=prompt.match(/(\d+)\s*帧/),duration=prompt.match(/每帧\s*(\d+)\s*(毫秒|ms|秒)/i);
 return {kind:'generate',args:{prompt,target,output_format:'gif',import_to_mhub:true,activate:!/(?:只.{0,4}(?:生成|保存|草稿)|不要.{0,4}(?:点亮|播放|应用|上传))/.test(prompt),...(frame?{frame_count:Number(frame[1])}:{}),...(duration?{frame_duration_ms:Number(duration[1])*(duration[2]==='秒'?1000:1)}:{})}};
}
const phases={checking:'正在确认设备',generating:'正在生成动画',converting:'正在适配设备尺寸',importing:'正在导入M HUB',playing:'正在应用动画',complete:'已完成',error:'未完成',interrupted:'已中断'};
export class VoiceDeviceCommands{
 constructor({readConfig=internalImageConfig,prepare=prepareDeviceAsset,latest=latestDeviceAsset,importer=importRgbDraft,player=queueRgbAsset,speaker=queueSpeakerAsset,restore=queueDefaultTheme,waitForDisplay=async()=>{},file=new URL('../../mhub-community-assistant/state/voice-device-jobs.json',import.meta.url),onNotice=()=>{},onUpdate=()=>{}}={}){
  Object.assign(this,{readConfig,prepare,latest,importer,player,speaker,restore,waitForDisplay,file,onNotice,onUpdate});this.job=null;this.closed=false;this.restorePending=false;
  try{this.job=JSON.parse(fs.readFileSync(file,'utf8')).job;if(this.job&&!['complete','error','interrupted'].includes(this.job.phase)){this.job.phase='interrupted';this.job.error='语音服务重启，上次操作结果未确认，未自动重新生成。';this.job.cancelApply=true;this.persist();}}catch(error){if(error.code!=='ENOENT')this.storageError='历史进度无法读取，未自动重新执行。';}
 }
 get busy(){return !!this.job&&!['complete','error','interrupted'].includes(this.job.phase);}
 snapshot(){return {busy:this.busy,job:this.job?{id:this.job.id,kind:this.job.kind,phase:this.job.phase,label:phases[this.job.phase],createdAt:this.job.createdAt,asset_id:this.job.asset_id,target:this.job.target,error:this.job.error??null,failedPhase:this.job.failedPhase??null,activated:this.job.activated??false}:null,storageError:this.storageError??null};}
 persist(){try{const file=this.file instanceof URL?fileURLToPath(this.file):path.resolve(this.file);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify({job:this.job}));fs.renameSync(file+'.tmp',file);}catch{this.storageError='进度未能写入磁盘，不会自动重试生图。';}this.onUpdate(this.snapshot());}
 stage(phase,extra={}){Object.assign(this.job,{phase,...extra});this.persist();}
 statusText(){if(!this.job)return '还没有设备动画任务。你可以说，给我的键盘做个红色火焰动画。';return this.busy?(phases[this.job.phase]+'，不用重复生成哦。'):this.job.phase==='complete'?(this.job.activated?'动画已经做好并在播放，余额灯条保持独立。':'动画已经做好并保存了。'):('上次没有完成：'+String(this.job.error??'请重试应用已有素材').slice(0,130));}
 dispatch(intent){
  if(intent.kind==='clarify')return {handled:true,message:intent.message};
  if(intent.kind==='status')return {handled:true,message:this.statusText()};
  if(this.restorePending)return {handled:true,message:'正在恢复大肥鱼主题，请稍等，不用重复操作。'};
  if(intent.kind==='restore-default'){cancelLocalIntent();
   if(this.busy){this.job.cancelApply=true;this.persist();}
   this.restorePending=true;
   const done=(async()=>{try{await this.waitForDisplay({restoreDefault:true});if(this.closed)throw Error('语音服务已关闭，未发送恢复请求。');const result=await this.restore();if(this.job){this.job.activated=false;this.persist();}this.onNotice('大肥鱼回来啦，默认动画和原来的灯效已恢复，余额条保留。');return result;}catch(error){this.onNotice('恢复大肥鱼主题没有完成：'+error.message);return {restored:false,error:error.message};}finally{this.restorePending=false;}})();
   return {handled:true,message:'好，我来恢复默认大肥鱼主题，保留余额条和已经生成的动画。',done};
  }
  if(intent.kind==='stop'){cancelLocalIntent();
   if(this.busy){this.job.cancelApply=true;this.persist();}
   const done=this.player(null,{stop:true}).then(()=>{if(this.job){this.job.activated=false;this.persist();}this.onNotice('设备动画停下啦，原来的灯效和余额条已经恢复。');return {stopped:true};}).catch(error=>{this.onNotice('停止动画没有完成：'+error.message);return {error:error.message};});
   return {handled:true,message:this.busy?'我会停止播放，新生成的素材只保存，不再自动点亮。':'好，我来停止动画，恢复原来的灯光。',done};
  }
  if(this.busy)return {handled:true,message:'上一份动画还在处理，'+phases[this.job.phase]+'，不用重复下单。'};
  if(intent.kind==='generate'&&this.job?.prompt===intent.args.prompt&&Date.now()-this.job.createdAt<60000&&this.job.phase==='complete')return {handled:true,message:this.statusText()};
  this.job={id:randomUUID(),kind:intent.kind,prompt:intent.args?.prompt,phase:'checking',createdAt:Date.now(),target:intent.args?.target};this.persist();
  const label=intent.kind==='generate'?((intent.args.prompt.match(/红色|紫色|蓝色|绿色|黄色|彩色/)?.[0]??'')+(intent.args.prompt.match(/火焰|泡泡|海浪|流星|烟花|小鱼|鲸鱼|雷达/)?.[0]??'')+'动画'):'';
  const done=this.run(intent);return {handled:true,message:intent.kind==='generate'?(intent.args.activate===false?'好，我来制作'+label+'，只保存，不点亮。':'好，我来做'+label+'，做好就直接用上，余额灯条保持原样。'):'好，我来应用已经保存的动画，不会重新生图。',done};
 }
 async run(intent){
  const claim=captureIntent();
  try{
   const config=this.readConfig(),cfg=config?.then?await config:config;let p;
   if(this.closed||this.job.cancelApply){this.stage('complete',{activated:false});return this.snapshot();}checkIntent(claim);
   if(intent.kind==='generate'){
    if(cfg.modules?.imagegen?.enabled===false||cfg.safeMode)throw Error('请先开启AuraBot生图扩展。');
    if(cfg.local?.image)throw Error('当前是本地生图接管，请先在AuraBot选择官方API通道。');
    const generated=await this.prepare(intent.args,{config:cfg.imageGen,scope:'voice:local',onStage:phase=>this.stage(phase)});p=generated.prepared;this.stage('converting',{asset_id:p.id,target:p.manifest.target});
   }else{
    const candidates=[];
    for(const scope of ['voice:local','harness:local','private:'+cfg.ownerQQ]){try{candidates.push(this.latest(scope,{target:intent.target}));}catch{}}
    candidates.sort((a,b)=>(b.request?.createdAt??b.at??0)-(a.request?.createdAt??a.at??0));p=candidates[0];
    if(!p)throw Error('没有找到对应设备的已有动画，请先制作一份。');
    if(intent.target&&intent.target!=='keyboard'&&p.manifest.target!==intent.target||intent.target==='keyboard'&&!['gt75','ace75'].includes(p.manifest.target))throw Error('最近的素材不是这个设备使用的，请先制作对应动画。');
    this.job.asset_id=p.id;
   }
   if(!this.closed&&!this.job.cancelApply&&(intent.kind==='apply'||intent.args.activate!==false)){
    if(p.manifest.target==='speaker')await this.waitForDisplay();
    if(this.closed||this.job.cancelApply){this.stage('complete',{activated:false});return this.snapshot();}
    if(p.manifest.target==='speaker'){this.stage('playing');checkIntent(claim);await this.speaker(p,{applyToken:claim.token});}
    else{this.stage('importing');await this.importer(p);if(this.closed||this.job.cancelApply){this.stage('complete',{activated:false});return this.snapshot();}checkIntent(claim);this.stage('playing');await this.player(p,{applyToken:claim.token});}
    this.stage('complete',{activated:true});this.onNotice('动画做好并用上啦，余额灯条保持原样。');
   }else{this.stage('complete',{activated:false});if(!this.closed)this.onNotice('动画做好并保存啦，没有切换当前灯光。');}
   return this.snapshot();
  }catch(error){this.stage('error',{failedPhase:this.job.phase,error:String(error.message).slice(0,300)});if(!this.closed)this.onNotice('这次动画没有完成：'+String(error.message).slice(0,110)+'。我不会偷偷改成呼吸灯，也不会自动重复生图。');return this.snapshot();}
 }
 close(){this.closed=true;if(this.busy){this.job.cancelApply=true;this.persist();}}
}
