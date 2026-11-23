// Shared device names come from this project's voice settings, never another plugin.
;(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.petAudioDevices=api;})(typeof window==='undefined'?globalThis:window,function(){
  function failure(stage,message){const error=new Error(message);error.stage=stage;return error;}
  const defaultName=name=>!name||['__default__','default','系统默认','默认'].includes(String(name).trim().toLowerCase());
  const normalize=value=>String(value||'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
  function selectDevice(name,kind,devices){
    if(defaultName(name))return '';
    const wanted=normalize(name),available=devices.filter(row=>row.kind===kind&&!['default','communications'].includes(row.deviceId)&&row.deviceId&&row.label);
    if(kind==='audioinput'&&devices.some(row=>row.kind===kind)&&!devices.some(row=>row.kind===kind&&row.label))throw failure('input-permission','当前桌宠尚未获得麦克风设备标签，无法核对已选择的麦克风。请检查麦克风权限后重试；未切换到系统默认设备。');
    let matches=available.filter(row=>normalize(row.label)===wanted);
    if(!matches.length)matches=available.filter(row=>normalize(row.label).includes(wanted));
    if(matches.length===1)return matches[0].deviceId;
    const label=kind==='audioinput'?'麦克风':'播放设备',stage=kind==='audioinput'?'input-selection':'output-selection';
    throw failure(stage,matches.length>1?'找到多个同名'+label+'，请在音频设置中重新选择：'+name:'未找到已选择的'+label+'：'+name+'。请连接设备或重新选择，未切换到系统默认设备。');
  }
  function dependencies(options){return {media:options?.mediaDevices||globalThis.navigator?.mediaDevices,bridge:options?.bridge||globalThis.petBridge};}
  function inputDiagnostic(options,name,devices,error){
    const {bridge}=dependencies(options),inputs=devices.filter(row=>row.kind==='audioinput');
    bridge?.log?.('音频输入选择诊断',JSON.stringify({stage:error.stage||'input-selection',requestedName:String(name||'').slice(0,160),inputCount:inputs.length,labelCount:inputs.filter(row=>!!row.label).length,devices:inputs.map(row=>({label:String(row.label||'').slice(0,160),hasDeviceId:!!row.deviceId,defaultAlias:['default','communications'].includes(row.deviceId)}))}));
  }
  async function inputByName(config,name,options){
    const {media}=dependencies(options);if(!media?.enumerateDevices)throw failure('input-selection','当前桌面运行环境无法列举麦克风。');
    let devices=[];
    try{devices=await media.enumerateDevices();const byId=config.mic&&devices.find(row=>row.kind==='audioinput'&&row.deviceId===name);return {exact:byId?byId.deviceId:selectDevice(name,'audioinput',devices)};}
    catch(error){inputDiagnostic(options,config.mic?'[explicit microphone selection]':name,devices,error);throw error;}
  }
  async function readConfig(options){const {bridge}=dependencies(options);if(!bridge?.audioConfig)throw failure('audio-config','共享音频设备通道尚未就绪，请重启桌宠。');const value=await bridge.audioConfig();if(value?.error)throw failure(value.stage||'audio-config',value.error);return value||{};}
  async function inputConstraint(config={},options){
    if(typeof config.mic==='string'&&config.mic.trim()){
      const selected=config.mic.trim();if(defaultName(selected))return null;
      return inputByName(config,selected,options);
    }
    const shared=await readConfig(options),name=shared.inputName;
    if(defaultName(name))return null;
    return inputByName(config,name,options);
  }
  async function routeOutput(context,options){
    const shared=await readConfig(options),name=shared.outputName;
    if(defaultName(name)) {if(typeof context.setSinkId==='function'&&context.sinkId)await context.setSinkId('');return {name:'__default__',deviceId:''};}
    if(typeof context.setSinkId!=='function')throw failure('output-selection','当前桌面运行环境不支持指定播放设备，请更新桌宠运行环境或选择系统默认播放。');
    const {media}=dependencies(options);if(!media?.enumerateDevices)throw failure('output-selection','当前桌面运行环境无法列举播放设备。');
    const id=selectDevice(name,'audiooutput',await media.enumerateDevices());
    try{if(context.sinkId!==id)await context.setSinkId(id);}catch(error){throw failure('output-selection','无法使用已选择的播放设备：'+name+'（'+error.message+'）');}
    return {name,deviceId:id};
  }
  return {selectDevice,inputConstraint,routeOutput};
});
