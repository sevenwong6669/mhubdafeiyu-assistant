import {writeModeOverride} from './mode-override.mjs';
const mode=process.argv[2];
if(!['animation','text'].includes(mode))throw Error('Choose animation or text');
await writeModeOverride(new URL('./',import.meta.url),mode);
console.log(mode==='animation'?'已请求动画模式。':'已请求文字模式。');
