import {runtime} from '../../runtime-paths.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const helper=fileURLToPath(new URL('stop_process_tree.py',import.meta.url));
export async function stopVoiceChild(child){
 if(!child?.pid||child.exitCode!==null)return;
 await new Promise((resolve,reject)=>{
  const stop=spawn(runtime.python,['-X','utf8',helper,String(child.pid),String(process.pid)],{windowsHide:true,stdio:'ignore'});
  const timer=setTimeout(()=>{stop.kill();reject(Error('语音工作进程清理超时，请检查本机进程。'));},8000);
  stop.once('error',error=>{clearTimeout(timer);reject(error);});
  stop.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('语音工作进程清理未完成。'));});
 });
}
