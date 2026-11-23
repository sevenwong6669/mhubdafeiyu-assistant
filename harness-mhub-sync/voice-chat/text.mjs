const words=new Intl.Segmenter('zh',{granularity:'word'});
const graphemes=new Intl.Segmenter('zh',{granularity:'grapheme'});
const units=text=>[...text].reduce((sum,c)=>sum+(c.codePointAt(0)>127?2:1),0);
const motion=/^(?:(?:轻轻|微微|缓缓|慢慢|温柔|开心|害羞|用力|认真)(?:地)?|微|小|大|狠|快|慢|轻|缓慢)*(?:点头|摇头|微笑|轻笑|笑|眨眼|脸红|害羞|歪头听|歪头|挥挥手|挥手|抬手|举手|低头|抬头|叹气|摊手|耸肩|伸懒腰|摇摆|鞠躬|比心|鼓掌|闭眼|睁眼|清嗓子|咳嗽)(?:一下|两下|几下)?(?:[×xX*][1-5])?(?:[:：](?:左|右))?$/u;
const isDirection=text=>text.trim().replace(/[。.!！]+$/u,'').split(/[,，、+＋]/u).every(part=>{
 const value=part.replace(/\s+/g,'');return motion.test(value)||/^(?:nods?|nodding|smiles?|laughs?|waves?|sighs?)(?:softly|gently|slowly)?$/i.test(value);
});
export function speechDirections(text){
 return String(text??'')
  .replace(/<body:[^>\r\n]{0,160}>/gi,'').replace(/〔[^〕\r\n]{0,60}〕/g,'')
  .replace(/\[([^\[\]\r\n]{1,60})\]|［([^［］\r\n]{1,60})］|【([^【】\r\n]{1,60})】|（([^（）\r\n]{1,60})）|\(([^()\r\n]{1,60})\)/g,(whole,...groups)=>isDirection(groups.slice(0,5).find(v=>v!==undefined))?'':whole)
  .replace(/\*{1,2}([^*\r\n]{1,60})\*{1,2}/g,(whole,inner)=>isDirection(inner)?'':whole)
  .replace(/[\[［【（(]([^\[\]［］【】（）()\r\n]{1,60})$/u,(whole,inner)=>isDirection(inner)?'':whole);
}
export function speechText(text){
  text=String(text??'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1');
  return speechDirections(text).replace(/https?:\/\/\S+/g,'').replace(/[*_#>|~]/g,'').replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu,'').trim();
}
// Live2D returns a complete reply. Keep short replies in one synthesis request
// so a display newline does not reset the voice and introduce another lead-in.
export function spokenReply(text){
 const lines=speechText(text).split(/\r?\n+/).map(s=>s.trim()).filter(Boolean);
 let result='';
 for(const line of lines){if(result)result+=(/[。，！？!?；;：:]$/.test(result)?'':'。');result+=line;}
 result=result.replace(/([吧呀呢哦啦嘛啊])[ \t]+(?=[\p{Script=Han}])/gu,'$1，');
 if(result&&/[\p{L}\p{N}]$/u.test(result))result+='。';
 return result;
}
export function spokenUtterances(text){
 const normalized=spokenReply(text);if(!normalized)return [];
 if([...normalized].length<=96)return [normalized];
 const parts=new Sentences({minimum:24}).push(normalized,true),out=[];
 for(const part of parts){if(out.length&&[...out.at(-1)+part].length<=96)out[out.length-1]+=part;else out.push(part);}
 return out;
}
// Speech boundaries must never depend on the screen's 48-byte page capacity.
export class Sentences{
  constructor({minimum=0}={}){this.buffer='';this.fence=false;this.ticks='';this.minimum=minimum;}
  push(delta,final=false){
    for(const c of delta){
      if(c==='`'){this.ticks+=c;if(this.ticks.length===3){this.fence=!this.fence;this.ticks='';}continue;}
      this.ticks='';if(!this.fence)this.buffer+=c;
    }
    const result=[];
    const emit=text=>{text=speechText(text);if(/[\p{L}\p{N}]/u.test(text))result.push(text);};
    for(;;){
      let cut=0,brackets=[];const safe=[];
      for(let i=0;i<this.buffer.length;i++){
        const c=this.buffer[i];
        const open='[［【（(〔'.indexOf(c),close=']］】）)〕'.indexOf(c);
        if(brackets.length&&i-brackets[0].at>80)brackets=[];
        if(open>=0)brackets.push({kind:open,at:i});
        else if(close>=0&&brackets.at(-1)?.kind===close)brackets.pop();
        safe[i+1]=!brackets.length;
        if(brackets.length)continue;
        const terminal=/[。！？!?；;\n]/u.test(c)||(c==='.'&&/\s/.test(this.buffer[i+1]||'')&&!/\d/.test(this.buffer[i-1]||''));
        const comma=c==='，'||(c===','&&!/\d/.test(this.buffer[i-1]||'')&&!/\d/.test(this.buffer[i+1]||''));
        if((terminal&&[...speechText(this.buffer.slice(0,i+1))].length>=this.minimum)||(comma&&[...speechText(this.buffer.slice(0,i+1))].length>=24)){cut=i+1;break;}
      }
      if((!cut||[...this.buffer.slice(0,cut)].length>96)&&[...this.buffer].length>96){
        for(const part of words.segment(this.buffer)){const end=part.index+part.segment.length;if([...this.buffer.slice(0,end)].length>72)break;if(safe[end])cut=end;}
      }
      if(!cut)break;
      emit(this.buffer.slice(0,cut));this.buffer=this.buffer.slice(cut);
    }
    if(final){emit(this.buffer);this.buffer='';}
    return result;
  }
}
export function pages(text,{maxUnits=28,semantic=false}={}){
  text=speechText(text);if(!text)return [];
  const tokens=[];
  for(const {segment} of words.segment(text)){
    if(Buffer.byteLength(segment)<=48&&units(segment)<=maxUnits){tokens.push(segment);continue;}
    let part='';for(const {segment:c} of graphemes.segment(segment)){if(Buffer.byteLength(part+c)>48||units(part+c)>maxUnits){tokens.push(part);part='';}part+=c;}if(part)tokens.push(part);
  }
  const n=tokens.length,sums=[0],widths=[0];for(const token of tokens){sums.push(sums.at(-1)+Buffer.byteLength(token));widths.push(widths.at(-1)+units(token));}
  if(semantic){
    const boundary=Array(n+1).fill(0);
    let mark='';
    for(let i=0;i<n;i++){
      const token=tokens[i].trim();
      if(token&&!/^[”’」』）)】\]]+$/u.test(token))mark=token.at(-1);
      boundary[i+1]=/[。！？!?；;\n]/u.test(mark)||tokens[i].includes('\n')?0:/[，,、：:]/u.test(mark)?16:110;
    }
    const best=Array(n+1).fill(Infinity),next=Array(n).fill(0);best[n]=0;
    for(let start=n-1;start>=0;start--)for(let end=start+1;end<=n;end++){
      const size=widths[end]-widths[start];
      if(sums[end]-sums[start]>48||size>maxUnits)break;
      const line=tokens.slice(start,end).join('').trim();
      if(!/[\p{L}\p{N}]/u.test(line))continue;
      const misplaced=/^[。，！？!?；;,、：:）)」』”]/u.test(tokens[end]?.trimStart()||'');
      const cost=best[end]+28+(end===n?0:boundary[end])+(misplaced?300:0)+Math.max(0,8-size)**2;
      if(cost<=best[start]){best[start]=cost;next[start]=end;}
    }
    if(Number.isFinite(best[0])){
      const result=[];
      for(let start=0;start<n;start=next[start])result.push(tokens.slice(start,next[start]).join('').trim());
      return result;
    }
  }
  // Find the fewest pages, then balance them to avoid a one-word trailing page.
  for(let count=Math.max(1,Math.ceil(sums[n]/48),Math.ceil(widths[n]/maxUnits));count<=n;count++){
    const target=widths[n]/count,dp=Array.from({length:count+1},()=>Array(n+1).fill(Infinity)),prev=Array.from({length:count+1},()=>Array(n+1).fill(-1));dp[0][0]=0;
    for(let k=1;k<=count;k++)for(let end=k;end<=n;end++)for(let start=end-1;start>=k-1;start--){
      const bytes=sums[end]-sums[start],size=widths[end]-widths[start];if(bytes>48||size>maxUnits)break;if(!Number.isFinite(dp[k-1][start]))continue;
      const next=tokens[end]||'',penalty=/^[。，！？!?；;,、：:）)」』”]/u.test(next)?500:0;
      const cost=dp[k-1][start]+(size-target)**2+penalty;
      if(cost<dp[k][end]){dp[k][end]=cost;prev[k][end]=start;}
    }
    if(Number.isFinite(dp[count][n])){
      const out=[];let end=n;for(let k=count;k>0;k--){const start=prev[k][end];out.unshift(tokens.slice(start,end).join('').trim());end=start;}
      return out.filter(x=>/[\p{L}\p{N}]/u.test(x));
    }
  }
  return [];
}
