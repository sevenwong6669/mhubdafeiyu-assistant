// One budget for normal stop, stalled-controller recovery and version handoff.
// The external recovery worker allows identity checks and process-exit overhead.
export const CONTROLLER_RELEASE_MS=150000;
export const RELEASE_OBSERVE_MS=180000;
export const releaseExpired=(startedAt,now)=>Number.isFinite(startedAt)&&now-startedAt>=CONTROLLER_RELEASE_MS;
export async function waitForRelease(isAlive,{startedAt=Date.now(),budgetMs=CONTROLLER_RELEASE_MS,clock=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 while(await isAlive()){
  const remaining=budgetMs-(clock()-startedAt);
  if(remaining<=0)return false;
  await wait(Math.min(250,remaining));
 }
 return true;
}
