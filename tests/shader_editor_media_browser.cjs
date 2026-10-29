const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
const readline = require('node:readline');
const {chromium} = require('playwright');
(async () => {
  const root = process.env.VRCH_PAGES_ROOT || path.resolve(__dirname, '../../vrch-web-viewer-pages'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shader-media-'));
  const source = process.env.APP_SOURCE || path.resolve(__dirname, '../apps/shader-editor/src');
  const evidence = process.env.VRCH_UI_EVIDENCE_DIR || '/tmp/vrch-shader-media-qa/native';
  fs.mkdirSync(evidence,{recursive:true});
  const driver = spawn('python3', [path.join(root, 'tests/vrch_apps_player_browser_driver.py'), '--shader-media', '--app-source=' + source]);
  driver.stderr.on('data', data => process.stderr.write(data));
  const lines = readline.createInterface({input: driver.stdout});
  const config = await new Promise((resolve, reject) => {lines.once('line', line => resolve(JSON.parse(line))); driver.once('exit', code => reject(Error('Driver ' + code)));});
  const browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']});
  try {
    const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 480, height: 480}});
    await context.addInitScript(()=>{if(window!==top){window.analysisContexts=[];const AC=AudioContext;window.AudioContext=class extends AC{constructor(...a){super(...a);analysisContexts.push(this);}};AudioContext.prototype.setSinkId=async()=>{throw new DOMException('Speaker selection refused','NotAllowedError');};return;}const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);window.capturedStreams=[];window.denyCamera=false;navigator.mediaDevices.getUserMedia=async options=>{if(window.denyCamera&&options.video){window.denyCamera=false;throw new DOMException('Fixture denied camera','NotAllowedError');}const stream=await capture(options);capturedStreams.push(stream);return stream;};});
    await context.grantPermissions(['microphone', 'camera'], {origin: new URL(config.url).origin});
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    await page.route('http://127.0.0.1:18927/local-actions/vibectrl-s1/**', route => route.fulfill({status: 404, body: '{}'}));
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(config.url);
    await page.getByRole('button', {name: 'Launch', exact: true}).click();
    await page.getByRole('dialog').getByRole('button', {name: 'Launch', exact: true}).click();
    await page.waitForSelector('#screen:not([hidden]) iframe');
    let app = page.frames().find(frame => frame.url().includes('/r/'));
    await app.locator('#chooseVisual:not([disabled])').waitFor();
    if (await page.locator('#modal [data-close]').isVisible()) await page.locator('#modal [data-close]').click();
    async function choose(name, id) {
      await app.locator('#chooseVisual').click();
      const picker = app.locator('.scene-picker-modal:visible');
      await picker.locator('[data-role="search-open"]').click(); await picker.locator('[data-role="filter"]').fill(name);
      await picker.locator('[data-scene-picker-select="' + id + '"]').click(); await picker.locator('[data-role="confirm"]').click();
    }
    await choose('Mosaic', 'builtin:vrch.mosaic');
    const rows = () => app.locator('.shader-media-row');
    async function sourceChoice(label, name) {
      await app.getByRole('button', {name: label + ' source', exact: true}).click();
      await app.getByRole('menuitem', {name, exact: true}).click();
    }
    // Observe the real shader sources and signal values without replacing SDK methods.
    await app.evaluate(() => {
      const proto = VrchSceneRuntime.SceneEffect.prototype, original = proto.prepareFrame;
      proto.prepareFrame = function(time, audio) {window.mediaEvidence = {sources: this.sourceInputs?.map(source => source?.tagName), rms: audio?.rms, audio}; window.mediaEffect = this; return original.call(this, time, audio);};
    });
    await sourceChoice('Image A', 'Channel 3');
    await rows().nth(1).getByRole('status').filter({hasText: 'Waiting for data'}).waitFor();
    await page.evaluate(async base => {
      window.imageSender = new WebSocket(base + '/image?channel=3');
      await new Promise((resolve, reject) => {imageSender.onopen = resolve; imageSender.onerror = reject;});
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
      const c = canvas.getContext('2d'); c.fillStyle = '#ff0000'; c.fillRect(0,0,32,32);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const bytes = new Uint8Array(8 + blob.size); bytes.set(new Uint8Array(await blob.arrayBuffer()), 8); imageSender.send(bytes);
    }, config.ioUrl);
    await app.waitForFunction(() => window.mediaEffect?.sourceInputs?.some(source => source?.width === 32));
    const red = await app.evaluate(() => Array.from(mediaEffect.sourceInputs[0].getContext('2d').getImageData(0,0,1,1).data));
    assert.deepEqual(red, [255, 0, 0, 255], 'Channel image reaches physical Source A');
    await page.evaluate(() => imageSender.send('fixture:close'));
    await rows().nth(1).getByRole('button', {name: 'Retry', exact: true}).waitFor();
    assert.equal(await app.evaluate(() => mediaEffect.sourceInputs[0].width), 512, 'Disconnect removes stale image');
    await rows().nth(1).getByRole('button', {name: 'Retry', exact: true}).click();
    await rows().nth(1).getByRole('status').filter({hasText: 'Waiting for data'}).waitFor();
    await sourceChoice('Image A', 'Sample');
    await app.getByRole('button', {name: 'Image A source', exact: true}).click();
    const cameraName = await app.getByRole('menuitem').filter({hasText: 'fake_device'}).first().innerText();
    await page.evaluate(()=>window.denyCamera=true);
    await app.getByRole('menuitem', {name: cameraName, exact: true}).click();
    await rows().nth(1).getByRole('status').filter({hasText:'Allow in Device Access'}).waitFor();
    await rows().nth(1).getByRole('button',{name:'Retry',exact:true}).click();
    await app.waitForFunction(() => window.mediaEffect?.sourceInputs?.[0]?.width === 640);
    await sourceChoice('Image A', 'Sample');
    assert(await page.evaluate(()=>capturedStreams.filter(stream=>stream.getVideoTracks().length).every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))));
    await app.getByRole('button', {name: 'Audio source', exact: true}).click();
    await app.getByRole('menuitem', {name: 'System default', exact: true}).click();
    await app.waitForFunction(() => window.mediaEvidence?.audio != null);
    assert(await app.evaluate(()=>analysisContexts.length>0&&analysisContexts.every(c=>c.sinkId?.type==='none')));
    await sourceChoice('Audio', 'Off');
    await app.waitForFunction(() => window.mediaEvidence?.audio == null);
    await sourceChoice('Audio', 'Channel 2');
    await rows().nth(0).getByRole('status').filter({hasText:'Waiting for data'}).waitFor();
    await page.evaluate(async base => {
      window.audioSender = new WebSocket(base + '/audio?channel=2');
      await new Promise(resolve => audioSender.onopen = resolve);
      const frames = 48000 * 3, bytes = new Uint8Array(44 + frames * 2), view = new DataView(bytes.buffer);
      const str = (offset, value) => [...value].forEach((char, i) => bytes[offset+i] = char.charCodeAt(0));
      str(0,'RIFF'); view.setUint32(4,bytes.length-8,true); str(8,'WAVE'); str(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,48000,true); view.setUint32(28,96000,true); view.setUint16(32,2,true); view.setUint16(34,16,true); str(36,'data'); view.setUint32(40,frames*2,true);
      for(let i=0;i<frames;i++)view.setInt16(44+i*2,Math.sin(i*2*Math.PI*440/48000)*16000,true);
      let binary=''; for(const byte of bytes)binary+=String.fromCharCode(byte);
      audioSender.send(JSON.stringify({base64_data:btoa(binary),duration:3000}));
    }, config.ioUrl);
    await app.waitForFunction(() => window.mediaEvidence?.rms > .1).catch(async error=>{console.error(await app.evaluate(()=>({e:window.mediaEvidence,status:document.querySelector('#mediaSources').innerText})));throw error;});
    assert(await app.evaluate(()=>analysisContexts.every(c=>c.sinkId?.type==='none')));
    await sourceChoice('Audio', 'Off');
    await app.waitForFunction(()=>analysisContexts.every(c=>c.state==='closed'));
    await sourceChoice('Image A', 'Channel 4');
    await app.waitForFunction(() => document.querySelector('#saveState').textContent === 'Draft saved');
    for (const height of [432,480]) {
      await page.setViewportSize({width:480,height});
      await app.getByRole('button', {name:'Image A source',exact:true}).click();
      await app.getByRole('menuitem',{name:'Channel 8',exact:true}).waitFor();
      await app.waitForFunction(()=>{const menu=document.querySelector('[role=menu]');return menu&&getComputedStyle(menu).opacity==='1';});
      assert(await app.getByRole('menu').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;}));
      await page.screenshot({path: path.join(evidence,'media-' + height + '.png')});
      assert(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await app.getByRole('menuitem',{name:'Channel 4',exact:true}).click();
    }
    await app.locator('#saveVisual').click();
    await app.waitForFunction(() => document.querySelector('#saveVisual').textContent === 'Update Visual' && document.querySelector('#saveState').textContent === 'Draft saved');
    const savedTitle = await app.locator('#candidateTitle').innerText();
    const beforeReopen = await app.evaluate(() => VrchApp.data.get(VrchSceneAppsStore.POINTER));
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Exit',exact:true}).click();
    await page.getByRole('button',{name:'Launch',exact:true}).click();
    await page.waitForSelector('#screen:not([hidden]) iframe');
    app=page.frames().find(frame=>frame.url().includes('/r/'));
    await app.locator('#chooseVisual:not([disabled])').waitFor();
    assert.equal(await app.getByRole('button',{name:'Image A source',exact:true}).textContent(),'Channel 4');
    assert.equal(await app.locator('#candidateTitle').innerText(),savedTitle);
    assert.deepEqual(await app.evaluate(()=>VrchApp.data.get(VrchSceneAppsStore.POINTER)),beforeReopen);
    await choose('Procedural Reveal','builtin:vrch.procedural-reveal');
    await app.getByRole('button',{name:'Image B source',exact:true}).waitFor();
    await sourceChoice('Image B','Channel 5');
    await app.locator('.shader-media-row').nth(2).getByRole('status').filter({hasText:'Waiting for data'}).waitFor();
    await sourceChoice('Image A','Sample');
    assert.equal(await app.getByRole('button',{name:'Image B source',exact:true}).textContent(),'Channel 5');
    await choose('Mosaic','builtin:vrch.mosaic');
    assert.equal(await app.getByRole('button',{name:'Image B source',exact:true}).isVisible(),false);
    assert.deepEqual(errors, []);
    console.log('PASS real Apps SDK/Agent/opaque content: camera, local input, image channel pixels, audio channel RMS, off/switch/disconnect/retry and persisted source selection. Hardware synthetic.');
  } finally {await browser.close(); driver.stdin.end(); await new Promise(resolve => driver.once('exit',resolve)); lines.close(); fs.rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1);});
