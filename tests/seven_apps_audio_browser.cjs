// Real Player/Agent/SDK/PCM transport; microphone hardware and control messages
// are fixtures. Restrict speaker selection as on the device Chromium runtime.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {spawn}=require('node:child_process'),readline=require('node:readline'),{chromium}=require('playwright');
const slugs=process.argv.slice(2);if(!slugs.length)slugs.push('beatbox-coach','disco-ball','gm-studio','petal-fm','pitch-shift','vocal-chain','wake-gate');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 try{for(const slug of slugs){
  const source=path.resolve(__dirname,'../apps',slug,'src'),pages=process.env.VRCH_PAGES_ROOT||path.resolve(__dirname,'../../vrch-web-viewer-pages');
  const driver=spawn('python3',[path.join(pages,'tests/vrch_apps_player_browser_driver.py'),'--audio-only','--app-source='+source]);
  driver.stderr.on('data',d=>process.stderr.write(d));const lines=readline.createInterface({input:driver.stdout});
  const config=await new Promise((resolve,reject)=>{lines.once('line',l=>resolve(JSON.parse(l)));driver.once('exit',c=>reject(Error('Driver exited '+c)));});
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:480,height:480}});
  try{
   await context.grantPermissions(['microphone'],{origin:new URL(config.url).origin});
   await context.addInitScript(()=>{
    const Native=AudioContext,Worklet=AudioWorkletNode;window.contexts=[];window.sinkSwitches=0;window.outputMeters=[];window.peak=0;
    window.AudioContext=class extends Native{constructor(...args){super(...args);contexts.push(this);}};
    if(window!==top){const gain=Native.prototype.createGain;AudioContext.prototype.createGain=function(){if(window.failNextGain){window.failNextGain=false;throw Error('fixture startup interruption');}return gain.call(this);};}
    if(window!==top)AudioContext.prototype.setSinkId=async function(){sinkSwitches++;throw new DOMException('Speaker selection refused','NotAllowedError');};
    window.AudioWorkletNode=class extends Worklet{constructor(c,n,o){super(c,n,o);if(window===top&&o?.processorOptions?.mode==='playback'){const m=c.createAnalyser();this.connect(m);outputMeters.push(m);}}};
    if(window===top){function sample(){for(const m of outputMeters){const a=new Float32Array(m.fftSize);m.getFloatTimeDomainData(a);for(const v of a)peak=Math.max(peak,Math.abs(v));}requestAnimationFrame(sample);}requestAnimationFrame(sample);}
   });
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
   await page.goto(config.url);
   async function launch(){await page.getByRole('button',{name:'Launch',exact:true}).click();const allow=page.getByRole('dialog').getByRole('button',{name:'Launch',exact:true});if(await allow.count())await allow.click();await page.waitForSelector('#screen:not([hidden]) iframe');const f=page.frames().find(f=>f.url().includes('/r/'));await f.waitForSelector('body');const start=page.getByRole('dialog').getByRole('button',{name:'Start',exact:true});if(await start.count())await start.click();return f;}
   let frame=await launch();
   async function control(key){for(const type of ['down','up'])await frame.evaluate(({key,type})=>{const b=__vrchAppBootstrap;b.port.dispatchEvent(new MessageEvent('message',{data:{type:'sdk_event',event:'controls',generation:b.binding.generation,data:{control:key,type}}}));},{key,type});}
   async function play(){
    await page.evaluate(()=>peak=0);
    if(slug==='wake-gate')await control('K4');
    else{
     await frame.waitForFunction(()=>contexts.some(c=>c.state==='running'));
     if(slug==='petal-fm'){
      await frame.locator('#keys .k.w').first().dispatchEvent('pointerdown',{pointerId:1});
     }else if(slug==='beatbox-coach'){await frame.waitForSelector('#gate[hidden]',{state:'attached'});await frame.locator('#pads .pad').first().dispatchEvent('pointerdown',{pointerId:1});}
     else if(slug==='gm-studio'){await frame.waitForSelector('#gate[hidden]',{state:'attached'});await frame.locator('#play').click();}
     else if(slug==='disco-ball'){await frame.locator('#chipPlay').click();}
    }
    try{await page.waitForFunction(()=>peak>.0001);}finally{if(slug==='petal-fm')await frame.locator('#keys .k.w').first().dispatchEvent('pointerup',{pointerId:1});}
    if(slug==='gm-studio')await frame.locator('#stop').click();
    if(slug==='disco-ball')await frame.locator('#chipPlay').click();
    assert.equal(await frame.evaluate(()=>sinkSwitches),0);
    assert.ok(await frame.evaluate(()=>contexts.some(c=>c.sampleRate===48000&&c.sinkId?.type==='none')));
   }
   if(slug==='wake-gate'){await frame.evaluate(()=>window.failNextGain=true);await control('K4');await frame.waitForFunction(()=>contexts.length>0&&contexts.every(c=>c.state==='closed'));}
   await play();const peak=await page.evaluate(()=>peak);
   // Exercise retry after an interrupted graph on the Apps that expose it.
   if(['beatbox-coach','petal-fm','pitch-shift','vocal-chain'].includes(slug)){
    const count=await frame.evaluate(()=>contexts.length);await frame.evaluate(()=>contexts.at(-1).suspend());
    const button=slug==='petal-fm'?'#lcd':'#gate-btn';await frame.locator(button).click();
    await frame.waitForFunction(n=>contexts.length>n&&contexts.at(-1).state==='running',count);await play();
   }
   // Retain an unknown App data key across the real host exit/reopen path.
   await frame.evaluate(()=>VrchApp.data.set('official-enrollment-regression',{unknown:[1,2,3]},{expectedVersion:0}));
   await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));
   await page.getByRole('dialog').getByRole('button',{name:'Exit',exact:true}).click();await page.waitForSelector('#library:not([hidden])');
   frame=await launch();await play();assert.deepEqual((await frame.evaluate(()=>VrchApp.data.get('official-enrollment-regression'))).value,{unknown:[1,2,3]});
   const manifest=JSON.parse(fs.readFileSync(path.join(source,'app.json')));const svg=fs.readFileSync(path.join(source,manifest.icon),'utf8');
   assert.deepEqual(errors,[]);
   await page.setContent('<body style="background:#222;color:white"><h2>'+manifest.name+'</h2>'+svg+'</body>');
   await page.locator('svg').evaluate(el=>{el.style.width='128px';el.style.height='128px';});
   const out=process.env.ARTIFACT_DIR||'/tmp/vrch-seven-apps-20261103';fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,slug+'-icon.png')});
   console.log('PASS '+slug+' real host PCM, silent 48kHz context, controls/start/stop, exit/reopen and retained data; peak='+peak);
  }catch(e){throw new Error(slug+': '+e.stack);}finally{await context.close();driver.stdin.end();lines.close();}
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
