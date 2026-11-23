import fs from 'node:fs/promises';
import {writeJson} from './resilience.mjs';

const settingsFile=new URL('weather-settings.json',import.meta.url);
export async function weatherSettings(file=settingsFile){
  try{return JSON.parse(await fs.readFile(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return {enabled:false,location:null};throw error;}
}
async function request(origin,params,fetchImpl){
  const url=new URL(origin);
  url.search=new URLSearchParams(params);
  const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(6500)});
  if(!response.ok)throw Error('天气服务暂时不可用');
  return response.json();
}
function location(row){
  if(!Number.isSafeInteger(row?.id)||row.id<=0||typeof row.name!=='string'||
     !Number.isFinite(row.latitude)||Math.abs(row.latitude)>90||
     !Number.isFinite(row.longitude)||Math.abs(row.longitude)>180)return null;
  return {id:row.id,name:row.name.slice(0,60),region:[row.admin1,row.country].filter(x=>typeof x==='string'&&x!==row.name).join(' · ').slice(0,100),latitude:row.latitude,longitude:row.longitude};
}
export async function weatherAction({operation,query,id,enabled},{file=settingsFile,fetchImpl=fetch}={}){
  if(operation==='search'){
    if(typeof query!=='string'||query.trim().length<2||query.trim().length>60)throw Error('请输入 2 到 60 个字符的城市名');
    const data=await request('https://geocoding-api.open-meteo.com/v1/search',{name:query.trim(),language:'zh',count:'8'},fetchImpl);
    return {locations:(data.results??[]).map(location).filter(Boolean)};
  }
  if(operation==='bind'){
    if(!Number.isSafeInteger(id)||id<=0)throw Error('请选择搜索结果中的城市');
    const selected=location(await request('https://geocoding-api.open-meteo.com/v1/get',{id:String(id),language:'zh'},fetchImpl));
    if(!selected||selected.id!==id)throw Error('未找到该城市');
    await writeJson(file,{enabled:true,location:selected});
    return {message:'已绑定 '+selected.name+'，正在读取天气'};
  }
  if(operation==='toggle'&&typeof enabled==='boolean'){
    const settings=await weatherSettings(file);
    if(enabled&&!settings.location)throw Error('请先搜索并绑定城市');
    await writeJson(file,{...settings,enabled});
    return {message:enabled?'时间页已开启天气':'时间页已关闭天气'};
  }
  throw Error('无效的天气操作');
}
function condition(code){
  if(code===0)return '晴';
  if(code<=2)return '多云';
  if(code===3)return '阴';
  if(code<=48)return '雾';
  if(code>=95)return '雷雨';
  if(code>=71&&code<=77||code===85||code===86)return '雪';
  return '雨';
}
export class ScreenWeather {
  constructor(){this.nextRead=0;this.nextFetch=0;this.settings={};}
  async poll(now=Date.now()){
    if(now>=this.nextRead){
      this.nextRead=now+1000;
      const next=await weatherSettings().catch(()=>null);
      if(next){
        if(next.location?.id!==this.settings.location?.id||next.enabled!==this.settings.enabled){this.current=null;this.nextFetch=0;this.error=null;}
        this.settings=next;
      }
    }
    const place=this.settings.location;
    if(!this.settings.enabled||!place||this.pending||now<this.nextFetch)return;
    const selection=this.settings;
    this.nextFetch=now+600000;
    this.pending=request('https://api.open-meteo.com/v1/forecast',{
      latitude:String(place.latitude),longitude:String(place.longitude),current:'temperature_2m,weather_code',forecast_days:'1',
    },fetch).then(data=>{
      if(this.settings.location?.id!==place.id||!this.settings.enabled)return;
      const row=data.current;
      if(!Number.isFinite(row?.temperature_2m)||!Number.isInteger(row.weather_code)||row.weather_code<0||row.weather_code>99)throw Error('天气数据暂不可用');
      this.current={text:condition(row.weather_code)+' '+Math.round(row.temperature_2m)+'°C',at:Date.now()};
      this.error=null;
    }).catch(()=>{
      if(this.settings.location?.id===selection.location?.id&&this.settings.enabled){this.error='天气暂不可用';this.nextFetch=Date.now()+60000;}
    }).finally(()=>{this.pending=null;});
  }
  status(now=Date.now()){
    return {enabled:this.settings.enabled===true,locationId:this.settings.location?.id??null,location:this.settings.location?.name??null,
      text:this.current&&now-this.current.at<1800000?this.current.text:null,error:this.error??null};
  }
}
