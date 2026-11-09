// Actual TLS Player/Agent, opaque App, SDK camera + output, Worker/WASM/model.
// The camera feeds a known still photograph through a real canvas MediaStream;
// hardware, managed Player process and K4E4 are fixtures, not human acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {spawn} = require('node:child_process'), readline = require('node:readline');
const {chromium} = require('playwright');
const pages = process.env.VRCH_PAGES_ROOT || path.resolve(__dirname,'../../vrch-web-viewer-pages'), source = process.env.APP_SOURCE || path.resolve(__dirname,'../apps/palm-notes/src'), out='/tmp/palm-notes/evidence';

(async()=>{
  fs.mkdirSync(out,{recursive:true}); fs.mkdirSync('/tmp/vrch-apps-implementation-qa',{recursive:true});
  const driver=spawn('python3',[path.join(pages,'tests/vrch_apps_player_browser_driver.py'),'--camera','--controls','--app-source='+source]);
  driver.stderr.on('data',data=>process.stderr.write(data));
  const lines=readline.createInterface({input:driver.stdout});
  const info=await new Promise((resolve,reject)=>{lines.once('line',line=>resolve(JSON.parse(line)));driver.once('exit',code=>reject(Error('Driver '+code)));});
  const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--autoplay-policy=document-user-activation-required','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
  try {
    const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:480,height:480},hasTouch:true,permissions:['camera']});
    const verifyAssets=require(path.join(pages,'tests/vrch_apps_browser_assets.cjs'))(context,'palm-notes');
    const served=new Set(), assetChecks=[], assetErrors=[];let injectingModelFailure=false;
    context.on('response',response=>{
      const name=new URL(response.url()).pathname.split('/r/')[1]?.split('/').slice(2).join('/');
      if(injectingModelFailure&&response.status()===503&&name==='models/mediapipe/hand_landmarker-lite-v1.task')return;
      // Repeated startup requests may be intentionally cancelled below. Each
      // immutable package resource only needs one completed byte comparison.
      if(served.has(name))return;
      if(name && name!=='index.html' && fs.existsSync(path.join(source,name))) assetChecks.push(response.body().then(bytes=>{
        assert.equal(response.status(),200); assert.deepEqual(bytes,fs.readFileSync(path.join(source,name))); served.add(name);
      }).catch(error=>assetErrors.push({name,message:error.message})));
    });
    await context.addInitScript(()=>{
      if(window!==top)return;
      window.cameraStreams=[];window.cameraMode='image';window.denied=false;window.pendingCapture=false;window.micRequests=0;
      const native=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async constraints=>{
        if(constraints.audio) { micRequests++; return native(constraints); }
        if(denied)throw new DOMException('Test permission refusal','NotAllowedError');
        if(pendingCapture)await new Promise(resolve=>window.releaseCapture=resolve);
        const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
        const ctx=canvas.getContext('2d');
        const draw=()=>{ctx.fillStyle='#202020';ctx.fillRect(0,0,640,480);if(cameraMode==='image'&&window.handImage){const scale=Math.min(640/handImage.width,480/handImage.height);ctx.drawImage(handImage,(640-handImage.width*scale)/2,(480-handImage.height*scale)/2,handImage.width*scale,handImage.height*scale);}};
        draw();const timer=setInterval(draw,33),stream=canvas.captureStream(30);
        const track=stream.getVideoTracks()[0],stop=track.stop.bind(track);
        track.stop=()=>{clearInterval(timer);stop();};cameraStreams.push(stream);return stream;
      };
      const listeners=new Set(), input={id:'test-k4e4',name:'Vrch VibeCtrl K4E4 v0.1.0',manufacturer:'VRCH',state:'connected',type:'input',connection:'open',addEventListener(t,fn){if(t==='midimessage')listeners.add(fn);},removeEventListener(t,fn){listeners.delete(fn);},async open(){return this;}};
      window.key=(cc,value)=>{for(const fn of listeners)fn({target:input,currentTarget:input,data:new Uint8Array([0xb0,cc,value])});};
      Object.defineProperty(navigator,'requestMIDIAccess',{value:async()=>({inputs:new Map([[input.id,input]]),outputs:new Map(),addEventListener(){},removeEventListener(){}})});
      const query=navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query=value=>value.name==='midi'?Promise.resolve({state:'granted',addEventListener(){}}):query(value);
      window.audioProbes=[];
      const connect=AudioNode.prototype.connect;
      AudioNode.prototype.connect=function(destination,...args){
        const result=connect.call(this,destination,...args);
        if(this instanceof GainNode&&destination===this.context.destination&&!this.probed){
          this.probed=true; const analyser=this.context.createAnalyser();analyser.fftSize=8192;
          connect.call(this,analyser);audioProbes.push(analyser);
        }
        return result;
      };
    });
    const page=await context.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(e.message)); page.setDefaultTimeout(30000);
    await page.goto(info.url);
    async function picture(file) {
      const data=fs.readFileSync(file).toString('base64');
      await page.evaluate(async data=>{const image=new Image();image.src='data:image/'+(data.startsWith('/9j/')?'jpeg':'png')+';base64,'+data;await image.decode();window.handImage=image;window.cameraMode='image';},data);
    }
    await picture(path.join(pages,'tests/fixtures/scene-phase4-h1/open-hand-neutral-right.png'));
    await page.getByRole('button',{name:'Launch',exact:true}).click();
    const confirm=page.getByRole('dialog').getByRole('button',{name:'Launch',exact:true});
    if(await confirm.isVisible())await confirm.click();
    await page.waitForSelector('#mount iframe');
    const guide=page.getByRole('dialog').getByRole('button',{name:'Start',exact:true});
    if(await guide.isVisible())await guide.click();
    let app=page.frames().find(frame=>frame.url().includes('/r/'));
    await app.locator('#start:not([disabled])').waitFor();
    await app.evaluate(()=>{
      const Native=Worker;window.modelResults=[];
      window.Worker=class extends Native {constructor(...args){super(...args);this.addEventListener('message',({data})=>{if(data.type==='result'){modelResults.push(data);if(modelResults.length>30)modelResults.shift();}});}};
    });
    await app.locator('body').screenshot({path:out+'/idle-480.png'});
    await app.locator('#start').click();
    await app.waitForFunction(()=>PalmNotes.state.phase==='live',{},{timeout:60000}).catch(async error=>{console.log(await app.locator('body').innerText());throw error;});
    if(process.argv.includes('--probe')) {
      const results={};
      for(const [name,file] of [['open-right',path.join(pages,'tests/fixtures/scene-phase4-h1/open-hand-neutral-right.png')],['open-left',path.join(pages,'tests/fixtures/scene-phase4-h1/open-hand-neutral.png')],...['fist','thumb_up','pointing_up','victory'].map(n=>[n,'/tmp/palm-notes/'+n+'.jpg'])]) {
        await picture(file);await page.waitForTimeout(1200);
        results[name]=await app.evaluate(()=>({state:PalmNotes.state,result:modelResults.at(-1)}));
        console.log(name,JSON.stringify(results[name].state));
        await app.locator('body').screenshot({path:out+'/probe-'+name+'.png'});
      }
      fs.writeFileSync(out+'/model-probe.json',JSON.stringify(results,null,2));return;
    }
    await app.waitForFunction(()=>PalmNotes.state.count===5,{},{timeout:60000}).catch(async error=>{console.log('STATE',await app.evaluate(()=>PalmNotes.state));throw error;});
    console.log('MODEL',JSON.stringify(await app.evaluate(()=>PalmNotes.state)));
    assert.equal(await page.evaluate(()=>micRequests),0);
    assert.equal(await app.evaluate(()=>document.featurePolicy.allowsFeature('camera')),false);
    for(const [width,height] of [[320,432],[390,432],[480,432],[480,480],[900,652]]) {
      await page.setViewportSize({width,height:height+48});
      // Component canvas sizes beyond the native 480px shell also need a
      // matching fixture mount, so pointer tests hit the visible App surface.
      await page.evaluate(({width,height})=>{
        document.body.style.setProperty('--apps-runtime-left','0px');document.body.style.setProperty('--apps-runtime-top','0px');
        Object.assign(document.getElementById('screen').style,{width:width+'px',height:height+48+'px'});
        Object.assign(document.getElementById('mount').style,{width:width+'px',height:height+'px'});
      },{width,height});
      await page.locator('#mount iframe').evaluate((el,{width,height})=>{el.style.width=width+'px';el.style.height=height+'px';},{width,height});
      await page.locator('#screen > .live-console-vibectrl-monitor').evaluateAll(elements=>{for(const el of elements)el.style.visibility='hidden';});
      await app.waitForFunction(({width,height})=>innerWidth===width&&innerHeight===height,{width,height});
      assert(await app.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight));
      assert(await app.locator('button,input').evaluateAll(elements=>elements.filter(e=>!e.hidden).every(e=>e.getBoundingClientRect().height>=44)));
      await app.locator('body').screenshot({path:out+'/live-'+width+'x'+height+'.png'});
      // Keyboard covers each resized component canvas. Native-size pointer
      // selection is exercised below and in the actual Maker Preview.
      await app.locator('#voice').press('Enter');
      await app.getByRole('menu').waitFor();
      assert.equal(await app.getByRole('menuitem').count(),4);
      assert(await app.getByRole('menuitem').evaluateAll(items=>items.every(el=>el.getBoundingClientRect().height>=44)));
      await app.locator('body').screenshot({path:out+'/tones-'+width+'x'+height+'.png'});
      await page.keyboard.press('Escape');
      assert.equal(await app.getByRole('menu').count(),0,'Escape dismisses tone choices');
      assert.equal(await page.getByRole('heading',{name:'Menu',exact:true}).count(),0,'tone Escape does not open host Menu');
    }
    await page.setViewportSize({width:480,height:480});
    await page.evaluate(()=>{
      document.body.style.removeProperty('--apps-runtime-left');document.body.style.removeProperty('--apps-runtime-top');
      for(const id of ['screen','mount']){document.getElementById(id).style.width='';document.getElementById(id).style.height='';}
    });
    await page.locator('#mount iframe').evaluate(el=>{el.style.width='';el.style.height='';});
    await app.waitForFunction(()=>PalmNotes.state.count===5);
    // Screenshot/layout work can intentionally expire the safety lease. Sample
    // a fresh analyser window after recovery instead of averaging that silence.
    await page.waitForTimeout(350);
    const audio=await page.evaluate(()=>{
      const a=audioProbes.at(-1),data=new Float32Array(a.fftSize);a.getFloatTimeDomainData(data);
      const rms=Math.sqrt(data.reduce((sum,v)=>sum+v*v,0)/data.length);
      const crossings=[];for(let i=1;i<data.length;i++)if(data[i-1]<=0&&data[i]>0)crossings.push(i);
      return {rms,frequency:(crossings.length-1)*a.context.sampleRate/(crossings.at(-1)-crossings[0])};
    });
    console.log('HOST_AUDIO',JSON.stringify(audio));assert(audio.rms>.01); assert(Math.abs(audio.frequency-391.995)<2);
    const resources=await page.evaluate(()=>({cameras:cameraStreams.length,outputs:audioProbes.length}));
    const timbres=[];
    for(const voice of ['Soft','Bell','Pluck','Retro']) {
      await app.locator('#voice').click();await app.getByRole('menuitem',{name:new RegExp('^'+voice)}).click();
      await app.waitForFunction(voice=>PalmNotes.state.settings.voice===voice.toLowerCase(),voice);
      await page.waitForTimeout(300);
      timbres.push(await page.evaluate(voice=>{
        const a=audioProbes.at(-1),data=new Float32Array(a.fftSize);a.getFloatTimeDomainData(data);
        const mag=f=>{let re=0,im=0;for(let i=0;i<data.length;i++){const p=2*Math.PI*f*i/a.context.sampleRate;re+=data[i]*Math.cos(p);im+=data[i]*Math.sin(p);}return Math.hypot(re,im);};
        const fundamental=mag(391.995436);return {voice,fundamental,ratios:[2,3,5].map(n=>mag(391.995436*n)/fundamental)};
      },voice));
      assert.equal(await app.evaluate(()=>PalmNotes.state.phase),'live');
    }
    assert(timbres.every(v=>v.fundamental>10),'all four host timbres are audible');
    for(let i=0;i<4;i++)for(let j=i+1;j<4;j++)assert(Math.hypot(...timbres[i].ratios.map((v,k)=>v-timbres[j].ratios[k]))>.09,'distinct host timbres');
    assert.deepEqual(await page.evaluate(()=>({cameras:cameraStreams.length,outputs:audioProbes.length})),resources,'preset changes preserve capture and output');
    await page.evaluate(()=>key(21,1));await app.waitForFunction(()=>PalmNotes.state.settings.voice==='soft');
    await page.evaluate(()=>{key(69,127);key(69,127);key(69,0);});await app.waitForFunction(()=>PalmNotes.state.settings.voice==='bell');
    console.log('HOST_TIMBRES',JSON.stringify(timbres));
    await page.evaluate(()=>window.cameraMode='blank');
    await app.waitForFunction(()=>PalmNotes.state.count===null);
    await page.waitForTimeout(180);
    const silence=await page.evaluate(()=>{const a=audioProbes.at(-1),data=new Float32Array(a.fftSize);a.getFloatTimeDomainData(data);return Math.max(...data.slice(-512).map(Math.abs));});
    assert(silence<.0001,'no hand releases real host audio: '+silence);
    await app.locator('body').screenshot({path:out+'/no-hand.png'});
    await page.evaluate(()=>window.cameraMode='image');
    await app.waitForFunction(()=>PalmNotes.state.count===5);
    // Real still photos, when downloaded, travel through the camera bridge/model.
    for(const [name,expected] of [['fist',0],['thumb_up',1],['pointing_up',1],['victory',2],['hand-3',3],['hand-4',4],['shaka',6],['ok',7],['hand-3',3],['shaka',6],['fist',0]]) {
      const file='/tmp/palm-notes/'+name+(name==='shaka'?'.png':'.jpg');assert(fs.existsSync(file),'Run fetch-fixtures.py first');
      const before=await app.evaluate(()=>PalmNotes.state.frames);
      await picture(file);
      await app.waitForFunction(before=>PalmNotes.state.frames>=before+5,before);
      await app.waitForFunction(n=>PalmNotes.state.count===n,expected,{timeout:20000}).catch(async error=>{console.log(name,await app.evaluate(()=>PalmNotes.state));throw error;});
      const expectedBits={fist:[false,false,false,false,false],thumb_up:[true,false,false,false,false],pointing_up:[false,true,false,false,false],victory:[false,true,true,false,false]};
      if(expectedBits[name])assert.deepEqual(await app.evaluate(()=>PalmNotes.state.bits),expectedBits[name]);
      if(expected===6||expected===7) {
        assert.equal(await app.locator('#count').innerText(),expected===6?'6':'OK');
        assert.doesNotMatch(await app.locator('#tracking').innerText(),/[67] FINGERS/);
      }
      console.log('PHOTO',name,JSON.stringify(await app.evaluate(()=>PalmNotes.state)));
      await app.locator('body').screenshot({path:out+'/'+name+'.png'});
    }
    await picture(path.join(pages,'tests/fixtures/scene-phase4-h1/open-hand-neutral.png'));
    await app.waitForFunction(()=>PalmNotes.state.count===5);
    // The host keeps rendering while the UI is blocked. Inspect samples from
    // 100-150ms BEFORE recovery, not a fresh note legitimately resumed afterward.
    await app.evaluate(()=>{const until=performance.now()+550;while(performance.now()<until){};});
    const stalledSilence=await page.evaluate(()=>{const a=audioProbes.at(-1),data=new Float32Array(a.fftSize);a.getFloatTimeDomainData(data);return Math.max(...data.slice(1024,3072).map(Math.abs));});
    assert(stalledSilence<.0001,'stalled UI releases host audio: '+stalledSilence);
    await app.waitForFunction(()=>PalmNotes.state.count===5);
    console.log('CHECK stall recovery');
    await app.locator('#mirror').click();
    assert.equal(await app.evaluate(()=>PalmNotes.state.settings.mirror),false);
    for(let i=0;i<4;i++) {
      const before=await app.evaluate(()=>PalmNotes.state.frames);
      await app.locator('#rotate').click();
      await app.waitForFunction(before=>PalmNotes.state.frames>before+5&&PalmNotes.state.count===5,before);
    }
    await app.locator('#rotate').click();
    assert.equal(await app.evaluate(()=>PalmNotes.state.phase),'live','rotate does not stop camera');
    await app.locator('#volume').fill('43');
    console.log('CHECK rotations');
    await app.waitForFunction(async()=> (await VrchApp.data.get('settings')).value?.volume===43);
    await app.locator('#start').click();
    await app.waitForFunction(()=>PalmNotes.state.phase==='idle');
    await page.waitForFunction(()=>cameraStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
    const modelRoute='**/models/mediapipe/hand_landmarker-lite-v1.task';
    injectingModelFailure=true;
    await context.route(modelRoute,route=>route.fulfill({status:503,body:'Test unavailable model'}));
    await app.locator('#start').click();await app.waitForFunction(()=>PalmNotes.state.phase==='error');
    assert.match(await app.locator('#message').innerText(),/tracking/);
    await context.unroute(modelRoute);
    injectingModelFailure=false;
    console.log('CHECK model failure');
    await page.evaluate(()=>window.denied=true);
    await app.locator('#start').click();
    await app.waitForFunction(()=>PalmNotes.state.phase==='error');
    assert.match(await app.locator('#message').innerText(),/Allow the camera/);
    await app.locator('body').screenshot({path:out+'/denied.png'});
    console.log('CHECK permission denial');
    await page.evaluate(()=>window.denied=false);
    await app.locator('#start').click();await app.waitForFunction(()=>PalmNotes.state.phase==='live');
    await page.evaluate(()=>{const track=cameraStreams.at(-1).getVideoTracks()[0];track.stop();track.dispatchEvent(new Event('ended'));});
    await app.waitForFunction(()=>PalmNotes.state.phase==='error');
    console.log('CHECK camera removal');
    await app.locator('#start').click();await app.waitForFunction(()=>PalmNotes.state.phase==='live');
    await app.locator('#start').click();
    // A late camera permission result cannot revive a cancelled Start.
    await page.evaluate(()=>window.pendingCapture=true);
    await app.locator('#start').click();await page.waitForFunction(()=>!!window.releaseCapture);
    await app.locator('#start').click();
    await page.evaluate(()=>{pendingCapture=false;releaseCapture();});
    await page.waitForTimeout(300);
    assert.equal(await app.evaluate(()=>PalmNotes.state.phase),'idle');
    await page.waitForFunction(()=>cameraStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
    console.log('CHECK cancelled start');
    await page.evaluate(()=>{key(65,127);key(65,127);key(65,0);});
    await app.waitForFunction(()=>PalmNotes.state.phase==='live');
    await page.evaluate(()=>{key(65,127);key(65,0);});
    await app.waitForFunction(()=>PalmNotes.state.phase==='idle');
    console.log('CHECK K2');
    await app.evaluate(()=>VrchApp.data.set('unrelated',{keep:42},{expectedVersion:0}));
    await app.locator('#volume').focus();await page.keyboard.press('Escape');
    const old=app;
    await Promise.all([page.waitForEvent('framedetached',frame=>frame===old),page.getByRole('button',{name:'Reload',exact:true}).click()]);
    await page.waitForFunction(()=>{const frames=document.querySelectorAll('#mount iframe');return frames.length===1&&!frames[0].inert;});
    app=page.frames().find(frame=>frame.url().includes('/r/'));
    await app.waitForFunction(()=>!document.getElementById('start').disabled);
    assert.deepEqual(await app.evaluate(()=>PalmNotes.state.settings),{rotation:90,mirror:false,volume:43,voice:'bell'});
    assert.equal((await app.evaluate(()=>VrchApp.data.get('unrelated'))).value.keep,42);
    assert.equal(await app.evaluate(()=>PalmNotes.state.phase),'idle');
    console.log('CHECK reload');
    await app.locator('#volume').focus();await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Exit',exact:true}).click();await page.waitForSelector('#library:not([hidden])');
    await page.getByRole('button',{name:'Launch',exact:true}).click();await page.waitForSelector('#mount iframe');
    app=page.frames().find(frame=>frame.url().includes('/r/'));
    await app.waitForFunction(()=>!document.getElementById('start').disabled);
    assert.deepEqual(await app.evaluate(()=>PalmNotes.state.settings),{rotation:90,mirror:false,volume:43,voice:'bell'});
    await Promise.all(assetChecks);
    // Chromium can discard a cancelled worker response's body during teardown.
    // Accept that diagnostic only when this immutable resource was independently
    // byte-compared on another completed response; mismatched bytes still fail.
    const unresolvedAssets=assetErrors.filter(error=>!served.has(error.name)||!/No data found for resource|not available for a response that was navigated away/.test(error.message));
    assert.deepEqual(unresolvedAssets,[]);assert.deepEqual(errors,[]);await verifyAssets();
    for(const name of ['app.mjs','gesture.mjs','tone.mjs','instrument.json','popover.css','popover-theme.css','scripts/vrch_pages_live_console_action_popover.js','models/mediapipe/hand_landmarker-lite-v1.task'])assert(served.has(name),name+' bytes verified');
    fs.writeFileSync(out+'/result.json',JSON.stringify({audio,timbres,silence,stalledSilence,served:[...served],errors},null,2));
    console.log('PASS Player/SDK/model/audio, layouts, rotated/left/right photos, UI-stall mute, model failure, camera denial/unplug/retry, cancel, K2, reload/reopen and saved data');
  } catch(error) {
    console.error('TEST_FAILURE',error);
    throw error;
  } finally {
    await browser.close();driver.stdin.end();
    await new Promise(resolve=>{if(driver.exitCode!==null)return resolve();const timer=setTimeout(()=>driver.kill('SIGTERM'),5000);driver.once('exit',()=>{clearTimeout(timer);resolve();});});
    lines.close();
  }
})().catch(error=>{console.error(error);process.exit(1);});
