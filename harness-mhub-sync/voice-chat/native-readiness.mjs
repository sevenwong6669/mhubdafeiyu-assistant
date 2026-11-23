export function nativeReadiness(status,mouseError=null){
 const capture=!!(status?.ready&&status.captureReady),keyboard=capture&&status.keyboardReady===true;
 const error=mouseError?String(mouseError.message??mouseError).split(/\r?\n/)[0]:null;
 return {nativeReady:capture&&(keyboard||!error),nativeKeyboardReady:keyboard,voiceHotkey:status?.voiceHotkey??null,
  mouseBindingReady:capture&&!error,mouseBindingError:error,nativeError:keyboard?null:error,
  audioSession:status?.audioSession??mouseError?.audioSession??null};
}
