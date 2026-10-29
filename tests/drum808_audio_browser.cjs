// Uses the real Pages Player, Agent, SDK and PCM bridge. OS audio devices are
// fixtures. Chrome <154 needs only the newer setSinkId policy rejection emulated.
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {chromium} = require('playwright');
(async () => {
  const pages = process.env.VRCH_PAGES_ROOT || path.resolve(__dirname, '../../vrch-web-viewer-pages');
  const source = process.env.APP_SOURCE || path.resolve(__dirname, '../apps/drum-808/src');
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
      await frame.waitForSelector('#play');
      const start = page.getByRole('dialog').getByRole('button', {name: 'Start', exact: true});
      if (await start.count()) await start.click();
      await frame.waitForFunction(() => engine || /audio/i.test(document.getElementById('status').textContent));
      return frame;
    }
    let frame = await launch();
    const initial = await frame.evaluate(() => ({engine: !!engine, switches: sinkSwitches, status: document.getElementById('status').textContent}));
    if (process.env.EXPECT_BASELINE_FAILURE) {
      assert.deepEqual(initial, {engine: false, switches: 1, status: 'Allow audio in Menu, then press Start.'});
      console.log('PASS baseline reproduces the misleading Menu error through the real SDK createNode.');
      return;
    }
    assert.equal(initial.engine, true, JSON.stringify(initial)); assert.equal(initial.switches, 0);
    assert.equal(await frame.evaluate(() => engine.ctx.sinkId.type), 'none');
    const retained = await frame.evaluate(() => JSON.stringify(snapshot()));
    async function play() {
      await frame.locator('#play').click();
      await frame.waitForFunction(() => ui.playing && engine && engine.ctx.state === 'running');
      await page.waitForFunction(() => outputMeters.some(meter => {
        const pcm = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(pcm);
        return pcm.some(v => Math.abs(v) > .005);
      }));
      assert.equal(await frame.locator('#status').textContent(), 'Playing');
      await frame.locator('#play').click();
      await frame.waitForFunction(() => !ui.playing);
    }
    await play();
    // Closing/reopening the actual SDK output must recreate a usable graph.
    await frame.evaluate(() => closeAudio());
    await play();
    await frame.evaluate(() => audioError(new DOMException('Policy blocked', 'NotAllowedError')));
    assert.equal(await frame.locator('#status').textContent(), 'Audio unavailable. Press Start to retry.');
    await frame.evaluate(() => audioError({code: 'io_not_authorized'}));
    assert.equal(await frame.locator('#status').textContent(), 'Allow audio in Menu, then press Start.');
    await play();
    assert.equal(await frame.evaluate(() => JSON.stringify(snapshot())), retained);
    await page.keyboard.press('Escape');
    await page.getByRole('button', {name: 'Exit', exact: true}).click();
    await page.waitForSelector('#library:not([hidden])');
    frame = await launch(); await play();
    assert.equal(await frame.evaluate(() => JSON.stringify(snapshot())), retained);
    assert.deepEqual(errors, []);
    console.log('PASS Drum 808 startup, PCM at real host output, stop/retry, error classification, exit/reopen and settings preservation. Physical acoustic output is not simulated evidence.');
  } finally {
    await browser.close();
    const exited = new Promise(resolve => driver.once('exit', resolve));
    driver.stdin.end(); await exited; lines.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
