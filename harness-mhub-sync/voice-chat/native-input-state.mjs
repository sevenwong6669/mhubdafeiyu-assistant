// A live hook process is not proof that its independent microphone thread is
// usable. Only accept status from the current child and its launch generation.
export function nativeInputState({child,status,parent,useIme=false}){
 const alive=!!child&&child.exitCode===null&&child.signalCode===null;
 // Windows venv python.exe can be a redirector which remains as the parent of
 // the actual interpreter. The launch token and server owner still bind that
 // interpreter to this launch; IME is a direct executable and stays exact-PID.
 const processMatches=useIme?status?.pid===child?.pid:status?.pid===child?.pid||status?.launcherPid===child?.pid;
 const matches=alive&&status?.parent===parent&&processMatches&&(useIme||status.launchToken===child.dafeiyuLaunchToken);
 return {alive,matches,captureReady:!!(matches&&status.ready&&status.captureReady),error:matches?status.error??null:null};
}
export const inputRetryAt=(failures,now)=>now+Math.min(60000,2000*2**Math.min(Math.max(1,failures),5));
export function nativeRecoveryPlan({captureReady,inputOnly,phoneActive,turnActive,now,retryAt}){
 if(captureReady&&inputOnly)return 'healthy';
 if(inputOnly&&(phoneActive||turnActive))return 'wait-idle';
 if(now<retryAt)return 'backoff';
 return inputOnly?'input-only':'engines';
}
