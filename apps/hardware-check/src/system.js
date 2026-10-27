
'use strict';
function createSystemTest(changed){
  if(!window.VrchSystemInfo){return{isOpen:()=>false,enter:()=>{document.getElementById('status').textContent='Update device software to view System Info.';},handle(){},monitor:()=>({}),close(){}};}
  const view=VrchSystemInfo.createDialog({read:()=>{
    if(VrchApp.context.mode!=='device')throw Object.assign(new Error('Run on device'),{code:'preview_io_disabled'});
    if(!VrchApp.system?.read)throw Object.assign(new Error('Update device software'),{code:'unsupported_capability'});
    return VrchApp.system.read();
  },onChange:changed});
  window.systemCheck=view.state;
  return{isOpen:view.isOpen,enter:view.show,close:view.close,
    handle(event){if(event.type==='down'&&event.control==='K2')void view.refresh();if(event.type==='rotate'&&event.control==='E2')view.changeTab(Number(event.delta)||0);if(event.type==='rotate'&&event.control==='E1')view.scroll((Number(event.delta)||0)*60);},
    monitor(){return Object.fromEntries(['E1','E2','E3','E4','K2','K3','K4'].map(id=>[id,{label:id==='E1'?'SCROLL':id==='E2'?'TAB':id==='K2'?'REFRESH':'',value:id==='E2'?view.state.tab:id==='K2'&&view.state.phase==='loading'?'READING':'',pressed:false}]));}};
}
