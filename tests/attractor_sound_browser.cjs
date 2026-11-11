// Attractor's two uses of sound, in the real Playground: the formula played (K2 held), and the figure following the
// audio input (K4 held). Chrome's microphone is a file: bass bursts twice a second over a quiet tone. The host output
// is tapped with the SDK's own PCM processor, so "heard" means the samples the host hands to the audio device.
//   ATTRACTOR_GPU=1 node tests/attractor_sound_browser.cjs
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {open, OUT} = require('./attractor_playground.cjs');

// Forty seconds at 48 kHz: longer than a run, because Chrome skips where it loops the file.
function bursts() {
  const frames = 48000 * 40, data = Buffer.alloc(frames * 4), head = Buffer.alloc(44);
  for (let i = 0; i < frames; i++) {
    const beat = (i % 24000) / 48000, bass = beat < 0.12 ? 0.6 * Math.sin(Math.PI * beat / 0.12) * Math.sin(2 * Math.PI * 70 * i / 48000) : 0;
    const value = Math.round(32000 * (bass + 0.02 * Math.sin(2 * Math.PI * 1000 * i / 48000)));
    data.writeInt16LE(value, 4 * i); data.writeInt16LE(value, 4 * i + 2);
  }
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22);
  head.writeUInt32LE(48000, 24); head.writeUInt32LE(48000 * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'attractor-bass-')), 'bursts.wav');
  fs.writeFileSync(file, Buffer.concat([head, data])); return file;
}
const everyFrame = async (page, read) => { const all = []; for (const frame of page.frames()) all.push(...await frame.evaluate(read).catch(() => [])); return all; };
const status = app => app.evaluate(() => document.getElementById('status').hidden ? '' : document.getElementById('status').innerText);

(async () => {
  const result = {};
  let t = await open({args: ['--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + bursts()], permissions: ['microphone']});
  try {
    const {state, stats, stopped, heard} = t, v = await t.visit(''), app = await v.find('control');
    await stopped(app);
    assert.deepEqual(await everyFrame(v.page, () => window.__asked || []), [], 'nothing is asked for on opening');
    assert.deepEqual(await everyFrame(v.page, () => window.__sound || []), [], 'no sound is set up on opening');
    assert.equal((await heard(v.page, 5000)).left, 0, 'it opens silent');

    /* ---- K2 held: the formula is heard ---- */
    await v.key(1, 900);
    await app.waitForFunction(() => __attractor.state().sound, null, {timeout: 5000});
    await v.page.waitForTimeout(1500);
    result.sound = await heard(v.page, 800);
    assert(result.sound.blocks > 10 && result.sound.left > 0.01 && result.sound.left <= 0.3001 && result.sound.right > 0.01 && result.sound.right <= 0.3001, 'the formula sounds, under its level: ' + JSON.stringify(result.sound));
    assert(result.sound.apart > 0.005, 'left and right differ: ' + JSON.stringify(result.sound));
    assert.deepEqual(await everyFrame(v.page, () => window.__sound || []), [{sampleRate: 48000, sink: 'none'}], 'one 48 kHz context that leaves the speakers to the host');
    assert.equal(await status(app), 'sound on');
    assert.deepEqual(await everyFrame(v.page, () => window.__asked || []), [], 'sound asks for no input');
    await v.turn(0, 6, 100);
    assert((await heard(v.page, 300)).left > 0.01, 'it keeps sounding while a knob turns');
    await v.key(1); await v.page.waitForTimeout(1900);
    assert.equal((await state(app)).a, -2, 'a short press of K2 still changes the preset');
    // A flow is heard too.
    for (let i = 0; i < 6; i++) { await v.key(3); await v.page.waitForTimeout(250); }
    assert.equal((await state(app)).formula, 'lorenz');
    await v.page.waitForTimeout(1200);
    result.flow = await heard(v.page, 800);
    assert(result.flow.left > 0.005 && result.flow.right > 0.005 && result.flow.left <= 0.3001, 'Lorenz sounds: ' + JSON.stringify(result.flow));
    await v.key(1, 900);
    await app.waitForFunction(() => !__attractor.state().sound, null, {timeout: 5000});
    await v.page.waitForTimeout(900);
    result.after = await heard(v.page, 400);
    assert.equal(result.after.left + result.after.right, 0, 'held again it is silent: ' + JSON.stringify(result.after));
    assert.equal(await status(app), '');
    for (let i = 0; i < 3; i++) { await v.key(3); await v.page.waitForTimeout(250); }
    assert.equal((await state(app)).formula, 'dejong');

    /* ---- K4 held: the App's music plays and the figure moves with it (when this copy of the App carries music) ---- */
    await stopped(app);
    const base = await state(app);
    await v.key(3, 900);
    await app.waitForFunction(() => __attractor.state().listening || (__attractor.state().source === 'music' && document.getElementById('status').innerText === 'music'), null, {timeout: 20000});
    if ((await state(app)).source === 'music') {
      await v.page.waitForTimeout(2500);
      const swayed = [];
      for (let i = 0; i < 40; i++) { swayed.push(await state(app)); await v.page.waitForTimeout(75); }
      result.music = {heard: await heard(v.page, 800), sway: ['a', 'b', 'c', 'd'].map(k => Math.round(Math.max(...swayed.map(s => Math.abs(s[k] - base[k]))) * 1000) / 1000), mode: (await stats(app)).mode};
      assert(result.music.heard.left > 0.005 && result.music.heard.right > 0.005 && result.music.heard.left <= 1, 'the music is heard: ' + JSON.stringify(result.music));
      assert(Math.max(...result.music.sway) >= 0.02 && Math.max(...result.music.sway) <= 0.1201 && result.music.mode === 'live', 'the letters sway with the music, a little: ' + JSON.stringify(result.music));
      assert.deepEqual(await everyFrame(v.page, () => window.__asked || []), [], 'music asks for no input');
      await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-music.png')});
      // Held again: the audio input instead.
      await v.key(3, 900);
    } else result.music = 'this copy has no music';
    await app.waitForFunction(() => __attractor.state().listening, null, {timeout: 5000});
    const out = await v.output();
    const seen = [];
    for (let i = 0; i < 40; i++) { const pair = await Promise.all([state(app), state(out)]); seen.push(pair); await v.page.waitForTimeout(75); }
    const asked = await everyFrame(v.page, () => window.__asked || []);
    assert(asked.length === 1 && /audio/.test(asked[0]) && !/video":(true|\{)/.test(asked[0]), 'the input is asked for once, sound only: ' + JSON.stringify(asked));
    result.listening = {
      push: Math.max(...seen.map(s => s[0].a - base.a)), least: Math.min(...seen.map(s => s[0].a - base.a)),
      kick: Math.max(...seen.map(s => Math.max(Math.abs(s[0].b - base.b), Math.abs(s[0].c - base.c), Math.abs(s[0].d - base.d)))),
      outputPush: Math.max(...seen.map(s => s[1].a - base.a)), apart: Math.max(...seen.map(s => Math.abs(s[0].a - s[1].a))), mode: (await stats(app)).mode,
    };
    assert(result.listening.push >= 0.05 && result.listening.push <= 0.1201 && result.listening.least >= -0.1201, 'bass sways a, by 0.12 at most: ' + JSON.stringify(result.listening));
    assert(result.listening.kick >= 0.02 && result.listening.kick <= 0.13, 'a beat nudges b, c or d a little: ' + JSON.stringify(result.listening));
    assert(result.listening.outputPush >= 0.04 && result.listening.apart <= 0.12, 'the output follows: ' + JSON.stringify(result.listening));
    assert.equal(result.listening.mode, 'live');
    assert.equal(await status(app), 'listening');
    assert.equal((await heard(v.page, 400)).left, 0, 'what the input hears is never played back');
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-listening.png')});
    await v.key(3, 900);
    await app.waitForFunction(() => !__attractor.state().listening, null, {timeout: 5000});
    await v.page.waitForTimeout(700);
    assert.deepEqual(await state(app), base, 'held again the letters are back where they were');
    assert.deepEqual(await everyFrame(v.page, () => (window.__tracks || []).map(track => track.readyState)), ['ended'], 'the input is given back');
    await stopped(app);
    assert.deepEqual(t.errors, [], 'no page errors');
  } catch (error) { console.log(JSON.stringify(result, null, 1)); console.error('errors', t.errors); throw error; } finally { await t.close(); }

  /* ---- an input that is refused: said once, not asked again until K4 is held again ---- */
  t = await open({args: ['--use-fake-device-for-media-stream'], permissions: []});
  try {
    const v = await t.visit(''), app = await v.find('control');
    await v.key(3, 900);
    await v.page.waitForTimeout(1200);
    if ((await t.state(app)).source === 'music') await v.key(3, 900);
    await app.waitForFunction(() => /not allowed|No audio input/.test(document.getElementById('status').innerText), null, {timeout: 8000});
    result.refused = await status(app);
    assert.equal(result.refused, 'Audio input is not allowed.');
    assert.equal((await t.state(app)).listening, false);
    await v.page.waitForTimeout(1500);
    assert.equal((await everyFrame(v.page, () => window.__asked || [])).length, 1, 'a refusal is not asked again by itself');
    await v.turn(0, 3, 120);
    assert(Math.abs((await t.state(app)).a - 1.52) < 1e-9, 'the knobs work as before');
  } catch (error) { console.log(JSON.stringify(result, null, 1)); console.error('errors', t.errors); throw error; } finally { await t.close(); }
  console.log(JSON.stringify(result, null, 1));
  console.log('PASS Attractor sound in the Playground: silent and asking nothing until a key is held, the formula heard left and right under its level, a flow heard, silence again, the figure and the output following bass and beats, the input given back, and a refusal said once. The microphone is a file; how it sounds to a person is not checked here.');
})().catch(error => { console.error(error); process.exit(1); });
