'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('factory',{
  platform:process.platform,
  request:(action,payload={})=>ipcRenderer.invoke('factory:request',action,payload),
  onState:callback=>{const listener=(_event,state)=>callback(state);ipcRenderer.on('factory:state',listener);return ()=>ipcRenderer.removeListener('factory:state',listener);}
});
