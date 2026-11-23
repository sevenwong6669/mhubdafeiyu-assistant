import {fileURLToPath} from 'node:url';
import {CompanionConfig} from './config.mjs';
export async function internalImageConfig(){const store=new CompanionConfig(fileURLToPath(new URL('../state/companion/',import.meta.url))),cfg=store.read();return {imageGen:{...cfg.image,provider:'openai',apiKey:await store.key('image')}};}
