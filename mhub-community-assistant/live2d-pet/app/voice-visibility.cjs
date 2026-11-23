// A call temporarily reveals a hidden pet, then restores the user's visibility.
class CallVisibility {
 constructor({hidden,wake,hide}){Object.assign(this,{hidden,wake,hide});this.active=false;this.changed=false;}
 manual(){if(this.active)this.changed=true;}
 sync(active){
  if(!!active===this.active)return;
  if(active){this.restoreHidden=this.hidden();this.changed=false;this.active=true;this.wake();}
  else{this.active=false;if(this.restoreHidden&&!this.changed)this.hide();}
 }
}
function speechWakesPet({preview,phoneOwner,purpose}){return !!preview||!!phoneOwner||purpose==='电话';}
module.exports={CallVisibility,speechWakesPet};
