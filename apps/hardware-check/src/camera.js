'use strict';
function createCameraTest(onChange) {
  const get=id=>document.getElementById(id),message=get('cameraMessage'),canvas=get('cameraImage');
  const drawing=canvas.getContext('2d',{alpha:false}),held=new Set();
  const source=document.createElement('canvas'),raw=source.getContext('2d',{alpha:false}),modes=['off','face','body','hand'];
  let rotation=0,mirror=false,display='overlay',edited=false,save=Promise.resolve();
  let current=null,epoch=0,frames=0,measuredAt=0,starting=false,paintRequest=0;
  const preview=VrchApp.context.mode!=='device';
  const state=window.cameraCheck={state:'off',frames:0,width:0,height:0,fps:0,rotation:0,mirror:false};
  const tracker=createCameraTracking(()=>{trackingStatus();if(current)requestPaint();changed();});
  const changed=()=>{state.rotation=rotation;state.mirror=mirror;state.trackingMode=tracker.state.mode;state.display=display;state.handCount=tracker.state.handCount;onChange();};
  const restore=VrchApp.ready().then(()=>VrchApp.data.get('camera-view')).then(saved=>{
    if(!edited){if([0,90,180,270].includes(saved.value?.rotation))rotation=saved.value.rotation;mirror=saved.value?.mirror===true;
      if([1,2].includes(saved.value?.handCount))tracker.setHandCount(saved.value.handCount);if(saved.value?.cameraDisplay==='skeleton')display='skeleton';if(modes.includes(saved.value?.trackingMode))tracker.select(saved.value.trackingMode);changed();}
  }).catch(()=>{get('status').textContent='Camera settings could not be loaded.';});
  function remember(){
    edited=true;changed();const next={rotation,mirror,trackingMode:tracker.state.mode,cameraDisplay:display,handCount:tracker.state.handCount};
    save=save.then(()=>restore).then(async()=>{const previous=await VrchApp.data.get('camera-view');await VrchApp.data.set('camera-view',{...(previous.value||{}),...next},{expectedVersion:previous.version});}).catch(()=>{get('status').textContent='Camera settings could not be saved.';});
  }
  function show(text,error=false){message.textContent=text;message.hidden=!text;message.classList.toggle('is-error',error);}
  function trackingStatus(){
    const element=get('cameraTracking'),text=tracker.text()||(current&&display==='skeleton'&&tracker.state.mode==='off'?'Choose a tracker with E1':'');
    element.textContent=text;element.hidden=!text;
  }
  function requestPaint(){if(!paintRequest)paintRequest=requestAnimationFrame(()=>{paintRequest=0;paint();});}
  function paint(){
    const width=source.width,height=source.height;if(!width||!height||!current)return;
    const turned=rotation===90||rotation===270,viewWidth=turned?height:width,viewHeight=turned?width:height;
    if(canvas.width!==viewWidth||canvas.height!==viewHeight){canvas.width=viewWidth;canvas.height=viewHeight;}
    drawing.fillStyle='#080808';drawing.fillRect(0,0,canvas.width,canvas.height);
    drawing.save();drawing.translate(viewWidth/2,viewHeight/2);drawing.rotate(rotation*Math.PI/180);if(mirror)drawing.scale(-1,1);
    if(display==='overlay')drawing.drawImage(source,-width/2,-height/2,width,height);
    tracker.draw(drawing,width,height);drawing.restore();
  }
  function clear(){if(paintRequest)cancelAnimationFrame(paintRequest);paintRequest=0;canvas.hidden=true;drawing.clearRect(0,0,canvas.width,canvas.height);source.width=source.height=0;get('cameraTracking').hidden=true;get('cameraSize').textContent='— × —';get('cameraRate').textContent='— fps';}
  function errorText(error){
    if(error.code==='permission_required')return 'Allow camera access for My Apps, then press K2.';
    if(error.code==='camera_disconnected')return 'Camera disconnected. Reconnect it and press K2.';
    if(error.code==='preview_io_disabled')return 'Launch on the device to test its camera.';
    if(error.code==='instance_not_active')return 'Camera stopped. Press K2 to continue.';
    return 'Camera unavailable. Check the connection and press K2.';
  }
  async function failed(error,request){
    let missing=false;
    if(error.code!=='permission_required'){
      try{missing=(await VrchApp.camera.devices()).devices.length===0;}catch(_){}
    }
    if(request!==epoch)return;
    starting=false;current=null;tracker.stop();state.state=missing?'missing':'error';clear();
    show(missing?'Connect a camera, then press K2.':errorText(error),!missing);changed();
  }
  async function stop(){
    ++epoch;starting=false;const opened=current;current=null;tracker.stop();state.state='off';clear();changed();
    show(preview?'Launch on the device to test its camera.':'Press K2 to start the camera.');
    if(opened)await opened.close().catch(()=>{});
  }
  async function start(){
    if(preview){show('Launch on the device to test its camera.');return;}
    const request=++epoch;starting=true;state.state='starting';clear();show('Opening camera…');changed();
    try{
      if(!VrchApp.camera)throw new Error('Camera support is unavailable.');
      const opened=await VrchApp.camera.open({width:640,height:480,frameRate:30});
      if(request!==epoch){await opened.close();return;}
      current=opened;starting=false;state.state='live';state.frames=0;frames=0;measuredAt=performance.now();
      tracker.resume();
      get('cameraName').textContent=opened.label||'Camera';get('cameraName').title=opened.label||'Camera';
      state.width=opened.width;state.height=opened.height;show('Waiting for camera…');changed();
      opened.onFrame(frame=>{
        if(current!==opened)return;
        const width=frame.width,height=frame.height;
        if(source.width!==width||source.height!==height){source.width=width;source.height=height;}
        raw.drawImage(frame,0,0,width,height);
        state.width=width;state.height=height;
        tracker.process(source);requestPaint();trackingStatus();
        canvas.hidden=false;show('');state.frames++;frames++;get('cameraSize').textContent=width+' × '+height;
        const now=performance.now();
        if(now-measuredAt>=1000){state.fps=Math.round(frames*1000/(now-measuredAt));get('cameraRate').textContent=state.fps+' fps';frames=0;measuredAt=now;}
      });
      opened.onError(error=>{if(current===opened)void failed(error,request);});
    }catch(error){
      if(request!==epoch)return;
      const opened=current;current=null;if(opened)await opened.close().catch(()=>{});
      await failed(error,request);
    }
  }
  if(preview)show('Launch on the device to test its camera.');
  return {
    enter(){if(!current&&!starting)void start();},
    stop,
    leave(){held.clear();return stop();},
    handle(event){
      if(!['E1','E2','E3','K2','K3','K4'].includes(event.control))return false;
      if(event.control==='E3'&&tracker.state.mode!=='hand'&&!['up','cancel'].includes(event.type))return true;
      if(event.type==='rotate'){
        const delta=Number(event.delta)||0;if(!delta)return true;
        if(event.control==='E1'){const next=modes[((modes.indexOf(tracker.state.mode)+delta)%modes.length+modes.length)%modes.length];if(next!==tracker.state.mode){tracker.select(next);remember();}}
        if(event.control==='E3'&&tracker.state.mode==='hand'){const next=delta>0?2:1;if(next!==tracker.state.handCount){tracker.setHandCount(next);remember();}}
        if(event.control==='E2'){const next=delta>0?'overlay':'skeleton';if(next!==display){display=next;remember();}}
        requestPaint();trackingStatus();return true;
      }
      if(event.type==='up'||event.type==='cancel'){held.delete(event.control);changed();return true;}
      if(event.type!=='down'||held.has(event.control))return true;
      held.add(event.control);
      if(event.control==='E1'){if(tracker.state.mode==='off'){tracker.select('face');remember();}else tracker.retry();}
      if(event.control==='E3'&&tracker.state.mode==='hand'){tracker.setHandCount(tracker.state.handCount===1?2:1);remember();}
      if(event.control==='E2'){display=display==='overlay'?'skeleton':'overlay';remember();}
      if(event.control==='K2')void (current||starting?stop():start());
      if(event.control==='K3'){rotation=(rotation+90)%360;remember();}
      if(event.control==='K4'){mirror=!mirror;remember();}
      requestPaint();trackingStatus();changed();return true;
    },
    monitor(){
      return {E1:{label:'Track',value:tracker.state.mode==='off'?'Off':tracker.state.mode[0].toUpperCase()+tracker.state.mode.slice(1),pressed:held.has('E1')},E2:{label:'View',value:display==='overlay'?'Overlay':'Skeleton',pressed:held.has('E2')},E3:{label:tracker.state.mode==='hand'?'Hands':'',value:tracker.state.mode==='hand'?String(tracker.state.handCount):'',pressed:tracker.state.mode==='hand'&&held.has('E3')},E4:{label:'',value:'',pressed:false},
        K2:{label:current||starting?'Stop':state.state==='error'?'Retry':'Start',value:preview?'Device':starting?'Opening':current?'Live':state.state==='missing'?'No cam':state.state==='error'?'Error':'Off',pressed:held.has('K2')},
        K3:{label:'Rotate',value:rotation+'°',pressed:held.has('K3')},K4:{label:'Mirror',value:mirror?'On':'Off',pressed:held.has('K4')}};
    }
  };
}
