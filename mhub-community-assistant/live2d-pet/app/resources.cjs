// Runtime assets stay outside the distributable desktop shell.
const fs = require('node:fs');
const path = require('node:path');
const sourceRoot = path.resolve(__dirname, '..');
const stateRoot = path.resolve(process.env.LIVE2D_STATE_DIR || path.join(sourceRoot, '..', 'state', 'live2d'));
const assetsRoot = path.resolve(process.env.LIVE2D_PET_ASSETS || path.join(stateRoot, 'pet'));
const settingsFile = path.resolve(process.env.LIVE2D_PET_SETTINGS || path.join(stateRoot, 'pet.json'));
const hostFile = path.resolve(process.env.DAFEIYU_LIVE2D_HOST || process.env.AURABOT_PET_HOST || path.join(stateRoot, 'host.json'));
const voiceConfigFile = path.resolve(process.env.LIVE2D_VOICE_CONFIG || path.join(sourceRoot, '..', '..', 'harness-mhub-sync', 'voice-chat', 'config.json'));
function readAudioConfig(file = voiceConfigFile) {
  try {
    const config=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
    return {inputName:typeof config.inputName==='string'?config.inputName:'',outputName:typeof config.outputName==='string'?config.outputName:''};
  }catch(error){return {inputName:'',outputName:'',...(error.code==='ENOENT'?{}:{error:'共享音频设备设置无法读取，请检查麦克风与播放设置。',stage:'audio-config'})};}
}
function readDesktop(file = settingsFile) {
  try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); return data.desktop || {}; }
  catch { return {}; }
}
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function realFile(root, relative) {
  if (!root || /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(relative)) return null;
  const target = path.resolve(root, relative);
  if (!isInside(path.resolve(root), target)) return null;
  try {
    const actualRoot = fs.realpathSync(root), actual = fs.realpathSync(target);
    return isInside(actualRoot, actual) && fs.statSync(actual).isFile() ? actual : null;
  } catch { return null; }
}
function findModel(root, depth = 0) {
  if (depth > 5) return null;
  let entries; try { entries = fs.readdirSync(root, {withFileTypes:true}); } catch { return null; }
  entries.sort((a,b) => a.name.localeCompare(b.name));
  for (const entry of entries) if (entry.isFile() && /\.pet\.model3\.json$/i.test(entry.name)) return path.join(root, entry.name);
  for (const entry of entries) if (entry.isFile() && /\.model3\.json$/i.test(entry.name)) return path.join(root, entry.name);
  for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) { const model = findModel(path.join(root,entry.name),depth+1); if(model)return model; }
  return null;
}
function selectedModel(desktop, assets) {
  if (desktop.modelFile) return path.resolve(String(desktop.modelFile)); // Do not silently change an unavailable selected model's identity.
  return findModel(path.join(assets,'model'));
}
function descriptor(file) {
  const data = JSON.parse(fs.readFileSync(file,'utf8'));
  const root = path.dirname(file), refs = data.FileReferences || (data.FileReferences={});
  const list = (dir,re) => {try{return fs.readdirSync(path.join(root,dir)).filter(n=>re.test(n)).sort();}catch{return [];}};
  const expressions=list('Exp3',/\.exp3\.json$/i), motions=list('Animation',/\.motion3\.json$/i);
  if(!refs.Expressions?.length && expressions.length) refs.Expressions=expressions.map(n=>({Name:n.replace(/\.exp3\.json$/i,''),File:'Exp3/'+n}));
  if(!refs.Motions && motions.length) refs.Motions={Motion:motions.map(n=>({File:'Animation/'+n,Sound:null,FadeInTime:0.5,FadeOutTime:0.5}))};
  // The full renderer owns blink and speech mouth animation.
  data.Groups=(data.Groups||[]).filter(group=>!['EyeBlink','LipSync'].includes(group.Name));
  return Buffer.from(JSON.stringify(data));
}
function modelReferences(file) {
  const allowed=new Set();
  const walk=value=>{
    if(typeof value==='string' && /\.(?:json|png|jpg|jpeg|webp|moc3|wav|mp3)$/i.test(value)) {
      if(!value.includes('\\') && !value.includes(':') && !value.startsWith('/') && !value.split('/').some(p=>p==='..'||p==='.'))allowed.add(value);
    } else if(Array.isArray(value))value.forEach(walk);
    else if(value && typeof value==='object')Object.values(value).forEach(walk);
  };
  try{walk(JSON.parse(descriptor(file)).FileReferences);}catch{}
  return allowed;
}
function createResourceResolver({source = sourceRoot, assets = assetsRoot, settings = settingsFile} = {}) {
  return function resolveResource(url) {
    let name; try { name=decodeURIComponent(new URL(url,'http://localhost').pathname); } catch { return null; }
    if (name.includes('\\') || name.includes('\0') || name.split('/').some(part=>part==='.'||part==='..')) return null;
    let file=null;
    const desktop=readDesktop(settings);
    if(name.startsWith('/runtime-model/')) {
      const model=selectedModel(desktop,assets); if(!model)return null;
      const relative=name.slice('/runtime-model/'.length);
      if(relative==='selected.model3.json') {
        try {if(!fs.statSync(model).isFile())return null;return {file:model,body:descriptor(model),type:'application/json'};}catch{return null;}
      }
      if(!modelReferences(model).has(relative))return null;
      file=realFile(path.dirname(model),relative);
    } else if (name==='/app/renderer/live2dcubismcore.min.js') {
      const core=desktop.coreFile?path.resolve(String(desktop.coreFile)):path.join(assets,'sdk','live2dcubismcore.min.js');
      try{if(fs.statSync(core).isFile())file=core;}catch{}
    } else if (/^\/node_modules\/(pixi\.js\/dist\/pixi\.min\.js|pixi-live2d-display\/dist\/cubism4\.min\.js)$/.test(name)) {
      file=realFile(source,name.slice(1));
    } else if (['/clips.json','/faces.json','/参数词典.json'].includes(name)) {
      file=realFile(assets,name.slice(1)) || realFile(source,name.slice(1));
    } else if (/^\/beat(?:-[a-z0-9-]{1,80})?\.json$/i.test(name)) {
      file=realFile(assets,name.slice(1));
    } else if (/^\/app\/renderer\/(?:wake-(?:ack-[123]|chime)|test-tone)\.wav$/.test(name)) {
      file=realFile(assets,'audio/'+path.basename(name));
    } else if (/^\/app\/renderer\/[\w\-/.]+\.(?:html|js|css|png|svg)$/.test(name)) {
      file=realFile(source,name.slice(1));
    }
    return file?{file}:null;
  };
}
module.exports={sourceRoot,stateRoot,assetsRoot,settingsFile,hostFile,voiceConfigFile,readAudioConfig,readDesktop,isInside,createResourceResolver,selectedModel,descriptor};
