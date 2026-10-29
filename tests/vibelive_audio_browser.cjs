// Real Player/Agent/SDK, WSS relay and PCM. Mac rendering and OS audio/control events are fixtures.
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process'),readline=require('node:readline'),{chromium}=require('playwright'),WebSocket=require('ws');
function loopFrame(id){
 const frames=48000,wav=Buffer.alloc(44+frames*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(96000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(frames*2,40);for(let i=0;i<frames;i++)wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*220/48000)*3000),44+i*2);
 const meta=Buffer.from(JSON.stringify({src:'mac',type:'loop',id,frames,pad:0,bpm:120,beats:2,at:'beat'})),head=Buffer.alloc(8);head.write('VLS1');head.writeUInt32BE(meta.length,4);return Buffer.concat([head,meta,wav]);
}
(async()=>{
 const pages=process.env.VRCH_PAGES_ROOT||path.resolve(__dirname,'../../vrch-web-viewer-pages'),source=process.env.APP_SOURCE||path.resolve(__dirname,'../apps/vibelive-synth/src');
 const driver=spawn('python3',[path.join(pages,'tests/vrch_apps_player_browser_driver.py'),'--shader-media','--app-source='+source]);driver.stderr.on('data',d=>process.stderr.write(d));
 const config=await new Promise((r,j)=>{readline.createInterface({input:driver.stdout}).once('line',l=>r(JSON.parse(l)));driver.once('exit',c=>j(Error('Driver '+c)));});
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});let mac,timer;
 try{
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:480,height:480}});await context.grantPermissions(['microphone'],{origin:new URL(config.url).origin});
  await context.addInitScript(()=>{
   window.contexts=[];window.sinkSwitches=0;const AC=AudioContext;window.AudioContext=class extends AC{constructor(...a){super(...a);contexts.push(this);}};
   if(window!==top){AudioContext.prototype.setSinkId=async()=>{sinkSwitches++;throw new DOMException('Speaker selection refused','NotAllowedError');};return;}
   window.peak=0;window.meters=[];const N=AudioWorkletNode;window.AudioWorkletNode=class extends N{constructor(c,n,o){super(c,n,o);if(o?.processorOptions?.mode==='playback'){const m=c.createAnalyser();this.connect(m);meters.push(m);}}};function sample(){for(const m of meters){const a=new Float32Array(m.fftSize);m.getFloatTimeDomainData(a);for(const v of a)peak=Math.max(peak,Math.abs(v));}requestAnimationFrame(sample);}requestAnimationFrame(sample);
  });
  // Control callback injection avoids the driver's separate Console lease fixture.
  await context.route('**/app.js',async r=>{const response=await r.fetch();await r.fulfill({response,body:(await response.text()).replace('VrchApp.controls.onEvent((e) => {','VrchApp.controls.onEvent(globalThis.testControl = (e) => {')});});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR',e.message);});await page.goto(config.url);
  async function launch(){await page.getByRole('button',{name:'Launch',exact:true}).click();const allow=page.getByRole('dialog').getByRole('button',{name:'Launch',exact:true});await Promise.race([allow.waitFor({state:'visible'}),page.waitForSelector('#mount iframe',{state:'attached'})]).catch(async e=>{console.log(await page.locator('body').innerText());throw e;});if(await allow.isVisible())await allow.click();await page.waitForSelector('#mount iframe',{state:'attached'});const frame=await(await page.locator('#mount iframe').elementHandle()).contentFrame();await frame.waitForSelector('#bank .slot',{state:'attached'}).catch(async e=>{console.log('HOST',await page.locator('body').innerText(),'APP',await frame.locator('body').innerText());throw e;});const start=page.getByRole('dialog').getByRole('button',{name:'Start',exact:true});await start.waitFor({state:'visible',timeout:1500}).catch(()=>{});if(await start.isVisible())await start.click();await frame.waitForFunction(()=>contexts.length>0);return frame;}
  let frame=await launch();
  if(process.env.EXPECT_BASELINE_FAILURE){await frame.waitForFunction(()=>sinkSwitches>0);await frame.waitForFunction(()=>document.getElementById('toast').textContent.includes('Speaker selection refused'));console.log('PASS original VibeLive Synth reproduces output sink-switch refusal');return;}
  await page.waitForFunction(()=>meters.length>0);assert.equal(await frame.evaluate(()=>contexts[0].sinkId.type),'none');assert.equal(await frame.evaluate(()=>sinkSwitches),0);
  const messages=[];mac=new WebSocket(config.ioUrl+'/json?channel=7',{rejectUnauthorized:false});await new Promise((r,j)=>{mac.once('open',r);mac.once('error',j);});mac.on('message',(b,binary)=>{if(binary)return;try{let m=JSON.parse(b.toString());if(typeof m==='string')m=JSON.parse(m);messages.push(m);}catch{}});
  const heartbeat=()=>mac.send(JSON.stringify({src:'mac',type:'state',data:{keywords:['Warm pad','Soft bass'],weights:{'Warm pad':1,'Soft bass':.6},variation:.5,seed:42}}));heartbeat();timer=setInterval(heartbeat,500);
  await frame.waitForFunction(()=>document.querySelector('#bank').textContent.includes('Warm pad'));
  async function sendLoop(id){mac.send(loopFrame(id));for(let i=0;i<100&&!messages.some(m=>m.type==='playing'&&m.id===id);i++)await page.waitForTimeout(50);assert(messages.some(m=>m.type==='playing'&&m.id===id),'Loop acknowledged');await page.waitForFunction(()=>peak>.001);}
  await sendLoop(1);console.log('PCM peak '+await page.evaluate(()=>peak));
  await frame.evaluate(()=>{testControl({control:'K4',type:'down'});testControl({control:'K4',type:'up'});});await frame.waitForFunction(()=>document.getElementById('r-status').textContent.includes('muted'));await page.waitForTimeout(250);await page.evaluate(()=>peak=0);await page.waitForTimeout(150);assert(await page.evaluate(()=>peak)<.001);
  await frame.evaluate(()=>{testControl({control:'K4',type:'down'});testControl({control:'K4',type:'up'});});await page.waitForFunction(()=>peak>.001);
  await frame.evaluate(()=>contexts[0].suspend());await frame.locator('#audio-gate:not(.hidden)').click();await frame.waitForFunction(()=>contexts[0].state==='running');
  await frame.evaluate(()=>testControl({control:'K2',type:'down'}));try{await frame.waitForFunction(()=>!document.getElementById('rec-badge').classList.contains('hidden'));await page.waitForTimeout(450);}finally{await frame.evaluate(()=>testControl({control:'K2',type:'up'}));}
  for(let i=0;i<60&&!messages.some(m=>m.type==='take'&&m.fresh);i++)await page.waitForTimeout(50);const take=messages.find(m=>m.type==='take'&&m.fresh);assert(take?.n>=7200);assert.equal(take.codec,'mulaw8');
  await frame.locator('#idea').fill('warm test loop');await frame.locator('#vibe-btn').click();let saved;for(let i=0;i<50;i++){saved=await frame.evaluate(()=>VrchApp.data.get('idea'));if(saved.value==='warm test loop')break;await page.waitForTimeout(100);}assert.equal(saved.value,'warm test loop');
  clearInterval(timer);mac.close();await frame.waitForFunction(()=>document.getElementById('r-status').textContent.includes('offline'));await page.evaluate(()=>peak=0);await page.waitForFunction(()=>peak>.001);
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));await page.getByRole('dialog').getByRole('button',{name:'Exit',exact:true}).click();await page.waitForSelector('#library:not([hidden])');frame=await launch();await frame.waitForFunction(()=>document.getElementById('idea').value==='warm test loop');assert.deepEqual(await frame.evaluate(()=>VrchApp.data.get('idea')),saved);assert.deepEqual(errors,[]);
  console.log('PASS real WSS loop decode/playback, PCM, mute/unmute, resume, recorded take, offline continuation and saved idea reopen; Mac generation is a fixture');
 }finally{clearInterval(timer);mac?.close();await browser.close();driver.stdin.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
