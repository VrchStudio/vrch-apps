// Real Player/Agent/SDK/PCM and packaged tracking worker. OS camera/MIDI/audio are fixtures.
// A second pass selects the App's preview branch on the same real output bridge,
// so note auditions can be tested without pretending camera test patterns are hands.
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process'),readline=require('node:readline'),{chromium}=require('playwright');
(async()=>{
 const pages=process.env.VRCH_PAGES_ROOT||path.resolve(__dirname,'../../vrch-web-viewer-pages'),source=process.env.APP_SOURCE||path.resolve(__dirname,'../apps/palmnotes-duo/src');
 for(const preview of [false,true]){
  const driver=spawn('python3',[path.join(pages,'tests/vrch_apps_player_browser_driver.py'),'--audio-only','--camera','--controls','--app-source='+source]);driver.stderr.on('data',d=>process.stderr.write(d));
  const config=await new Promise((resolve,reject)=>{readline.createInterface({input:driver.stdout}).once('line',l=>resolve(JSON.parse(l)));driver.once('exit',c=>reject(Error('Driver '+c)));});
  const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
  try{
   const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:480,height:480}});await context.grantPermissions(['camera','microphone'],{origin:new URL(config.url).origin});
   await context.addInitScript(()=>{
    if(location.pathname.startsWith('/apps/content/')){window.appContextCount=0;const AC=AudioContext;window.AudioContext=class extends AC{constructor(...a){super(...a);appContextCount++;}};AudioContext.prototype.setSinkId=async()=>{throw new DOMException('Speaker selection refused','NotAllowedError');};return;}
    const listeners=new Set(),input={id:'fixture-k4e4',name:'Vrch VibeCtrl K4E4 v0.1.0',manufacturer:'VRCH',state:'connected',type:'input',connection:'open',addEventListener(t,f){if(t==='midimessage')listeners.add(f);},removeEventListener(t,f){listeners.delete(f);},open:async function(){return this;}};
    window.emit=(cc,v)=>{for(const f of listeners)f({target:input,data:new Uint8Array([0xb0,cc,v])});};Object.defineProperty(navigator,'requestMIDIAccess',{value:async()=>({inputs:new Map([[input.id,input]]),outputs:new Map(),addEventListener(){},removeEventListener(){}})});const query=navigator.permissions.query.bind(navigator.permissions);navigator.permissions.query=d=>d.name==='midi'?Promise.resolve({state:'granted',addEventListener(){}}):query(d);
    window.peak=0;window.meters=[];const N=AudioWorkletNode;window.AudioWorkletNode=class extends N{constructor(c,n,o){super(c,n,o);if(o?.processorOptions?.mode==='playback'){const m=c.createAnalyser();this.connect(m);meters.push(m);}}};function sample(){for(const m of meters){const a=new Float32Array(m.fftSize);m.getFloatTimeDomainData(a);for(const v of a)peak=Math.max(peak,Math.abs(v));}requestAnimationFrame(sample);}requestAnimationFrame(sample);
   });
   if(preview)await context.route('**/app.mjs',async r=>{const response=await r.fetch();const body=(await response.text()).replace("sdk.context.mode === 'preview'","true /* preview branch fixture */");await r.fulfill({response,body});});
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(config.url);
   async function key(cc){await page.evaluate(cc=>{emit(cc,127);emit(cc,0);},cc);}
   async function launch(){await page.getByRole('button',{name:'Launch',exact:true}).click();await page.waitForSelector('#mount iframe');const frame=page.frames().find(f=>f.url().includes('/r/'));await frame.waitForFunction(()=>!!globalThis.PalmNotesDuo);const start=page.getByRole('dialog').getByRole('button',{name:'Start',exact:true});if(await start.count())await start.click();return frame;}
   let frame=await launch();
   if(preview){await frame.getByRole('button',{name:'Preview Do',exact:true}).click();await frame.waitForFunction(()=>PalmNotesDuo.state.phase==='live');await page.waitForFunction(()=>peak>.001);await frame.waitForFunction(()=>PalmNotesDuo.state.soundingKey===null);console.log('PASS preview-branch note PCM on real SDK output; peak='+await page.evaluate(()=>peak));}
   else{await key(65);await frame.waitForFunction(()=>PalmNotesDuo.state.phase==='live'&&PalmNotesDuo.state.frames>2,null,{timeout:60000});await key(65);await frame.waitForFunction(()=>PalmNotesDuo.state.phase==='idle');await key(65);await frame.waitForFunction(()=>PalmNotesDuo.state.phase==='live'&&PalmNotesDuo.state.frames>4,null,{timeout:60000});await key(65);await frame.waitForFunction(()=>PalmNotesDuo.state.phase==='idle');console.log('PASS packaged tracker/camera and PCM output start/stop/restart');}
   assert.equal(await frame.evaluate(()=>appContextCount),0,'No App AudioContext/sink switch to repair');
   await key(69);let saved;for(let i=0;i<60;i++){saved=await frame.evaluate(()=>VrchApp.data.get('settings'));if(saved.value?.voice==='bell')break;await page.waitForTimeout(50);}assert.equal(saved.value.voice,'bell');
   await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));await page.getByRole('dialog').getByRole('button',{name:'Exit',exact:true}).click();await page.waitForSelector('#library:not([hidden])');frame=await launch();await frame.waitForFunction(()=>PalmNotesDuo.state.settings.voice==='bell');assert.deepEqual(errors,[]);console.log('PASS saved tone reopen ('+(preview?'preview branch':'device')+')');
  }finally{await browser.close();driver.stdin.end();}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
