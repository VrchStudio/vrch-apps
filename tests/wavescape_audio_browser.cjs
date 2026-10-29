// Uses the real Pages Player, Agent, SDK and PCM bridge. OS audio devices are
// fixtures. Chrome <154 needs only the newer setSinkId policy rejection emulated.
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {chromium} = require('playwright');
(async () => {
  const pages = process.env.VRCH_PAGES_ROOT || path.resolve(__dirname, '../../vrch-web-viewer-pages');
  const source = process.env.APP_SOURCE || path.resolve(__dirname, '../apps/wavescape/src');
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
      await frame.waitForSelector('#start');
      const start = page.getByRole('dialog').getByRole('button', {name: 'Start', exact: true});
      if (await start.count()) await start.click();
      await frame.waitForFunction(() => document.getElementById('audioState').textContent === '' || /did not start/.test(document.getElementById('notice').textContent));
      return frame;
    }
    let frame = await launch();
    const initial = await frame.evaluate(() => ({live: document.getElementById('audioState').textContent === '', switches: sinkSwitches, notice: document.getElementById('notice').textContent}));
    if (process.env.EXPECT_BASELINE_FAILURE) {
      assert.equal(initial.live, false);assert(initial.switches > 0);assert.match(initial.notice,/Audio did not start/);
      console.log('PASS Wavescape baseline reproduces the SDK sink-switch refusal.');return;
    }
    assert.equal(initial.live, true, JSON.stringify(initial));assert.equal(initial.switches, 0);
    assert.equal(await frame.evaluate(() => appContexts.at(-1).sinkId.type), 'none');
    async function play() {
      await frame.locator('#start').click();
      await frame.waitForFunction(() => document.getElementById('start').classList.contains('lit') && document.getElementById('audioState').textContent === '');
      await page.waitForFunction(() => outputMeters.some(meter => {
        const pcm = new Float32Array(meter.fftSize);meter.getFloatTimeDomainData(pcm);
        return pcm.some(v => Math.abs(v) > .005);
      }));
      await frame.locator('#start').click();
      await frame.waitForFunction(() => !document.getElementById('start').classList.contains('lit'));
    }
    await play();
    await frame.evaluate(() => appContexts.at(-1).suspend());
    await frame.waitForFunction(() => document.getElementById('notice').textContent.includes('Audio paused'));
    await play();
    await frame.locator('#patch').click();
    let saved;
    for(let i=0;i<50;i++){saved=await frame.evaluate(()=>VrchApp.data.get('wavescape'));if(saved.value?.patchIndex===1)break;await page.waitForTimeout(100);}
    assert.equal(saved.value?.patchIndex,1,'Wait for the actual asynchronous save before Exit');
    const retained = JSON.stringify(saved.value);
    await page.keyboard.press('Escape');
    await page.getByRole('button', {name: 'Exit', exact: true}).click();
    await page.waitForSelector('#library:not([hidden])');
    frame = await launch();await play();
    assert.equal(await frame.evaluate(async () => JSON.stringify((await VrchApp.data.get('wavescape')).value)), retained);
    assert.match(await frame.locator('#patchName').textContent(), /^02 /);
    assert.equal(await frame.evaluate(() => sinkSwitches), 0);
    assert.deepEqual(errors, []);
    console.log('PASS Wavescape startup, real host PCM, start/stop, suspended-context retry and saved patch after exit/reopen. Physical acoustic output is not simulated evidence.');
  } finally {
    await browser.close();
    const exited = new Promise(resolve => driver.once('exit', resolve));
    driver.stdin.end(); await exited; lines.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
