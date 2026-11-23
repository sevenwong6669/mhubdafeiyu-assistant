const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('pet',{request:(action,value)=>ipcRenderer.invoke('pet-api',action,value),on:(name,listener)=>{if(!['state','command','backend-error'].includes(name))return;ipcRenderer.on(name,(_event,value)=>listener(value));}});
