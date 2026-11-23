export const SOURCE_STALE_MS=45000;
export const SOURCE_QUIET_MS=30000;

// The companion sends a current snapshot on subscribe, but no idle heartbeat.
// Renew a quiet subscription before the last known state becomes stale.
export async function subscribeHarnessEvents(origin,{signal,onActivity,onMessage,fetchImpl=fetch,timers=globalThis}){
  const subscription=new AbortController(),quiet=Error('Quiet Harness event stream');
  let deadline;
  const expire=(ms,reason)=>{
    timers.clearTimeout(deadline);
    deadline=timers.setTimeout(()=>subscription.abort(reason),ms);
  };
  try{
    expire(8000,Error('Harness event stream connection timed out'));
    const response=await fetchImpl(origin+'/api/mhub-community/companion/events',{signal:AbortSignal.any([signal,subscription.signal])});
    if(!response.ok||!response.headers.get('Content-Type')?.startsWith('text/event-stream'))throw Error('Harness event stream unavailable');
    expire(SOURCE_QUIET_MS,quiet);
    let buffer='';const decoder=new TextDecoder();
    for await(const chunk of response.body){
      expire(SOURCE_QUIET_MS,quiet);
      onActivity();
      buffer+=decoder.decode(chunk,{stream:true});let index;
      while((index=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,index).trimEnd();buffer=buffer.slice(index+1);
        if(!line.startsWith('data: '))continue;
        try{const value=JSON.parse(line.slice(6));onMessage(value.payload?{...value,...value.payload}:value);}catch{}
      }
    }
    return 'closed';
  }catch(error){
    if(subscription.signal.reason===quiet&&!signal.aborted)return 'quiet';
    throw error;
  }finally{
    timers.clearTimeout(deadline);
    subscription.abort();
  }
}
