import {PET_STYLES} from './pet-model.mjs';
import {PLAY_STYLES} from './playtime.mjs';
export const STYLES={...PET_STYLES,...PLAY_STYLES,
  IDLE:{label:'待命中',color:'#00AAFF'},BUSY:{label:'正在处理',color:'#FFD166'},
  THINKING:{label:'思考中',color:'#00E5FF'},WORKING:{label:'工作中',color:'#FFD000'},
  SUCCESS:{label:'完成啦',color:'#30EE88'},WAITING:{label:'等你确认',color:'#FF9F32'},
  ERROR:{label:'遇到问题',color:'#FF354F'},DISCONNECTED:{label:'连接中',color:'#8D83BA'},ATTENTION:{label:'需要你',color:'#FF8800'},
};
export class DisplayRecovery {
  constructor(clock=Date.now){this.clock=clock;this.error=null;this.retryAt=0;}
  async run(operation,onError=()=>{}){
    if(this.clock()<this.retryAt)return false;
    try{const result=await operation();this.error=null;this.retryAt=0;return result;}
    catch(error){this.error={message:error.message,at:this.clock()};this.retryAt=this.clock()+750;await onError(error);return false;}
  }
}
export class Presenter {
  constructor(output){this.output=output;this.installed=false;this.state=null;this.mode=null;}
  async install(){if(!this.installed){await this.output.install();this.installed=true;}}
  async render(state,mode,{label,style:override,suppressScreen=false,lightsHandled=false}={}){
    if(!STYLES[state]||!['animation','text'].includes(mode))throw Error('Invalid display state');
    label=label??override?.label??STYLES[state].label;
    if(typeof label!=='string'||Buffer.byteLength(label,'utf8')>48)throw Error('Invalid display label');
    const style={...STYLES[state],...override,label},styleKey=JSON.stringify(style),lightKey=JSON.stringify({color:style.color,effect:style.effect,brightness:style.brightness,speed:style.speed,colorMode:style.colorMode});
    if(state===this.state&&mode===this.mode&&styleKey===this.styleKey&&suppressScreen===this.suppressScreen)return false;
    if(!lightsHandled&&(state!==this.state||lightKey!==this.lightKey)&&await this.output.lights(style,state)===false)return false;
    if(!suppressScreen){
      if(mode==='animation'){
        if(this.mode!=='animation')await this.output.animation(style);
        else await this.output.tint(style);
      }else await this.output.text(style);
    }
    this.state=state;this.mode=mode;this.label=label;this.styleKey=styleKey;this.lightKey=lightKey;this.suppressScreen=suppressScreen;return true;
  }
}
