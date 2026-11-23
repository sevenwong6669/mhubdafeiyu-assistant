import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {crc32} from 'node:zlib';
import {readDeviceAsset} from '../mhub-community-assistant/device-asset-import.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
export async function speakerAssetClip(assetId,{base,residentDir=path.join(root,'assets/residents')}={}){
 const p=readDeviceAsset(assetId,{base}),screen=p.manifest.screen;
 if(p.manifest.target!=='speaker'||screen?.frames!==12||screen.file!=='screen.bin')throw Error('音箱素材的点阵记录无效。');
 const binary=await fs.readFile(path.join(p.dir,'prepared/screen.bin'));
 if(binary.length!==12288||crc32(binary)!==screen.crc32)throw Error('音箱点阵完整性校验失败，未上传。');
 const id='qq_'+p.sha256.slice(0,32).split('').map(x=>String.fromCharCode(97+parseInt(x,16))).join('');
 const clip={id,label:'QQ自定义动画',width:256,height:32,frames:12,delay:screen.delay,crc32:screen.crc32};
 await fs.mkdir(residentDir,{recursive:true});
 await fs.writeFile(path.join(residentDir,id+'.bin'),binary);
 return clip;
}
export async function savedSpeakerClip(){
 try{const data=JSON.parse(await fs.readFile(path.join(root,'screen-user-asset.json'),'utf8'));return await speakerAssetClip(data.assetId);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
