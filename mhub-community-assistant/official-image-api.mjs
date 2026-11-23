// Official API transport; third-party providers keep their existing transport.
export function isOfficialImageApi(config) {
  return config?.provider === 'openai' && /^https:\/\/api\.openai\.com\/v1\/?$/.test(config.baseUrl ?? '');
}
export async function officialImageRequest({config, prompt, options={}, fetchImpl=fetch}) {
  if (!isOfficialImageApi(config)) throw Error('官方生图通道地址无效。');
  if (!config.apiKey) throw Error('请先配置 OpenAI API Key。');
  if (!['gpt-image-2.6-flare','gpt-image-2.6-sunburst'].includes(config.model)) throw Error('请选择 GPT Image 2.6 模型。');
  const format=options.output_format ?? 'png';
  if (!['png','gif'].includes(format)) throw Error('只支持 PNG 或 GIF。');
  const body={model:config.model,prompt:[config.stylePrompt,prompt].filter(Boolean).join('，'),n:1,size:options.size ?? config.size ?? 'auto',output_format:format};
  if(options.quality!==undefined){
    if(!['auto','low','medium','high'].includes(options.quality))throw Error('图片质量参数无效。');
    body.quality=options.quality;
  }
  if(format==='gif') {body.frame_count=options.frame_count;body.frame_duration_ms=options.frame_duration_ms;}
  let response;
  try{response=await fetchImpl('https://api.openai.com/v1/images/generations',{
    method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${config.apiKey}`},
    body:JSON.stringify(body),signal:AbortSignal.timeout(format==='gif'?300000:180000),redirect:'error',
  });}catch(error){
    const cause=String(error.cause?.code??error.name??'network_error').replace(/[^A-Z0-9_]/gi,'').slice(0,60);
    const timeout=/timeout/i.test(cause);
    throw Object.assign(Error(timeout?'连接或等待生图服务超时，请检查网络与代理；结果未确认，没有自动重新生成。':'无法连接生图服务，请检查网络与代理（'+cause+'）；没有自动重试。'),{code:'image_network_error',transportCause:cause});
  }
  const data=await response.json().catch(()=>({}));
  if(!response.ok) {
    const raw=String(data?.error?.message ?? `HTTP ${response.status}`);
    const safe=raw.split(config.apiKey).join('[redacted]').replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]').slice(0,400);
    const gifDisabled=/GIF output is not enabled/i.test(raw);
    throw Object.assign(Error(gifDisabled?'当前 API 项目未开放原生 GIF，本次未生成动画，也没有改用静态图。':`OpenAI 生图失败（HTTP ${response.status}）：${safe}`),{code:gifDisabled?'gif_not_enabled':data?.error?.code??'openai_image_failed',status:response.status});
  }
  const encoded=data?.data?.[0]?.b64_json;
  if(typeof encoded!=='string'||!encoded)throw Error('官方 API 没有返回图片数据。');
  const buf=Buffer.from(encoded,'base64');
  if(!buf.length||buf.length>80*1024*1024)throw Error('图片数据为空或超过 80 MB。');
  if(format==='png'&&!buf.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))throw Error('官方 API 未返回有效的 PNG 图片。');
  return buf;
}
