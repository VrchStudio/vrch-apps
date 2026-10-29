// Uses the real Pages Player, Agent, SDK and PCM bridge. OS audio devices are
// fixtures. Chrome <154 needs only the newer setSinkId policy rejection emulated.
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {chromium} = require('playwright');
(async () => {
  const pages = process.env.VRCH_PAGES_ROOT || path.resolve(__dirname, '../../vrch-web-viewer-pages');
  const source = process.env.APP_SOURCE || path.resolve(__dirname, '../apps/flux-fx/src');
  const driver = spawn('python3', [path.join(pages, 'tests/vrch_apps_player_browser_driver.py'), '--audio-only', '--app-source=' + source]);
  driver.stderr.on('data', d => process.stderr.write(d));
  const lines = readline.createInterface({input: driver.stdout});
  const config = await new Promise((resolve, reject) => {
    lines.once('line', l => resolve(JSON.parse(l)));
    driver.once('exit', code => reject(Error('Player driver exited: ' + code)));
  });
  const browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']});
  try {
    const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 480, height: 480}});
    await context.grantPermissions(['microphone'], {origin: new URL(config.url).origin});
    await context.addInitScript(() => {
      window.sinkSwitches = 0;
      const NativeContext=AudioContext;window.appContexts=[];
      window.AudioContext=class extends NativeContext {constructor(...args){super(...args);appContexts.push(this);}};
      if (window !== top) AudioContext.prototype.setSinkId = async function () {
        sinkSwitches++;
        throw new DOMException('Permissions-Policy disallows speaker selection.', 'NotAllowedError');
      };
      if (window === top) {
        const Native = AudioWorkletNode;
        window.outputMeters = [];
        window.AudioWorkletNode = class extends Native {
          constructor(ctx, name, options) {
            super(ctx, name, options);
            if (options?.processorOptions?.mode === 'playback') {
              const meter = ctx.createAnalyser(); this.connect(meter); outputMeters.push(meter);
            }
          }
        };
      }
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(config.url);
    async function launch() {
      await page.getByRole('button', {name: 'Launch', exact: true}).click();
      const allow = page.getByRole('dialog').getByRole('button', {name: 'Launch', exact: true});
      if (await allow.count()) await allow.click();
      await page.waitForSelector('#screen:not([hidden]) iframe');
      const frame = page.frames().find(f => f.url().includes('/r/'));
      await frame.waitForSelector('#fx');
      const start = page.getByRole('dialog').getByRole('button', {name: 'Start', exact: true});
      if (await start.count()) await start.click();
      await frame.waitForFunction(() => window.FluxFX && ['live','error'].includes(FluxFX.state.phase));
      return frame;
    }
    let frame = await launch();
    if(process.env.EXPECT_BASELINE_FAILURE){assert.equal(await frame.evaluate(()=>FluxFX.state.phase),'error');assert.equal(await frame.evaluate(()=>FluxFX.diagnostics.lastError),'NotAllowedError');console.log('PASS original Flux FX reproduces SDK sink-switch refusal');return;}
    assert.equal(await frame.evaluate(()=>FluxFX.state.phase),'live');assert.equal(await frame.evaluate(()=>appContexts.at(-1).sinkId.type),'none');assert.equal(await frame.evaluate(()=>sinkSwitches),0);
    await frame.waitForFunction(()=>FluxFX.levels.inputPeak>.001&&FluxFX.levels.outputPeak>.001);
    await page.waitForFunction(()=>outputMeters.some(m=>{const a=new Float32Array(m.fftSize);m.getFloatTimeDomainData(a);return a.some(v=>Math.abs(v)>.001);}));
    const initial=await frame.evaluate(()=>FluxFX.state.enabled);
    await frame.locator('#fx').click();await frame.waitForFunction(initial=>FluxFX.state.enabled!==initial,initial);
    await frame.locator('#fx').click();await frame.waitForFunction(initial=>FluxFX.state.enabled===initial,initial);
    const box=await frame.locator('#pad-echo').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    try{await frame.waitForFunction(()=>FluxFX.state.manualPads.includes('echo'));}finally{await page.mouse.up();}
    await frame.waitForFunction(()=>FluxFX.state.manualPads.length===0);
    await frame.evaluate(()=>appContexts.at(-1).suspend());await frame.waitForFunction(()=>FluxFX.state.phase==='error');
    await frame.locator('#audio').click();await frame.waitForFunction(()=>FluxFX.state.phase==='live');await frame.waitForFunction(()=>FluxFX.levels.inputPeak>.001&&FluxFX.levels.outputPeak>.001);
    await frame.getByRole('slider',{name:'ENERGY',exact:true}).press('ArrowUp');
    const energy=await frame.evaluate(()=>FluxFX.state.energy);let saved;
    for(let i=0;i<50;i++){saved=await frame.evaluate(()=>VrchApp.data.get('dj-deck'));if(saved.value?.energy===energy)break;await page.waitForTimeout(100);}
    assert.equal(saved.value?.energy,energy);const retained=JSON.stringify(saved.value);
    await page.keyboard.press('Escape');await page.getByRole('button',{name:'Exit',exact:true}).click();await page.waitForSelector('#library:not([hidden])',{timeout:10000}).catch(async e=>{console.log(await page.locator('body').innerText());throw e;});
    frame=await launch();assert.equal(await frame.evaluate(()=>FluxFX.state.energy),energy);
    assert.equal(await frame.evaluate(async()=>JSON.stringify((await VrchApp.data.get('dj-deck')).value)),retained);
    await frame.waitForFunction(()=>FluxFX.levels.inputPeak>.001&&FluxFX.levels.outputPeak>.001);
    assert.deepEqual(errors,[]);console.log('PASS Flux FX real SDK input/output PCM, bypass, pad release, suspended-context retry and saved settings after reopening; microphone is a browser fixture.');
  }finally{await browser.close();const done=new Promise(r=>driver.once('exit',r));driver.stdin.end();await done;lines.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
