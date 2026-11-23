import fs from 'node:fs';
const directory='panel/themes/smartisan/assets/';
export function smartisanAssets(){
 const manifest=JSON.parse(fs.readFileSync(new URL(directory+'icons.json',import.meta.url),'utf8'));
 const names=new Set(['icons.json']);
 for(const icon of Object.values(manifest.icons))for(const state of ['normal','selected','pressed']){
  const name=icon[state];if(typeof name!=='string'||!/^[-a-z0-9]+\.(png|svg)$/.test(name))throw Error('Invalid bundled Smartisan icon');names.add(name);
 }
 return [...names].map(name=>['/themes/smartisan/assets/'+name,[directory+name,name.endsWith('.png')?'image/png':name.endsWith('.svg')?'image/svg+xml':'application/json; charset=utf-8']]);
}
