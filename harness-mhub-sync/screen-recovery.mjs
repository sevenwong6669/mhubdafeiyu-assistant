// Restart recovery must also recognize the single-frame clock installed by
// the shortcut pages. Keep the original-image backup as the restore baseline.
export function isSpeakerScreenError(error){
 const reason=String(error?.message??error);
 return /K20 GT|音箱|屏幕|Screen text|\[audio\.mc\.(?:\w*Screen\w*|\w*CustomTextTheme|\w*CustomImage\w*|\w*ImageStatus|\w*ThemeSwitches)\]/i.test(reason);
}
export function isSpeakerControlError(error){
 return isSpeakerScreenError(error)||/\[audio\.mc\.(?:readSpeakerState|setSpeaker\w*)\]/i.test(String(error?.message??error));
}
export function ownedScreenContent(current,residentClip){
 const image=current?.image;
 if(!image?.hasImage)return false;
 const residentName=Number.isInteger(residentClip?.crc32)?'DFY:'+residentClip.crc32.toString(16):null;
 if(residentClip?.frames===12&&current.imageName===residentName&&image.imageCount===12&&image.imageBytes===12288&&image.delay===residentClip.delay/10)return true;
 return /^DFY:clock:[a-f0-9]{1,8}$/.test(current.imageName??'')&&image.imageCount===1&&image.imageBytes===1024&&image.delay===100;
}
export function recoverableScreen(previous,current,residentClip={frames:12,delay:840}){
 if(ownedScreenContent(current,residentClip))return current.image.imageCount===1?'clock':'resident';
 const backup=previous?.screenBackup;
 if(!previous?.optimized||!previous.changedImage||!previous.snapshot||
    !backup?.image?.hasImage||backup.image.imageCount!==30||
    backup.image.imageBytes!==30720||backup.imageName)return null;
 const image=current?.image;
 if(!image?.hasImage||current.imageName)return null;
 if(residentClip?.frames===12&&image.imageCount===12&&image.imageBytes===12288&&
    image.delay===residentClip.delay/10)return 'resident';
 if(previous.owned&&previous.mode==='pages'&&image.imageCount===1&&
    image.imageBytes===1024&&image.delay===100&&current.screen?.theme===8&&
    current.screen?.themeStates?.[8]?.index===1)return 'clock';
 return null;
}
