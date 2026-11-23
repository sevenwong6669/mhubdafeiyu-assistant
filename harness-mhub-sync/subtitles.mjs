import fs from 'node:fs/promises';
export const DEFAULT_SUBTITLES={captionMode:'auto',captionFontSize:0};
export function captionUnits(text){return [...String(text)].reduce((sum,c)=>sum+(c.codePointAt(0)>127?2:1),0);}
export function captionOptions(config={}){
 const captionMode=config.captionMode??'auto',captionFontSize=config.captionFontSize??0;
 if(!['auto','scroll','pages'].includes(captionMode)||![0,1].includes(captionFontSize))throw Error('字幕显示设置无效。');
 return {captionMode,captionFontSize};
}
export function captionPageOptions(config={}){return {maxUnits:captionOptions(config).captionFontSize===1?16:28};}
export class LiveSubtitles{
 constructor(){this.options={...DEFAULT_SUBTITLES};this.version=null;this.last=0;this.nativeUnsupported=false;}
 async poll(){
  if(Date.now()-this.last<500)return;this.last=Date.now();
  try{const cfg=JSON.parse(await fs.readFile(new URL('voice-chat/config.json',import.meta.url),'utf8'));this.options=captionOptions(cfg);this.version=cfg.captionControlVersion??null;}catch{}
 }
 style(text){const {captionMode,captionFontSize}=this.options;return {fontSize:captionFontSize,scroll:!this.nativeUnsupported&&(captionMode==='scroll'||captionMode==='auto'&&captionUnits(text)>(captionFontSize===1?14:22))};}
}
