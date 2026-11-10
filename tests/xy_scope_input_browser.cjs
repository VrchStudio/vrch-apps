// XY Scope input mode in the real Pages Playground: the pocket oscilloscope. Chrome's microphone is a WAV file
// (a fixture): left a sine, right the same sine a quarter turn later, so XY is a circle. The Playground hands the App
// this browser's microphone through the SDK, as the device hands it its audio input. See xy_scope_playground.cjs.
//
//   VRCH_PAGES_ROOT=../vrch-web-viewer-pages node tests/xy_scope_input_browser.cjs      (XY_SCOPE_GPU=1 for a real GPU)
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {open, OUT} = require('./xy_scope_playground.cjs');

// Forty seconds of tone at 48 kHz: longer than a run, because Chrome skips where it loops the file.
function tone(hz) {
  const frames = 48000 * 40, data = Buffer.alloc(frames * 4), head = Buffer.alloc(44);
  for (let i = 0; i < frames; i++) { const turn = 2 * Math.PI * hz * i / 48000; data.writeInt16LE(Math.round(16000 * Math.sin(turn)), 4 * i); data.writeInt16LE(Math.round(16000 * Math.cos(turn)), 4 * i + 2); }
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22);
  head.writeUInt32LE(48000, 24); head.writeUInt32LE(48000 * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xy-scope-tone-')), hz + '.wav');
  fs.writeFileSync(file, Buffer.concat([head, data])); return file;
}
const microphone = hz => ['--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + tone(hz)];
const HOLD_MS = 800;   // longer than the App's 600 ms for a long K4 press

async function session(options) {
  const playground = await open(options), v = await playground.visit(''), app = await v.find('control');
  await v.settled(); await v.page.waitForTimeout(1200);   // the Playground brings the device in with a motion: keys are pressed once it rests
  const asked = async () => { let total = 0; for (const frame of v.page.frames()) total += await frame.evaluate(() => (window.__asked || []).length).catch(() => 0); return total; };
  const tracks = () => v.page.evaluate(() => __tracks.map(track => track.readyState));
  // What probe() says over the next frames: every reading, one a frame.
  const watch = (frames, pick) => app.evaluate(([n, key]) => new Promise(resolve => { const seen = []; const tick = () => { seen.push(__xy.probe()[key]); if (seen.length < n) requestAnimationFrame(tick); else resolve(seen); }; requestAnimationFrame(tick); }), [frames, pick]);
  const toInput = async () => { await v.key(3, HOLD_MS); await app.waitForFunction(() => __xy.state().mode === 'input', null, {timeout: 5000}); };
  const toSynth = async () => { await v.key(3, HOLD_MS); await app.waitForFunction(() => __xy.state().mode === 'synth', null, {timeout: 5000}); };
  const showing = async name => { for (let i = 0; i < 12 && (await playground.state(app)).view !== name; i++) await v.turn(2, 2); assert.equal((await playground.state(app)).view, name); await v.page.waitForTimeout(700); };
  return {playground, v, app, asked, tracks, watch, toInput, toSynth, showing, shot: name => v.page.locator('#stageDevice').screenshot({path: path.join(OUT, name + '.png')})};
}

async function listens(hz, result) {
  const s = await session({args: microphone(hz), permissions: ['microphone']}), {playground, v, app} = s, {state, probe} = playground;
  try {
    /* ---- nothing asks for the microphone until input mode is chosen ---- */
    await v.key(1); await app.waitForFunction(() => __xy.probe().source === 'audio', null, {timeout: 8000}); await v.key(1); await v.page.waitForTimeout(400);
    assert.equal(await s.asked(), 0, 'no microphone request while the synth is used');

    await s.toInput();
    await app.waitForFunction(() => __xy.state().listening && __xy.probe().rmsL > 0.05, null, {timeout: 15000});
    assert.equal(await s.asked(), 1, 'the microphone is asked for once, on entering input mode');
    assert.equal((await state(app)).holding, false, 'the synth is silent while listening');
    await v.page.waitForTimeout(1500);
    const heard = await probe(app);
    assert(Math.abs(heard.fx / hz - 1) < 0.002 && Math.abs(heard.fy / hz - 1) < 0.002, 'both channels are heard at ' + hz + ' Hz: ' + JSON.stringify(heard));
    assert(Math.abs(heard.rmsL / heard.rmsR - 1) < 0.05, 'left and right arrive as two channels of the same level: ' + JSON.stringify(heard));
    assert.equal(heard.notice, '');

    /* ---- Wave: a steady tone stands still ---- */
    await s.showing('Wave');
    // wander: how far the sweep moved since the frame before, in figure units (the device screen is 144 px to one).
    const wander = (await s.watch(180, 'wander')).sort((a, b) => a - b);
    result.wave = {hz, wanderMedian: wander[90], wanderMax: wander[179]};
    assert(result.wave.wanderMax < 0.002, 'the triggered wave stands still: ' + JSON.stringify(result.wave));
    await s.shot('input-wave-' + hz);

    /* ---- the tuner names the note ---- */
    await app.waitForFunction(() => __xy.probe().tuner !== '', null, {timeout: 5000});
    const tuned = await probe(app), cents = Number(/([+-]?\d+) ct/.exec(tuned.tuner)?.[1]);
    result.tuner = {text: tuned.tuner, hz: tuned.tunerHz};
    if (hz === 440) { assert.match(tuned.tuner, /^A4 /); assert(Math.abs(cents) <= 3 && Math.abs(1200 * Math.log2(tuned.tunerHz / 440)) <= 3, 'A4 within 3 cents: ' + JSON.stringify(result.tuner)); }
    else assert(Math.abs(1200 * Math.log2(tuned.tunerHz / hz)) <= 3, 'the tuner reads ' + hz + ' Hz within 3 cents: ' + JSON.stringify(result.tuner));
    assert.equal(await app.evaluate(() => document.getElementById('tuner').textContent), tuned.tuner, 'the reading is on the device screen');

    /* ---- Spectrum: the peak is at the tone ---- */
    await s.showing('Spectrum');
    await app.waitForFunction(() => __xy.probe().peakHz > 0, null, {timeout: 5000});
    result.peakHz = (await probe(app)).peakHz;
    assert(Math.abs(result.peakHz - hz) <= 6, 'the spectrum peaks at ' + hz + ' Hz (one bin is 5.9 Hz): ' + result.peakHz);
    await s.shot('input-spectrum-' + hz);

    /* ---- XY: left across, right up ---- */
    await s.showing('XY');
    // The input arrives a block at a time, so some frames have nothing new to draw.
    result.xy = {samplesAFrame: Math.max(...await s.watch(30, 'samples'))};
    assert(result.xy.samplesAFrame > 0, 'XY draws the incoming samples');
    await s.shot('input-xy-' + hz);

    /* ---- Freeze holds the picture, and lets go ---- */
    await s.showing('Wave');
    await v.key(1); await app.waitForFunction(() => __xy.state().frozen);
    const still = [await app.evaluate(() => __xy.probe().fx), await v.page.waitForTimeout(600), await app.evaluate(() => __xy.probe().fx)];
    assert.equal(still[0], still[2], 'nothing new is taken in while frozen');
    await v.key(1); await app.waitForFunction(() => !__xy.state().frozen);

    /* ---- the output shows the same picture and no text ---- */
    await v.page.keyboard.press('Shift');
    await v.page.waitForFunction(() => document.body.dataset.output === 'panel', null, {timeout: 30000}); await v.settled();
    const picture = await v.find('output');
    await picture.waitForFunction(() => __xy.probe().samples > 0, null, {timeout: 10000}); await v.page.waitForTimeout(600);
    assert.equal(await picture.evaluate(() => document.body.innerText.trim()), '', 'the output carries no text');
    await v.page.locator('#outputScreen').screenshot({path: path.join(OUT, 'input-output-' + hz + '.png')});

    /* ---- leaving input mode lets the microphone go, and the synth plays as before ---- */
    await s.toSynth();
    await v.page.waitForFunction(() => __tracks.length > 0 && __tracks.every(track => track.readyState === 'ended'), null, {timeout: 5000})
      .catch(async () => { throw new Error('the microphone is released on leaving input mode: ' + JSON.stringify(await s.tracks())); });
    await v.page.evaluate(() => __host.reset());
    await v.key(1); await app.waitForFunction(() => __xy.probe().source === 'audio', null, {timeout: 8000}); await v.page.waitForTimeout(500);
    assert((await v.page.evaluate(() => __host.peak)) > 0.1, 'the synth sounds again');
    assert.equal(await s.asked(), 1, 'the microphone was not asked for again');
    assert.deepEqual(playground.errors, []);
  } finally { await playground.close(); }
}

async function refused(result) {
  const s = await session({args: ['--use-fake-device-for-media-stream'], permissions: []}), {playground, v, app} = s, {state, probe} = playground;
  try {
    await s.toInput();
    await app.waitForFunction(() => __xy.probe().notice !== '', null, {timeout: 15000});
    result.refused = {notice: (await probe(app)).notice, asked: await s.asked()};
    assert.equal(result.refused.notice, 'Audio input is not allowed. Hold K4 for synth.');
    await v.page.waitForTimeout(3000);
    assert.equal(await s.asked(), result.refused.asked, 'a refusal is not asked again');
    assert.deepEqual(v.prompts, [], 'no dialog is raised');
    assert.equal((await state(app)).listening, false);
    await s.shot('input-refused');
    await s.toSynth();
    assert.equal((await probe(app)).source === 'input', false);
    assert.equal(await app.evaluate(() => document.getElementById('notice').hidden), true, 'the notice goes with input mode');
    await v.key(1); await app.waitForFunction(() => __xy.probe().source === 'audio', null, {timeout: 8000}); await v.page.waitForTimeout(500);
    assert((await v.page.evaluate(() => __host.peak)) > 0.1, 'the synth still plays after a refusal');
    assert.deepEqual(playground.errors, []);
  } finally { await playground.close(); }
}

(async () => {
  const result = {};
  for (const hz of [1000, 440]) await listens(hz, result[hz] = {});
  await refused(result);
  console.log(JSON.stringify(result, null, 1));
  console.log('PASS XY Scope input mode in the Playground: no request before input mode, steady wave, spectrum peak, tuner, XY, freeze, text-free output, release on leaving, and a refusal that is told once. Screenshots in ' + OUT + '. The microphone is a file; the device input is not simulated evidence.');
})().catch(error => { console.error(error); process.exitCode = 1; });
