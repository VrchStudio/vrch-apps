'use strict';
window.createMagicSound=function(onState){
 let epoch=0,current=null,state='off',parameters={};
 function notify(value,error=''){state=value;onState(value,error);}
 async function release(entry){if(!entry)return;entry.node?.disconnect();await Promise.all([entry.output?.close().catch(()=>{}),entry.context?.close().catch(()=>{})]);}
 async function stop(){++epoch;const old=current;current=null;notify('off');if(old?.node){old.node.port.postMessage({type:'mute'});await new Promise(r=>setTimeout(r,35));}await release(old);}
 async function start(){const id=++epoch,entry={};notify('starting');
  try{entry.context=new AudioContext({sampleRate:48000,sinkId:{type:'none'}});current=entry;
   // A browser that still needs a tap inside the App leaves resume() pending; give up after 1.5 s and ask for that tap.
   const resumed=entry.context.resume();resumed.catch(()=>{});await Promise.race([resumed,new Promise(r=>setTimeout(r,1500))]);if(id!==epoch)return await release(entry);
   if(entry.context.state!=='running')throw Object.assign(new Error('Audio needs a tap.'),{code:'interaction_required'});
   entry.output=await VrchApp.audio.openOutput({channels:2});if(id!==epoch)return await release(entry);
   const destination=await entry.output.createNode(entry.context);await entry.context.audioWorklet.addModule(new URL('sound-worklet.js',location.href).href);if(id!==epoch)return await release(entry);
   entry.node=new AudioWorkletNode(entry.context,'magic-circle-sound',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[2]});entry.node.onprocessorerror=()=>{if(current===entry){current=null;void release(entry);notify('error','Sound unavailable. Press E1 to retry.');}};entry.node.port.postMessage({type:'settings',value:parameters});entry.node.connect(destination);notify('active');
  }catch(error){await release(entry);if(id!==epoch)return;current=null;notify('error',error.code==='interaction_required'?'Tap the screen to start sound.':['capability_denied','io_not_authorized','permission_denied'].includes(error.code)?'Allow audio output in Menu, then retry.':'Sound unavailable. Press E1 to retry.');}
 }
 return {start(){return state==='active'||state==='starting'?Promise.resolve():start();},toggle(){return state==='active'||state==='starting'?stop():start();},stop,update(value){parameters=value;current?.node?.port.postMessage({type:'settings',value});},pulse(strength){if(state==='active')current.node.port.postMessage({type:'pulse',strength});}};
};
