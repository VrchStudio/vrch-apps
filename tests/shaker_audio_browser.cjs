// Real Player, SDK, IMU and audio bridge; only OS sensor/audio devices are fixtures.
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process'),readline=require('node:readline'),{chromium}=require('playwright');
(async()=>{
 const pages=process.env.VRCH_PAGES_ROOT||path.resolve(__dirname,'../../vrch-web-viewer-pages');
 const source=process.env.APP_SOURCE||path.resolve(__dirname,'../apps/shaker-shaker/src');
 const driver=spawn('python3',[path.join(pages,'tests/vrch_apps_player_browser_driver.py'),'--audio-only','--imu','--app-source='+source]);driver.stderr.on('data',d=>process.stderr.write(d));
 const config=await new Promise((resolve,reject)=>{readline.createInterface({input:driver.stdout}).once('line',l=>resolve(JSON.parse(l)));driver.once('exit',code=>reject(Error('Driver exited '+code)));});
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 try{
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:480,height:480}});
  await context.addInitScript(()=>{
   const Native=AudioContext;window.audioContexts=[];window.sinkSwitches=0;
   window.AudioContext=class extends Native{constructor(...args){super(...args);audioContexts.push(this);}};
   if(window!==top)AudioContext.prototype.setSinkId=async function(){sinkSwitches++;throw new DOMException('Speaker selection refused','NotAllowedError');};
   if(window===top){const Worklet=AudioWorkletNode;window.outputMeters=[];window.peak=0;
    window.AudioWorkletNode=class extends Worklet{constructor(c,n,o){super(c,n,o);if(o?.processorOptions?.mode==='playback'){const m=c.createAnalyser();this.connect(m);outputMeters.push(m);}}};
    function sample(){for(const m of outputMeters){const a=new Float32Array(m.fftSize);m.getFloatTimeDomainData(a);for(const v of a)peak=Math.max(peak,Math.abs(v));}requestAnimationFrame(sample);}requestAnimationFrame(sample);
   }
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(config.url);
  async function launch(){await page.getByRole('button',{name:'Launch',exact:true}).click();const allow=page.getByRole('dialog').getByRole('button',{name:'Launch',exact:true});if(await allow.count())await allow.click();try{await page.waitForSelector('#screen:not([hidden]) iframe');}catch(e){console.error('LAUNCH STATE',await page.locator('body').innerText(),errors);throw e;}const frame=page.frames().find(f=>f.url().includes('/r/'));await frame.waitForSelector('#view');const start=page.getByRole('dialog').getByRole('button',{name:'Start',exact:true});if(await start.count())await start.click();return frame;}
  let frame=await launch();
  if(process.env.EXPECT_BASELINE_FAILURE){await frame.waitForFunction(()=>shaker.errors.length>0);assert.ok(await frame.evaluate(()=>sinkSwitches>0));console.log('PASS original Shaker reproduces SDK sink-switch refusal');return;}
  await frame.waitForFunction(()=>shaker.samples>2&&shaker.snapshot&&audioContexts.at(-1).state==='running');assert.equal(await frame.evaluate(()=>sinkSwitches),0);
  await page.evaluate(()=>peak=0);await frame.locator('#view').click({position:{x:120,y:220}});await page.waitForFunction(()=>peak>.001);const peak=await page.evaluate(()=>peak);
  await frame.locator('#sound').click();assert.equal(await frame.evaluate(()=>shaker.muted),true);await frame.locator('#sound').click();assert.equal(await frame.evaluate(()=>shaker.muted),false);
  const box=await frame.locator('#grip').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);try{await page.mouse.down();await frame.waitForFunction(()=>shaker.grip);}finally{await page.mouse.up();}await frame.waitForFunction(()=>!shaker.grip);
  await frame.evaluate(()=>audioContexts.at(-1).suspend());await frame.locator('#sound').click();await frame.waitForFunction(()=>audioContexts.at(-1).state==='running');
  await frame.locator('#tune').click();await frame.locator('[data-material="2"]').click();
  let saved;for(let i=0;i<60;i++){saved=await frame.evaluate(()=>VrchApp.data.get('settings'));if(saved.value?.material===2)break;await page.waitForTimeout(50);}assert.equal(saved.value.material,2);await frame.locator('#closeSettings').click();
  await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));await page.getByRole('dialog').getByRole('button',{name:'Exit',exact:true}).click();await page.waitForSelector('#library:not([hidden])');frame=await launch();await frame.waitForFunction(()=>shaker.settings.material===2&&shaker.snapshot);assert.deepEqual(await frame.evaluate(()=>shaker.errors),[]);assert.deepEqual(errors,[]);
  console.log('PASS Shaker real SDK PCM, IMU, tap, mute, grip release, resume, settings reopen; peak='+peak);
 }finally{await browser.close();driver.stdin.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
