// This confirms the driver's current frame publication and, for supported
// keyboards, progress from the owned native writer. It is not a visual or
// peripheral USB acknowledgement and must never be described as one.
export function keyboardWriterOwned(status,launcherPid){
 // Windows venv python.exe may launch the actual interpreter as a child. Both
 // IDs originate from this worker's stdout, which the bridge binds to its child
 // generation; unrelated or absent process IDs cannot acknowledge a frame.
 return Number.isSafeInteger(launcherPid)&&launcherPid>0&&Number.isSafeInteger(status?.pid)&&status.pid>0&&
  (status.pid===launcherPid||status.launcherPid===launcherPid);
}
export async function confirmPreviewOutput({ids,keyboardIds,since,baseline=new Map(),poll,nativeStatus,writerStatus,current=()=>true,heartbeat=async()=>{},clock=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms)),timeout=8000,durationMs=8000}){
 if(!Array.isArray(ids)||!ids.length)throw Error('试用没有可输出的设备。');
 const until=clock()+timeout;let firstFrameAt=null;
 while(clock()<until){
  if(!current())throw Error('试用已取消，未继续确认灯光输出。');
  await heartbeat();await poll();
  if(clock()>=until)break;
  const native=nativeStatus();
  if(native?.error)throw Error('驱动灯光输出失败：'+native.error);
  const frameCurrent=native?.running===true&&native.lastFrameAt>=since&&ids.every(id=>native.devices?.includes(id));
  if(frameCurrent){
   firstFrameAt??=native.lastFrameAt;
   const writersReady=keyboardIds.every(id=>{
    const worker=writerStatus(id),status=worker?.status,previous=baseline.get(id);
    return !!worker&&status?.state==='running'&&status.deviceId===id&&keyboardWriterOwned(status,worker.pid)&&status.at>=firstFrameAt&&status.at>=since&&Number.isFinite(status.frames)&&status.frames>(previous?.pid===worker.pid?previous.frames:0);
   });
   if(writersReady&&current()){const confirmedAt=clock();return {confirmation:'driver-frame-and-writer-progress',framePublishedAt:firstFrameAt,confirmedAt,until:confirmedAt+durationMs,devices:[...ids],keyboardWritersConfirmed:[...keyboardIds],peripheralFramePublished:ids.filter(id=>!keyboardIds.includes(id)),physicalConfirmed:false};}
  }
  await wait(150);
 }
 throw Error('驱动首帧或键盘写入进度未确认，试用已停止，请检查设备连接。');
}
