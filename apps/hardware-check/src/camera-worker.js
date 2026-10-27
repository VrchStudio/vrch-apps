'use strict';
let detector=null,settings=null,sequence=0,lastTimestamp=-1;
const nativeFetch=self.fetch.bind(self);
self.onmessage=async({data})=>{
  if(data.type==='init'){
    try{
      const root=data.root,config=data.config;settings=config.models[data.kind];
      self.fetch=(resource,options)=>{
        const url=new URL(typeof resource==='string'?resource:resource.url,self.location.href).href;
        if(!url.startsWith(root))return Promise.reject(new Error('Tracking resources must remain in the App.'));
        return nativeFetch(resource,{...options,credentials:'omit'});
      };
      importScripts(root+config.runtime.bundle);
      const Class=self.Vision?.[settings.factory];if(!Class)throw new Error('Tracking runtime unavailable');
      const canvas=new OffscreenCanvas(1,1);if(!canvas.getContext('webgl2'))throw new Error('Tracking image processing unavailable');
      const [fileset,response]=await Promise.all([self.Vision.FilesetResolver.forVisionTasks(root+config.runtime.wasm),fetch(root+settings.asset)]);
      if(!response.ok)throw new Error('Tracking model unavailable');
      const options={...settings.options};if(data.kind==='hand')options.numHands=data.numHands===1?1:2;
      const modelAssetBuffer=new Uint8Array(await response.arrayBuffer());
      const delegate=config.runtime.delegate;
      detector=await Class.createFromOptions(fileset,{...options,canvas,runningMode:'VIDEO',baseOptions:{modelAssetBuffer,delegate}});
      const connections=settings.connections.flatMap(name=>Class[name]||[]).map(v=>[v.start,v.end]);
      self.postMessage({type:'ready',connections,visibility:settings.visibility,delegate});
    }catch(error){self.postMessage({type:'error',stage:'load',message:error.message});}
    return;
  }
  if(data.type==='frame'){
    const frame=data.frame;
    try{
      if(!detector)throw new Error('Tracking is not ready');
      const timestamp=Math.max(lastTimestamp+.001,data.timestamp);lastTimestamp=timestamp;
      const start=performance.now(),result=detector.detectForVideo(frame,timestamp);
      const landmarks=(result[settings.landmarks]||[]).map(points=>points.map(p=>({x:p.x,y:p.y,z:p.z,visibility:p.visibility??1})));
      self.postMessage({type:'result',sequence:++sequence,landmarks,duration:performance.now()-start});
    }catch(error){self.postMessage({type:'error',stage:'inference',message:error.message});}
    finally{frame.close();}
  }
};
