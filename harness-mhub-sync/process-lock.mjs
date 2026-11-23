import {spawn} from 'node:child_process';
export async function acquireSupervisorLock({name='DafeiyuMhubSupervisor'}={}){
 if(!/^[A-Za-z0-9_-]{1,80}$/.test(name))throw Error('Invalid mutex name');
 const script="$m=[Threading.Mutex]::new($false,'Local\\"+name+"'); $held=$false; try { try {$held=$m.WaitOne(0)} catch [Threading.AbandonedMutexException] {$held=$true}; if(!$held){Write-Output 'BUSY';exit}; Write-Output 'READY'; [Console]::In.ReadLine() | Out-Null } finally {if($held){$m.ReleaseMutex()};$m.Dispose()}";
 const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const ready=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>{child.kill();reject(Error('守护互斥锁获取超时'));},10000);const done=v=>{clearTimeout(timer);resolve(v);};child.once('error',e=>{clearTimeout(timer);reject(e);});child.stdout.on('data',v=>{text+=v;if(text.includes('READY'))done(true);else if(text.includes('BUSY'))done(false);});child.once('exit',()=>done(false));});
 if(!ready){child.stdin.end();return null;}
 let released=false;
 const release=()=>{if(released)return;released=true;process.off('exit',release);child.stdin.end();};process.once('exit',release);return {release,child};
}
