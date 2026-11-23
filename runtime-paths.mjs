import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function resolveRuntime({settings={},env=process.env,baseUrl=new URL('./',import.meta.url),exists=fs.existsSync}={}){
  if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('运行环境配置格式无效，请重新运行安装器。');
  const configured=(environment,key)=>{
    const value=env[environment]??settings[key];
    if(value!==undefined&&value!==null&&(typeof value!=='string'||!value.trim()))throw Error('运行环境路径格式无效：'+key);
    return value||null;
  };
  const bundledPython=fileURLToPath(new URL('.venv/Scripts/python.exe',baseUrl));
  const python=configured('DAFEIYU_CONTROL_PYTHON','python')||bundledPython;
  const driver=configured('DAFEIYU_MHUB_EXECUTABLE','mhub');
  const candidates=[...new Set([env.ProgramW6432,env.ProgramFiles,env['ProgramFiles(x86)']].filter(Boolean).map(dir=>path.join(dir,'M HUB','MCHOSE HUB.exe')))];
  return {
    python,
    asrPython:configured('DAFEIYU_ASR_PYTHON','asrPython')||python,
    ttsPython:configured('DAFEIYU_TTS_PYTHON','ttsPython')||python,
    mhub:driver||candidates.find(file=>exists(file))||'MCHOSE HUB.exe',
  };
}

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(new URL('runtime.settings.json', import.meta.url), 'utf8').replace(/^\uFEFF/,''));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
export const runtime = resolveRuntime({settings});
