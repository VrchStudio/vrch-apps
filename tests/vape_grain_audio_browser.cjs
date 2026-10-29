// Real Player/Agent/SDK/PCM bridge; OS audio devices are fixtures.
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process'),readline=require('node:readline'),{chromium}=require('playwright');
(async()=>{
 const pages=process.env.VRCH_PAGES_ROOT||path.resolve(__dirname,'../../vrch-web-viewer-pages'),source=process.env.APP_SOURCE||path.resolve(__dirname,'../apps/vape-grain/src');
 const driver=spawn('python3',[path.join(pages,'tests/vrch_apps_player_browser_driver.py'),'--audio-only','--app-source='+source]);driver.stderr.on('data',d=>process.stderr.write(d));
 const config=await new Promise((resolve,reject)=>{readline.createInterface({input:driver.stdout}).once('line',l=>resolve(JSON.parse(l)));driver.once('exit',c=>reject(Error('Driver exited '+c)));});
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 try{
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:480,height:480}});await context.grantPermissions(['microphone'],{origin:new URL(config.url).origin});
  await context.addInitScript(()=>{
   const Native=AudioContext,Worklet=AudioWorkletNode;window.contexts=[];window.sinkSwitches=0;window.messages=[];window.meter=null;window.outputMeters=[];window.peak=0;
   window.AudioContext=class extends Native{constructor(...args){super(...args);contexts.push(this);}};
   if(window!==top)AudioContext.prototype.setSinkId=async function(){sinkSwitches++;throw new DOMException('Speaker selection refused','NotAllowedError');};
   window.AudioWorkletNode=class extends Worklet{constructor(c,n,o){super(c,n,o);if(n==='vape-grain'){this.port.addEventListener('message',e=>{if(e.data.type==='meter')meter=e.data;});const send=this.port.postMessage.bind(this.port);this.port.postMessage=(m,...args)=>{if(m.type==='hold'||m.type==='mute')messages.push(m);return send(m,...args);};}if(window===top&&o?.processorOptions?.mode==='playback'){const m=c.createAnalyser();this.connect(m);outputMeters.push(m);}}};
   if(window===top){function sample(){for(const m of outputMeters){const a=new Float32Array(m.fftSize);m.getFloatTimeDomainData(a);for(const v of a)peak=Math.max(peak,Math.abs(v));}requestAnimationFrame(sample);}requestAnimationFrame(sample);}
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(config.url);
  async function launch(){await page.getByRole('button',{name:'Launch',exact:true}).click();const allow=page.getByRole('dialog').getByRole('button',{name:'Launch',exact:true});if(await allow.count())await allow.click();await page.waitForSelector('#screen:not([hidden]) iframe');const frame=page.frames().find(f=>f.url().includes('/r/'));await frame.waitForSelector('#k3');const start=page.getByRole('dialog').getByRole('button',{name:'Start',exact:true});if(await start.count())await start.click();return frame;}
  let frame=await launch();
  if(process.env.EXPECT_BASELINE_FAILURE){await frame.waitForFunction(()=>document.querySelector('#state em').textContent==='NO AUDIO');assert.ok(await frame.evaluate(()=>sinkSwitches>0));console.log('PASS original Vape Grain reproduces SDK sink-switch refusal');return;}
  await frame.waitForSelector('#state.live');assert.equal(await frame.evaluate(()=>sinkSwitches),0);await frame.waitForFunction(()=>meter?.listening);
  async function hold(id,check){const b=await frame.locator(id).boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);try{await page.mouse.down();await check();}finally{await page.mouse.up();}}
  await page.evaluate(()=>peak=0);await hold('#k3',async()=>{await frame.waitForFunction(()=>messages.some(m=>m.type==='hold'&&m.on));await page.waitForFunction(()=>peak>.001);});await frame.waitForFunction(()=>messages.filter(m=>m.type==='hold').at(-1)?.on===false);
  const peak=await page.evaluate(()=>peak);await hold('#k4',async()=>{await frame.waitForFunction(()=>document.querySelector('#k4').getAttribute('aria-pressed')==='true');});await frame.waitForFunction(()=>document.querySelector('#k4').getAttribute('aria-pressed')==='false');
  await frame.evaluate(()=>contexts.at(-1).suspend());await frame.waitForSelector('#start:not([hidden])');await frame.locator('#start').click();await frame.waitForSelector('#state.live');
  await frame.locator('#k2').click();let saved;for(let i=0;i<70;i++){saved=await frame.evaluate(()=>VrchApp.data.get('vape-grain'));if(saved.value?.preset===1)break;await page.waitForTimeout(50);}assert.equal(saved.value.preset,1);
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));await page.getByRole('dialog').getByRole('button',{name:'Exit',exact:true}).click();await page.waitForSelector('#library:not([hidden])');frame=await launch();await frame.waitForSelector('#state.live');assert.equal(await frame.locator('#preset').textContent(),'GLASS');assert.deepEqual(errors,[]);console.log('PASS Vape Grain input/output PCM, hold/release, mute/release, retry and saved preset reopen; peak='+peak);
 }finally{await browser.close();driver.stdin.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
