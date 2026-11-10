// Hit Shapes as a device runs it: the real Pages Player (My Apps in device mode), Agent, SDK, PCM bridge and the
// second-screen page, from the Pages checkout beside this repository (or VRCH_PAGES_ROOT). The OS audio devices and
// the second screen are fixtures, and Start is called in the App because this driver has no knobs or keys; the
// Playground test covers those. Physical sound and a real second screen still need a device.
//   node tests/hit_shapes_player_browser.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {chromium} = require(process.env.PLAYWRIGHT || path.join(path.dirname(process.execPath), '../lib/node_modules/playwright'));
const round = value => Math.round(value * 10) / 10;
(async () => {
  const pages = process.env.VRCH_PAGES_ROOT || path.resolve(__dirname, '../../vrch-web-viewer-pages');
  const source = path.resolve(__dirname, '../apps/hit-shapes/src');
  const driver = spawn('python3', [path.join(pages, 'tests/vrch_apps_player_browser_driver.py'), '--audio-only', '--output', '--app-source=' + source]);
  driver.stderr.on('data', data => process.stderr.write(data));
  const lines = readline.createInterface({input: driver.stdout});
  const config = await new Promise((resolve, reject) => {
    lines.once('line', line => resolve(JSON.parse(line)));
    driver.once('exit', code => reject(Error('Player driver exited: ' + code)));
  });
  const browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']});
  const result = {};
  try {
    const origin = new URL(config.url).origin;
    const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 480, height: 480}});
    await context.grantPermissions(['microphone'], {origin});
    await context.addInitScript(() => {
      if (window !== top) return;
      // The host's playback of App sound: the wall-clock moment each sound after a silence reaches the output device.
      const Native = AudioWorkletNode;
      window.onsets = []; window.taps = []; window.outputClock = null;
      window.AudioWorkletNode = class extends Native {
        constructor(ctx, name, options) {
          super(ctx, name, options);
          if (options?.processorOptions?.mode !== 'playback') return;
          const tap = ctx.createScriptProcessor(256, 1, 1), mute = ctx.createGain();
          let quiet = 1e9;
          taps.push(tap, mute);
          tap.onaudioprocess = event => {
            const pcm = event.inputBuffer.getChannelData(0);
            for (let i = 0; i < pcm.length; i++) {
              if (Math.abs(pcm[i]) < 0.004) { quiet++; continue; }
              if (quiet > ctx.sampleRate * 0.15) {
                const stamp = ctx.getOutputTimestamp();
                onsets.push(stamp.performanceTime + (event.playbackTime + i / ctx.sampleRate - stamp.contextTime) * 1000 + Date.now() - performance.now());
              }
              quiet = 0;
            }
            window.outputClock = {outputLatency: ctx.outputLatency, baseLatency: ctx.baseLatency};
          };
          mute.gain.value = 0; this.connect(tap); tap.connect(mute); mute.connect(ctx.destination);
        }
      };
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(config.url);
    async function launch() {
      await page.getByRole('button', {name: 'Launch', exact: true}).click();
      const allow = page.getByRole('dialog').getByRole('button', {name: 'Launch', exact: true});
      if (await allow.count()) await allow.click();
      await page.waitForSelector('#screen:not([hidden]) iframe');
      const frame = page.frames().find(f => f.url().includes('/r/'));
      await frame.waitForFunction(() => window.__hitShapes && ready);
      const start = page.getByRole('dialog').getByRole('button', {name: 'Start', exact: true});
      if (await start.count()) await start.click();
      await frame.waitForFunction(() => engine || document.getElementById('status').textContent);
      return frame;
    }
    let frame = await launch();
    const opened = await frame.evaluate(() => ({engine: !!engine, status: document.getElementById('status').textContent, sink: engine?.ctx.sinkId?.type, mode: VrchApp.context.mode, size: [innerWidth, innerHeight], first: __hitShapes.firstFrameAt, state: __hitShapes.state()}));
    assert.equal(opened.engine, true, JSON.stringify(opened)); assert.equal(opened.sink, 'none'); assert.equal(opened.status, '');
    assert.equal(opened.state.playing, false, 'it opens stopped'); assert(opened.first > 0 && opened.first < 1000, 'first picture within a second: ' + opened.first);
    result.device = {mode: opened.mode, screen: opened.size, firstFrameMs: round(opened.first)};

    // The second screen: the device's output page takes the picture-only copy.
    const second = await context.newPage();
    second.on('pageerror', error => errors.push('output: ' + error.message));
    await second.goto(origin + '/vrch_apps_output.html');
    await second.waitForSelector('#output iframe');
    const output = await (await second.locator('#output iframe').elementHandle()).contentFrame();
    await output.waitForFunction(() => window.__hitShapes?.role === 'output');
    assert.equal(await output.evaluate(() => document.body.innerText.trim()), '', 'the second screen shows no text');

    await frame.evaluate(() => togglePlay());
    for (const copy of [frame, output]) await copy.waitForFunction(() => __hitShapes.hits().filter(hit => hit.drawnAt).length >= 40, null, {timeout: 20000});
    result.sync = {};
    for (const [name, copy] of [['device', frame], ['secondScreen', output]]) {
      const gaps = (await copy.evaluate(() => __hitShapes.hits())).filter(hit => hit.drawnAt).map(hit => hit.drawnAt - hit.audioTime);
      assert(gaps.every(gap => Math.abs(gap) <= 33), name + ': every shape within 33 ms of its sound: ' + JSON.stringify(gaps.map(Math.round)));
      result.sync[name] = {hits: gaps.length, minMs: round(Math.min(...gaps)), maxMs: round(Math.max(...gaps))};
    }
    assert.equal((await output.evaluate(() => __hitShapes.state())).playing, true, 'the second screen follows Start');
    const rate = async copy => { const a = await copy.evaluate(() => [__hitShapes.frames, performance.now()]); await page.waitForTimeout(2000); const b = await copy.evaluate(() => [__hitShapes.frames, performance.now()]); return round((b[0] - a[0]) / (b[1] - a[1]) * 1000); };
    result.fps = {device: await rate(frame), secondScreen: await rate(output)};
    await frame.evaluate(() => togglePlay());

    // Latency of the device-mode audio path here: rim shots by hand, sound at the host output against the picture.
    await frame.evaluate(() => selectVoice(6)); await page.waitForTimeout(700);
    await page.evaluate(() => { onsets.length = 0; });
    for (let i = 0; i < 16; i++) { await frame.evaluate(() => hit()); await page.waitForTimeout(430 + i * 7); }
    const heard = await page.evaluate(() => ({onsets, clock: outputClock}));
    const planned = await frame.evaluate(() => ({at: __hitShapes.hits().filter(hit => hit.manual).slice(-16).map(hit => hit.audioTime + Date.now() - performance.now()), assumed: LATENCY_MS}));
    const late = planned.at.map(at => heard.onsets.find(onset => Math.abs(onset - at) < 200) - at).filter(Number.isFinite).sort((a, b) => a - b);
    assert(late.length >= 12, 'the rim shots reach the host output: ' + JSON.stringify([heard.onsets.length, planned.at.length]));
    result.latency = {assumedMs: planned.assumed, soundAfterPictureMs: {min: round(late[0]), median: round(late[late.length >> 1]), max: round(late.at(-1))}, measuredMs: round(planned.assumed + late[late.length >> 1]),
      hostOutputLatencyMs: round((heard.clock?.outputLatency || 0) * 1000), hostBaseLatencyMs: round((heard.clock?.baseLatency || 0) * 1000)};

    // Settings survive Exit and reopening, and it reopens stopped.
    await frame.evaluate(() => { setTempo(133); cycleSwing(); nextTheme(); });
    await page.waitForTimeout(900);
    const kept = await frame.evaluate(() => JSON.stringify(snapshot()));
    await page.keyboard.press('Escape');
    await page.getByRole('button', {name: 'Exit', exact: true}).click();
    await page.waitForSelector('#library:not([hidden])');
    frame = await launch();
    assert.equal(await frame.evaluate(() => JSON.stringify(snapshot())), kept, 'settings are kept');
    assert.equal((await frame.evaluate(() => __hitShapes.state())).playing, false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({pass: true, ...result}, null, 1));
  } finally {
    await browser.close();
    const exited = new Promise(resolve => driver.once('exit', resolve));
    driver.stdin.end(); await exited; lines.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
