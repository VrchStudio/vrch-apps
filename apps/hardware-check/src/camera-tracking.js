'use strict';
// Model selection, CPU delegate and 192px input follow Visuals frame analysis.
// App SDK frames and opaque-origin package access require this local adapter.
function createCameraTracking(onChange){
  const root=new URL('assets/tracking/',document.baseURI).href;
  const state=window.trackingCheck={mode:'off',state:'off',handCount:1,backend:null,landmarks:[],connections:[],tracks:0,fps:null,inferences:0,workersCreated:0,workersTerminated:0,error:null};
  let worker=null,generation=0,active=false,busy=false,measuredAt=0,measuredFrames=0,config=null;
  const configPromise=fetch(root+'models.json').then(r=>{if(!r.ok)throw new Error('Tracking settings unavailable');return r.json();}).then(value=>config=value);
  function changed(){onChange(state);}
  function release(){
    ++generation;worker?.terminate();if(worker)state.workersTerminated++;worker=null;busy=false;
    state.landmarks=[];state.connections=[];state.tracks=0;state.fps=null;state.backend=null;
  }
  function failed(error){
    state.error=error?.message||String(error);release();state.state='error';changed();
  }
  async function start(){
    release();if(!active||state.mode==='off'){state.state='off';changed();return;}
    const request=generation,mode=state.mode;state.state='loading';state.error=null;changed();
    try{
      await configPromise;
      const response=await fetch(new URL('camera-worker.js',document.baseURI));if(!response.ok)throw new Error('Tracking processor unavailable');
      const code=await response.text();if(request!==generation||!active)return;
      const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
      try{worker=new Worker(url);}finally{URL.revokeObjectURL(url);}
      const opened=worker;state.workersCreated++;
      worker.onerror=()=>{if(worker===opened&&request===generation)failed(new Error('Tracking processor stopped'));};
      worker.onmessage=({data})=>{
        if(worker!==opened||request!==generation||!active)return;
        if(data.type==='ready'){state.backend=data.delegate;state.connections=data.connections;state.visibility=data.visibility;state.nodes=[...new Set(data.connections.flat())];state.state='ready';measuredAt=performance.now();measuredFrames=0;changed();}
        if(data.type==='result'){
          busy=false;state.landmarks=data.landmarks;state.tracks=data.landmarks.length;state.inferences++;state.duration=data.duration;
          const now=performance.now();state.resultAt=now;measuredFrames++;
          if(now-measuredAt>=1000){state.fps=Math.round(measuredFrames*1000/(now-measuredAt));measuredAt=now;measuredFrames=0;}
          changed();
        }
        if(data.type==='error')failed(new Error(data.message));
      };
      worker.postMessage({type:'init',root,kind:mode,numHands:state.handCount,config});
    }catch(error){if(request===generation&&active)failed(error);}
  }
  function process(source){
    const now=performance.now();if(!active||state.state!=='ready'||busy)return;
    busy=true;const request=generation,opened=worker;
    const size=config.models[state.mode].inputSize,scale=Math.min(1,size/Math.max(source.width,source.height));
    createImageBitmap(source,{resizeWidth:Math.max(1,Math.round(source.width*scale)),resizeHeight:Math.max(1,Math.round(source.height*scale))}).then(frame=>{
      if(request!==generation||worker!==opened||!active){frame.close();return;}
      try{opened.postMessage({type:'frame',frame,timestamp:now},[frame]);}catch(error){frame.close();failed(error);}
    }).catch(error=>{if(request===generation&&active)failed(error);});
  }
  function draw(ctx,width,height){
    if(state.state!=='ready'||performance.now()-state.resultAt>Math.max(600,state.duration*2.25))return;
    state.landmarks.forEach((points,index)=>{
      const visible=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.visibility>=state.visibility;
      ctx.strokeStyle=index?'#88b6ef':'#7bd4ad';ctx.fillStyle='#f0eee8';ctx.lineWidth=Math.max(1.5,width/320);
      ctx.beginPath();for(const [a,b] of state.connections){const p=points[a],q=points[b];if(visible(p)&&visible(q)){ctx.moveTo(p.x*width-width/2,p.y*height-height/2);ctx.lineTo(q.x*width-width/2,q.y*height-height/2);}}ctx.stroke();
      const radius=Math.max(1.5,width/320);ctx.beginPath();for(const i of state.nodes){const p=points[i];if(!visible(p))continue;const x=p.x*width-width/2,y=p.y*height-height/2;ctx.moveTo(x+radius,y);ctx.arc(x,y,radius,0,Math.PI*2);}ctx.fill();
    });
  }
  return {state,process,draw,
    setHandCount(count){if(![1,2].includes(count)||state.handCount===count)return;state.handCount=count;if(active&&state.mode==='hand')void start();else changed();},
    select(mode){state.mode=mode;if(active)void start();else{release();state.state='off';changed();}},
    resume(){active=true;void start();},
    stop(){active=false;release();state.state='off';changed();},
    retry(){if(active&&state.mode!=='off')void start();},
    text(){const label=config?.models[state.mode]?.label||state.mode;
      return state.mode==='off'?'':state.state==='loading'?'Loading '+label+'…':state.state==='error'?label+' tracking unavailable · press E1':state.state==='ready'?state.tracks?label+' · '+state.tracks+' tracked'+(state.fps===null?'':' · '+state.fps+' fps'):'No '+label.toLowerCase()+' detected':'';}
  };
}
