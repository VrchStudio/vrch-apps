// Uses the real Pages Player, Agent, SDK and PCM bridge. OS audio devices are fixtures; speaker selection is refused as on
// the device Chromium. Magic Circle starts its sound with the App, with no E1 press before the host hears it; E1 still
// turns it off and on. Under the normal autoplay policy it asks for one tap on the screen instead of hanging.
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {chromium} = require('playwright');
const pages = process.env.VRCH_PAGES_ROOT || path.resolve(__dirname, '../../vrch-web-viewer-pages');
const source = process.env.APP_SOURCE || path.resolve(__dirname, '../apps/magic-circle/src');
// Each session gets its own Player, so it starts from the library with no App left running.
async function session(autoplay, check) {
  const driver = spawn('python3', [path.join(pages, 'tests/vrch_apps_player_browser_driver.py'), '--audio-only', '--app-source=' + source]);
  driver.stderr.on('data', d => process.stderr.write(d));
  const lines = readline.createInterface({input: driver.stdout});
  try {
    const config = await new Promise((resolve, reject) => {
      lines.once('line', l => resolve(JSON.parse(l)));
      driver.once('exit', code => reject(Error('Player driver exited: ' + code)));
    });
    await run(config, autoplay, check);
  } finally {
    const exited = new Promise(resolve => driver.once('exit', resolve));
    driver.stdin.end(); await exited; lines.close();
  }
}
async function run(config, autoplay, check) {
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...(autoplay ? ['--autoplay-policy=no-user-gesture-required'] : [])];
  const browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', args});
  try {
    const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 480, height: 480}});
    await context.grantPermissions(['microphone'], {origin: new URL(config.url).origin});
    await context.addInitScript(() => {
      window.sinkSwitches = 0;
      if (window !== top) {
        AudioContext.prototype.setSinkId = async function () { sinkSwitches++; throw new DOMException('Permissions-Policy disallows speaker selection.', 'NotAllowedError'); };
        return;
      }
      const Native = AudioWorkletNode;
      window.outputMeters = [];
      window.AudioWorkletNode = class extends Native {
        constructor(ctx, name, options) {
          super(ctx, name, options);
          if (options?.processorOptions?.mode === 'playback') { const meter = ctx.createAnalyser(); this.connect(meter); outputMeters.push(meter); }
        }
      };
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(config.url);
    await page.getByRole('button', {name: 'Launch', exact: true}).click();
    const allow = page.getByRole('dialog').getByRole('button', {name: 'Launch', exact: true});
    if (await allow.count()) await allow.click();
    await page.waitForSelector('#screen:not([hidden]) iframe');
    const frame = page.frames().find(f => f.url().includes('/r/'));
    const start = page.getByRole('dialog').getByRole('button', {name: 'Start', exact: true});
    if (await start.count()) await start.click();
    const heard = () => page.waitForFunction(() => outputMeters.some(meter => {
      const pcm = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(pcm); return pcm.some(v => Math.abs(v) > .002);
    }), null, {timeout: 15000});
    const control = async key => { for (const type of ['down', 'up']) await frame.evaluate(({key, type}) => { const b = __vrchAppBootstrap; b.port.dispatchEvent(new MessageEvent('message', {data: {type: 'sdk_event', event: 'controls', generation: b.binding.generation, data: {control: key, type}}})); }, {key, type}); };
    await check({page, frame, heard, control});
    assert.equal(await frame.evaluate(() => sinkSwitches), 0, 'the App never asks to choose a speaker');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}
(async () => {
  {
    // Device Chromium allows audio without a gesture: no control has been touched and the host already hears the App.
    await session(true, async ({frame, heard, control}) => {
      await frame.waitForFunction(() => magic.sound === 'active', null, {timeout: 15000});
      await heard();
      await control('E1'); await frame.waitForFunction(() => magic.sound === 'off');
      await control('E1'); await frame.waitForFunction(() => magic.sound === 'active');
      await control('K4'); await heard();
      assert.equal(await frame.evaluate(() => document.getElementById('soundStatus').textContent), '');
    });
    // A browser that holds audio until the App is touched: the start gives up and asks for a tap, and one tap starts it.
    await session(false, async ({page, frame, heard}) => {
      await frame.waitForFunction(() => magic.sound === 'error', null, {timeout: 15000});
      assert.equal(await frame.evaluate(() => document.getElementById('soundStatus').textContent), 'Tap the screen to start sound.');
      const box = await page.locator('#screen iframe').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await frame.waitForFunction(() => magic.sound === 'active', null, {timeout: 15000});
      await heard();
    });
    console.log('PASS Magic Circle starts sound on open without E1 and reaches the real host PCM; E1 turns it off and on; a gesture-held browser gets one screen tap instead of a hang. Physical acoustic output is not simulated evidence.');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
