// Real Player/Agent/SDK and PCM bridge; OS microphone is a browser fixture.
// Preview branch selection is a fixture, not a test of the Maker Listen UI.
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process'),readline=require('node:readline'),{chromium}=require('playwright');
(async()=>{
 const pages=process.env.VRCH_PAGES_ROOT||path.resolve(__dirname,'../../vrch-web-viewer-pages'),source=process.env.APP_SOURCE||path.resolve(__dirname,'../apps/pitchplay/src');
 for(const preview of (process.env.EXPECT_BASELINE_FAILURE?[true]:[false,true])){
  const driver=spawn('python3',[path.join(pages,'tests/vrch_apps_player_browser_driver.py'),'--audio-only','--app-source='+source]);driver.stderr.on('data',d=>process.stderr.write(d));
  const config=await new Promise((r,j)=>{readline.createInterface({input:driver.stdout}).once('line',l=>r(JSON.parse(l)));driver.once('exit',c=>j(Error('Driver '+c)));});
  const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
  try{
   const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:480,height:480}});await context.grantPermissions(['microphone'],{origin:new URL(config.url).origin});
   await context.addInitScript(()=>{
    window.sinkSwitches=0;window.appContexts=[];const AC=AudioContext;window.AudioContext=class extends AC{constructor(...a){super(...a);appContexts.push(this);}};
    if(window!==top){AudioContext.prototype.setSinkId=async()=>{sinkSwitches++;throw new DOMException('Speaker selection refused','NotAllowedError');};return;}
    window.peak=0;window.meters=[];const N=AudioWorkletNode;window.AudioWorkletNode=class extends N{constructor(c,n,o){super(c,n,o);if(o?.processorOptions?.mode==='playback'){const m=c.createAnalyser();this.connect(m);meters.push(m);}}};function sample(){for(const m of meters){const a=new Float32Array(m.fftSize);m.getFloatTimeDomainData(a);for(const v of a)peak=Math.max(peak,Math.abs(v));}requestAnimationFrame(sample);}requestAnimationFrame(sample);
   });
   if(preview)await context.route('**/app.mjs',async r=>{const response=await r.fetch();await r.fulfill({response,body:(await response.text()).replace("sdk.context.mode === 'preview'",'true /* preview branch fixture */')});});
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(config.url);
   async function launch(){await page.getByRole('button',{name:'Launch',exact:true}).click();await page.waitForSelector('#mount iframe');const frame=page.frames().find(f=>f.url().includes('/r/'));await frame.waitForFunction(()=>globalThis.PitchPlay?.state.voice);const start=page.getByRole('dialog').getByRole('button',{name:'Start',exact:true});if(await start.count())await start.click();if(preview)await frame.locator('#primary').click();await frame.waitForFunction(()=>['live','error'].includes(PitchPlay.state.phase));return frame;}
   let frame=await launch();
   if(process.env.EXPECT_BASELINE_FAILURE){assert.equal(await frame.evaluate(()=>PitchPlay.state.phase),'error');assert.equal(await frame.evaluate(()=>PitchPlay.diagnostics.lastError),'NotAllowedError');console.log('PASS original PitchPlay preview reproduces sink-switch rejection');continue;}
   assert.equal(await frame.evaluate(()=>PitchPlay.state.phase),'live');assert.equal(await frame.evaluate(()=>appContexts.at(-1).sinkId.type),'none');assert.equal(await frame.evaluate(()=>sinkSwitches),0);
   await page.waitForFunction(()=>peak>.001);console.log('PCM peak '+(preview?'preview':'device')+': '+await page.evaluate(()=>peak));
   await frame.locator('#primary').click();assert.equal(await frame.evaluate(()=>PitchPlay.state.bypass),true);await frame.locator('#primary').click();assert.equal(await frame.evaluate(()=>PitchPlay.state.bypass),false);
   await frame.locator('#audio').click();await frame.waitForFunction(()=>PitchPlay.state.phase==='idle');await frame.locator('#primary').click();await frame.waitForFunction(()=>PitchPlay.state.phase==='live');
   await frame.evaluate(()=>appContexts.at(-1).suspend());await frame.waitForFunction(()=>PitchPlay.state.phase==='error');await frame.locator('#primary').click();await frame.waitForFunction(()=>PitchPlay.state.phase==='live');
   await frame.locator('#pitch').press('ArrowUp');const pitch=await frame.evaluate(()=>PitchPlay.state.pitch);let saved;for(let i=0;i<60;i++){saved=await frame.evaluate(()=>VrchApp.data.get('voice-settings'));if(saved.value?.pitch===pitch)break;await page.waitForTimeout(100);}assert.equal(saved.value.pitch,pitch);
   await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));await page.getByRole('dialog').getByRole('button',{name:'Exit',exact:true}).click();await page.waitForSelector('#library:not([hidden])');frame=await launch();assert.equal(await frame.evaluate(()=>PitchPlay.state.pitch),pitch);assert.deepEqual(await frame.evaluate(async()=>(await VrchApp.data.get('voice-settings')).value),saved.value);assert.deepEqual(errors,[]);
   console.log('PASS '+(preview?'preview branch':'device')+' real SDK PCM, compare, stop/restart, suspend/retry and settings reopen');
  }finally{await browser.close();driver.stdin.end();}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
