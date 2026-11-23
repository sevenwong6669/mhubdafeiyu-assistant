import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export const name='fish-voice';
export const inject=['agents'];
export function apply(ctx){
  const session=()=>JSON.parse(readFileSync(join(homedir(),'.dsh/fish-buddy-config.json'),'utf8')).会话;
  const clients=new Set();let active=null;
  const publish=value=>{for(const res of clients)res.write('data: '+JSON.stringify(value)+'\n\n');};
  ctx.on('agent/assistant-stream',({agent,frame})=>{
    if(agent?.session?.id!==session()||!active)return;
    publish({kind:'frame',request:active,frame});
  });
  ctx.on('session/event',(s,e)=>{
    if(s.id!==session()||!active)return;
    if(e.type==='turn/end'){publish({kind:'end',request:active,reason:e.data.reason});active=null;}
  });
  const server=createServer(async(req,res)=>{
    if(req.headers.origin){res.writeHead(403).end();return;}
    if(req.url==='/events'&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.write(': ready\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;
    }
    try{
      if(req.url==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,session:session(),active}));return;}
      if(req.method!=='POST')throw Error('POST required');
      let body='';for await(const b of req){body+=b;if(body.length>16000)throw Error('Input too large');}
      const data=JSON.parse(body||'{}');let agent=ctx.agents.get(session());
      if(req.url==='/cancel'){const owned=active;active=null;if(owned&&agent){agent.cancel({kind:'user'});await agent.whenIdle();}}
      else if(req.url==='/talk'){
        if(!agent){
          const presets=ctx.get('agentPresets'),selection=ctx.get('agentDefaultModel')?.currentSelection?.();
          if(!presets?.mount)throw Error('Harness 会话预设服务未就绪');
          const handle=await ctx.agents.resume({resumeSessionId:session(),agentOptions:{provider:selection?.provider,model:selection?.model},setup:async agentCtx=>{await presets.mount(agentCtx,presets.defaultId||'standard');}});agent=handle?.agent??handle;
        }
        if(typeof data.text!=='string'||!data.text.trim()||data.text.length>2000)throw Error('Invalid text');
        if(agent.status==='running')throw Error('该会话仍在处理上一轮，请稍后再试');
        active=data.request;
        await agent.followup({id:randomUUID(),role:'user',content:[{type:'text',text:data.text}],source:{kind:'user'}});
      }else throw Error('Unknown route');
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true}));
    }catch(e){res.writeHead(409,{'Content-Type':'application/json'}).end(JSON.stringify({error:e.message}));}
  });
  server.on('error',e=>console.error('[fish-voice]',e.message));
  const heartbeat=setInterval(()=>{for(const res of clients)res.write(': ping\n\n');},10000);
  ctx.effect(()=>{server.listen(18779,'127.0.0.1');return ()=>{clearInterval(heartbeat);for(const res of clients)res.end();server.close();};});
}
