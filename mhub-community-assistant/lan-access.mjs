import fs from 'node:fs';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {isIPv4} from 'node:net';
import {networkInterfaces} from 'node:os';

const COOKIE='dafeiyu_lan_session',LIFETIME=7*24*60*60;
const hash=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const ipv4=value=>value.split('.').reduce((a,n)=>(a*256+Number(n))>>>0,0);
const privateAddress=value=>isIPv4(value)&&(/^10\./.test(value)||/^192\.168\./.test(value)||/^172\.(1[6-9]|2\d|3[01])\./.test(value));
// DHCP may change the host address. Only follow an unambiguous address on
// the already authorized subnet; never widen access to another network.
export function resolveLanBinding(config,interfaces=networkInterfaces()){
 const mask=(0xffffffff<<(32-config.prefixLength))>>>0,network=(ipv4(config.address)&mask)>>>0;
 const candidates=[...new Set(Object.values(interfaces).flat().filter(row=>row&&!row.internal&&(row.family==='IPv4'||row.family===4)&&privateAddress(row.address)&&((ipv4(row.address)&mask)>>>0)===network&&row.cidr?.endsWith('/'+config.prefixLength)).map(row=>row.address))];
 if(candidates.includes(config.address))return {...config};
 if(candidates.length!==1)throw Error(candidates.length?'局域网地址不明确，请在主电脑重新选择网卡。':'原局域网尚未连接，已保留本机入口。');
 return {...config,address:candidates[0]};
}
export function readLanConfig(file){
 let value;try{value=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch(e){if(e.code==='ENOENT')return null;throw Error('局域网配置无法读取，已保留本机入口。');}
 if(value.enabled!==true)return null;
 if(!privateAddress(value.address)||!Number.isInteger(value.prefixLength)||value.prefixLength<8||value.prefixLength>30||value.requireAuth!==undefined&&typeof value.requireAuth!=='boolean'||!/^[a-f0-9]{64}$/.test(value.keyHash??'')||!/^[a-f0-9]{64}$/.test(value.sessionSecret??''))throw Error('局域网配置无效，已保留本机入口。');
 // Keep legacy settings readable and reuse the saved access key.
 return {...value,requireAuth:true};
}
const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const json=(error,status)=>Response.json({error},{status,headers});
function login(error='',status=200){
 return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>大肥鱼 · 局域网登录</title><style>body{margin:0;background:#f5f6f3;color:#25332f;font:15px/1.7 "Segoe UI","Microsoft YaHei",sans-serif;min-height:100vh;display:grid;place-items:center}.box{box-sizing:border-box;width:min(420px,calc(100% - 36px));padding:32px;background:white;border:1px solid #e0e5de;border-radius:16px}h1{font-size:25px;margin:0 0 8px}p{color:#69766e;margin:0 0 24px}label{display:block}input,button{box-sizing:border-box;width:100%;font:inherit;border-radius:8px;padding:11px 12px}input{border:1px solid #cad5ca;margin:8px 0 16px}button{border:0;background:#28786a;color:white;cursor:pointer}.error{color:#a83d35;margin:12px 0}.hint{font-size:12px;margin-top:18px;margin-bottom:0}</style><main class="box"><h1>大肥鱼后台</h1><p>输入访问口令，连接这台电脑的陪伴控制台。</p><form method="post" action="/lan/login"><label for="access-key">局域网访问口令</label><input id="access-key" name="key" type="password" autocomplete="current-password" required maxlength="128"><button type="submit">进入后台</button></form>${error?`<p class="error" role="alert">${error}</p>`:''}<p class="hint">口令保存在主电脑的「局域网访问说明」中。验证会在这台设备上保留七天。</p></main></html>`,{status,headers:{...headers,'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"}});
}
export function createLanAccess(config,{port=18782,clock=Date.now}={}){
 const mask=(0xffffffff<<(32-config.prefixLength))>>>0,network=(ipv4(config.address)&mask)>>>0,origin=`http://${config.address}:${port}`,attempts=new Map();
 const sign=value=>createHmac('sha256',Buffer.from(config.sessionSecret,'hex')).update(value).digest('hex');
 const keyMatches=value=>typeof value==='string'&&value.length<=128&&equal(hash(value),config.keyHash);
 const sessionMatches=value=>{if(!value)return false;const [expiry,nonce,sig,...extra]=value.split('.');return !extra.length&&/^\d{13}$/.test(expiry)&&/^[a-f0-9]{32}$/.test(nonce??'')&&Number(expiry)>clock()&&Number(expiry)<=clock()+LIFETIME*1000&&equal(sign(expiry+'.'+nonce),sig);};
 return async function authorize(request,peer){
  peer=peer?.replace(/^::ffff:/,'');const url=new URL(request.url);
  if(!isIPv4(peer??'')||((ipv4(peer)&mask)>>>0)!==network||url.origin!==origin)return json('仅允许当前局域网访问。',403);
  const loginPage=request.method==='GET'&&['/','/lan/login','/api/mhub-community/panel'].includes(url.pathname);
  if(request.headers.has('origin')&&request.headers.get('origin')!==origin||['cross-site','same-site'].includes(request.headers.get('sec-fetch-site'))){
   if(loginPage&&request.headers.get('sec-fetch-mode')==='navigate'&&request.headers.get('sec-fetch-dest')==='document')return login();
   return json('请从大肥鱼后台页面发起操作。',403);
  }
  const bearer=request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
  const cookie=request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  const authenticated=keyMatches(bearer)||sessionMatches(cookie);
  if(url.pathname==='/lan/login'&&request.method==='POST'){
   const now=clock(),last=attempts.get(peer);if(last&&last.until>now&&last.count>=5)return login('尝试次数较多，请一分钟后重试。',429);
   if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get('content-type')??''))return json('请求格式不正确。',415);
   if(!keyMatches(new URLSearchParams(await request.text()).get('key'))){attempts.set(peer,{count:last&&last.until>now?last.count+1:1,until:last&&last.until>now?last.until:now+60000});return login('访问口令不正确，请检查后重试。',401);}
   attempts.delete(peer);const value=`${clock()+LIFETIME*1000}.${randomBytes(16).toString('hex')}`;
   return new Response(null,{status:303,headers:{...headers,location:'/api/mhub-community/panel','set-cookie':`${COOKIE}=${value}.${sign(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${LIFETIME}`}});
  }
  if(authenticated)return null;
  if(loginPage)return login();
  return json('请先登录局域网后台，或提供 Authorization: Bearer 访问口令。',401);
 };
}
export function localizeLanRequest(request,port=18782){
 const incoming=new URL(request.url),h=new Headers(request.headers);h.set('host',`127.0.0.1:${port}`);
 if(h.has('origin'))h.set('origin',`http://127.0.0.1:${port}`);
 h.delete('authorization');h.delete('cookie');
 return new Request(`http://127.0.0.1:${port}${incoming.pathname}${incoming.search}`,{method:request.method,headers:h,signal:request.signal,...(!['GET','HEAD'].includes(request.method)?{body:request.body,duplex:'half'}:{})});
}
