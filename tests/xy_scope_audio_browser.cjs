// XY Scope sound through the real Pages Player, Agent, SDK and PCM bridge, as on the device. OS audio devices are
// fixtures. The App frame may not choose a speaker (setSinkId is refused, as the device's policy refuses it): the App
// must keep its own AudioContext on no device and leave the output to the host.
//
//   VRCH_PAGES_ROOT=../vrch-web-viewer-pages node tests/xy_scope_audio_browser.cjs
const assert = require('node:assert/strict'), path = require('node:path'), {spawn} = require('node:child_process'), readline = require('node:readline');
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');
(async () => {
  const pages = process.env.VRCH_PAGES_ROOT || path.resolve(__dirname, '../../vrch-web-viewer-pages');
  const source = path.resolve(__dirname, '../apps/xy-scope/src');
  const driver = spawn('python3', [path.join(pages, 'tests/vrch_apps_player_browser_driver.py'), '--audio-only', '--app-source=' + source]);
  driver.stderr.on('data', d => process.stderr.write(d));
  const lines = readline.createInterface({input: driver.stdout});
  const config = await new Promise((resolve, reject) => { lines.once('line', l => resolve(JSON.parse(l))); driver.once('exit', code => reject(Error('Player driver exited: ' + code))); });
  const browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']});
  try {
    const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 480, height: 480}});
    await context.addInitScript(() => {
      if (window !== top) {
        // The App frame: note its audio contexts, refuse speaker selection, and fail on request.
        const Native = AudioContext;
        window.sinkSwitches = 0; window.contexts = []; window.failAudio = window.failAudio || null;   // {error, times}
        Native.prototype.setSinkId = async function () { sinkSwitches++; throw new DOMException('Permissions-Policy disallows speaker selection.', 'NotAllowedError'); };
        window.AudioContext = class extends Native {
          constructor(options) { if (failAudio && failAudio.times-- > 0) throw failAudio.error; super(options); contexts.push(this); }
        };
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
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(config.url);
    async function launch() {
      await page.getByRole('button', {name: 'Launch', exact: true}).click();
      const allow = page.getByRole('dialog').getByRole('button', {name: 'Launch', exact: true});
      if (await allow.count()) await allow.click();
      await page.waitForSelector('#screen:not([hidden]) iframe');
      let frame = null;
      for (let i = 0; i < 100 && !frame; i++) { frame = page.frames().find(f => f.url().includes('/r/')); if (!frame) await page.waitForTimeout(50); }
      await frame.waitForFunction(() => window.__xy && __xy.firstFrameAt !== null);
      const start = page.getByRole('dialog').getByRole('button', {name: 'Start', exact: true});
      await start.waitFor({timeout: 3000}).then(() => start.click(), () => {});
      await page.waitForTimeout(500);
      return frame;
    }
    // The loudest sample now leaving the host's playback node for the device.
    const heard = () => page.evaluate(() => Math.max(0, ...outputMeters.map(meter => { const pcm = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(pcm); return pcm.reduce((peak, v) => Math.max(peak, Math.abs(v)), 0); })));
    // K2. With the host's E/K bars on screen the App hides its own Hold button; its handler is the same one K2 calls.
    const hold = frame => frame.evaluate(() => document.getElementById('hold').click());
    const notice = frame => frame.evaluate(() => document.getElementById('notice').hidden ? '' : document.getElementById('notice').textContent);
    async function sounds(frame) {
      await frame.waitForFunction(() => __xy.state().holding && __xy.probe().source === 'audio', null, {timeout: 8000});
      await page.waitForFunction(() => outputMeters.some(meter => { const pcm = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(pcm); return pcm.some(v => Math.abs(v) > 0.05); }), null, {timeout: 8000});
    }
    async function silent(frame) {
      await frame.waitForFunction(() => !__xy.state().holding);
      await page.waitForTimeout(700);
      const level = await heard(); assert(level < 1e-3, 'hold off is silent at the host output: ' + level);
    }

    let frame = await launch();
    /* ---- opens with a picture; the engine waits ready and silent, on no device ---- */
    assert.equal((await frame.evaluate(() => __xy.probe())).source, 'analytic');
    assert.deepEqual(await frame.evaluate(() => [contexts.length, contexts[0]?.sinkId?.type, sinkSwitches]), [1, 'none', 0]);
    assert.equal(await heard(), 0, 'nothing sounds before the first key');

    /* ---- start, stop and start again: real PCM at the host output, the App's context on no device ---- */
    await hold(frame); await sounds(frame);
    assert.deepEqual(await frame.evaluate(() => [contexts.length, contexts[0].sinkId?.type, contexts[0].sampleRate, sinkSwitches]), [1, 'none', 48000, 0]);
    const level = await heard(); assert(level > 0.2 && level <= 0.5, 'the output stays under -6 dBFS: ' + level);
    await hold(frame); await silent(frame);
    await hold(frame); await sounds(frame);
    assert.equal(await frame.evaluate(() => contexts.length), 1, 'the same audio graph is used again');
    await hold(frame); await silent(frame);

    /* ---- leave and come back: a fresh App finds a usable output ---- */
    // failing: the App frame's next two attempts to open audio (its silent preparation, then the first key) fail so.
    async function reopen(failing) {
      if (failing) await context.addInitScript(error => { if (window !== top) window.failAudio = {times: 2, error: error.name ? new DOMException('Policy blocked', error.name) : Object.assign(new Error('refused'), error)}; }, failing);
      await page.keyboard.press('Escape');
      await page.getByRole('button', {name: 'Exit', exact: true}).click();
      await page.waitForSelector('#library:not([hidden])');
      return launch();
    }
    frame = await reopen();
    await hold(frame); await sounds(frame); await hold(frame); await silent(frame);

    /* ---- a browser refusal is not blamed on the Menu, and K2 tries again ---- */
    frame = await reopen({name: 'NotAllowedError'});
    await hold(frame);
    await frame.waitForFunction(() => !document.getElementById('notice').hidden);
    assert.equal(await notice(frame), 'Sound unavailable. Press K2 to retry.');
    assert.equal((await frame.evaluate(() => __xy.state())).holding, false);
    await hold(frame); await sounds(frame);
    assert.equal(await notice(frame), '', 'the notice goes once the sound is there');
    await hold(frame); await silent(frame);

    /* ---- a missing Menu permission says so ---- */
    frame = await reopen({code: 'io_not_authorized'});
    await hold(frame);
    await frame.waitForFunction(() => !document.getElementById('notice').hidden);
    assert.equal(await notice(frame), 'Allow audio in Menu, then press K2.');
    await hold(frame); await sounds(frame);
    assert.equal(await frame.evaluate(() => sinkSwitches), 0, 'the App never tries to choose a speaker');
    assert.deepEqual(errors, []);
    console.log('PASS XY Scope sound: silent start with the engine on no audio device, PCM at the real host output under -6 dBFS, stop and restart, exit and reopen, retry after a browser refusal, and the Menu message only for a missing Menu permission. Physical acoustic output is not simulated evidence.');
  } finally {
    await browser.close();
    const exited = new Promise(resolve => driver.once('exit', resolve));
    driver.stdin.end(); await exited; lines.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
