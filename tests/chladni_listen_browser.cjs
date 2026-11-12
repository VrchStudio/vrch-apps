// Chladni listening and two modes at once, in the real Playground. Chrome's microphone is a file: one long note, a
// second one, a slide down, and a third. The host output is tapped with the SDK's own PCM processor, so "heard"
// means the samples the host hands to the audio device.
//   CHLADNI_GPU=1 node tests/chladni_listen_browser.cjs
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {open, OUT, LIVE} = require('./chladni_playground.cjs');

// What the microphone hears, 48 kHz for 60 seconds: A3 (220 Hz) for 7 s, E4 (329.63 Hz) for 6 s, a slide down an
// octave over 4 s, then E3 (164.81 Hz). Each note has a few overtones, as a voice has.
const SONG = [[7, 220, 220], [6, 329.63, 329.63], [4, 329.63, 164.81], [43, 164.81, 164.81]];
function song() {
  const rate = 48000, frames = rate * SONG.reduce((sum, part) => sum + part[0], 0), data = Buffer.alloc(frames * 4), head = Buffer.alloc(44);
  let phase = 0, at = 0;
  for (const [seconds, from, to] of SONG) {
    for (let i = 0; i < seconds * rate; i++, at++) {
      const hertz = from * (to / from) ** (i / (seconds * rate));
      phase += 2 * Math.PI * hertz / rate;
      const value = Math.round(9000 * (Math.sin(phase) + 0.4 * Math.sin(2 * phase) + 0.2 * Math.sin(3 * phase)));
      data.writeInt16LE(value, 4 * at); data.writeInt16LE(value, 4 * at + 2);
    }
  }
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chladni-song-')), 'song.wav');
  fs.writeFileSync(file, Buffer.concat([head, data])); return file;
}
const everyFrame = async (page, read) => { const all = []; for (const frame of page.frames()) all.push(...await frame.evaluate(read).catch(() => [])); return all; };
const notice = app => app.evaluate(() => document.getElementById('notice').hidden ? '' : document.getElementById('notice').innerText);
// How far apart two pitches are, in semitones.
const apart = (a, b) => Math.abs(12 * Math.log2(a / b));

(async () => {
  const result = {};
  let t = await open({args: ['--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + song()], permissions: ['microphone']});
  try {
    const {state, stats, heard} = t, v = await t.visit('&s=v1.3.5.60.0.0'), app = await v.find('control'), out = await v.output();

    /* ---- two modes at once: E1 keeps the mode, the knobs find a second, figures and notes are laid over each other ---- */
    await v.page.waitForTimeout(2500);
    const single = [await state(app), await stats(app), await t.grid(app)];
    assert.deepEqual([single[0].kept, single[1].second], [null, 0]);
    await v.press(0);
    assert.deepEqual([(await state(app)).kept, (await state(app)).n, (await state(app)).m], [[3, 5], 3, 5], 'E1 pressed keeps the mode');
    await v.turn(1, -1, 150); await v.turn(0, -2, 150);
    const both = [await state(app), await stats(app)];
    assert.deepEqual([both[0].kept, both[0].n, both[0].m, (await state(out)).kept], [[3, 5], 1, 4, [3, 5]], 'the knobs find a second mode; the first stays, on the output too');
    assert(Math.abs(both[1].second - single[1].hertz) < 0.01 && both[1].hertz < both[1].second, 'two pitches: ' + JSON.stringify(both[1]));
    await v.page.waitForTimeout(3500);
    const pair = [await stats(app), await t.grid(app), await t.grid(out)];
    result.two = {amplitudeOne: single[1].amplitude, amplitudeTwo: pair[0].amplitude, likeTheFirst: Math.round(t.alike(single[2], pair[1]) * 1000) / 1000};
    assert(pair[0].amplitude < 0.12, 'the sand gathers on the lines of the two together: ' + JSON.stringify(result.two));
    assert(result.two.likeTheFirst < 0.5, 'a figure neither mode has alone: ' + JSON.stringify(result.two));
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-two-modes.png')});
    fs.writeFileSync(path.join(OUT, 'two-modes.png'), Buffer.from((await t.bytes(out)).split(',')[1], 'base64'));
    // Heard: two notes, still under the ceiling, coming and going without a click.
    await v.key(1);
    await app.waitForFunction(() => __chladni.stats().audible, null, {timeout: 15000});
    await v.page.waitForTimeout(1500);
    result.two.heard = await heard(v.page, 1200);
    assert(result.two.heard.left > 0.02 && Math.max(result.two.heard.left, result.two.heard.right) <= 0.5005 && result.two.heard.step < 0.05, 'two notes under the ceiling: ' + JSON.stringify(result.two.heard));
    const link = new URL(v.page.url()).searchParams.get('s');
    assert.equal(link, 'v2.1.4.60.0.0.3.5', 'the link carries both modes');
    await v.press(0);
    await v.page.waitForTimeout(700);
    assert.deepEqual([(await state(app)).kept, (await stats(app)).second, (await state(out)).kept], [null, 0, null], 'E1 pressed again lets it go');
    assert((await heard(v.page, 650)).step < 0.05, 'letting go makes no click');
    assert.deepEqual(await everyFrame(v.page, () => window.__asked || []), [], 'none of this asks for an input');

    /* ---- K2 again: Listen. The App falls silent, opens the input, and the plate follows the note it hears ---- */
    await v.key(1);
    assert.deepEqual([(await state(app)).sound, (await state(app)).listen], [false, true]);
    await app.waitForFunction(() => __chladni.stats().listening, null, {timeout: 15000});
    const asked = await everyFrame(v.page, () => window.__asked || []);
    assert.equal(asked.length, 1, 'the input is asked for once: ' + JSON.stringify(asked));
    assert(/"audio"/.test(asked[0]) && !/"video":(true|\{)/.test(asked[0]), 'audio only: ' + asked[0]);
    result.heard = [];
    for (const [name, hertz] of [['A3', 220], ['E4', 329.63], ['E3', 164.81]]) {
      await app.waitForFunction(note => __chladni.state().heard === note, name, {timeout: 20000});
      await v.page.waitForTimeout(700);
      const now = [await state(app), await stats(app), await state(out)];
      result.heard.push({note: name, n: now[0].n, m: now[0].m, hertz: now[1].hertz});
      assert(apart(now[1].hertz, hertz) < 1, name + ': the plate takes the mode nearest in pitch: ' + JSON.stringify(now[1]));
      assert.deepEqual([now[2].n, now[2].m], [now[0].n, now[0].m], name + ': on the output too');
    }
    // One long note: the figure stands.
    const held = await state(app);
    await v.page.waitForTimeout(2500);
    assert.deepEqual([(await state(app)).n, (await state(app)).m, (await state(app)).heard], [held.n, held.m, 'E3'], 'a long note holds the figure');
    assert((await stats(app)).amplitude < 0.12, 'and the sand has gathered on it');
    const quiet = await heard(v.page, 2000);
    assert(quiet.left < 0.002 && quiet.right < 0.002, 'while it listens the App makes no sound, and plays nothing back: ' + JSON.stringify(quiet));
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-listening.png')});
    // The slide: on the way from E4 down to E3 the plate went through other figures.
    result.modes = result.heard.map(h => h.n + ' ' + h.m);
    assert.equal(new Set(result.modes).size, 3, 'three notes, three figures: ' + result.modes);

    /* ---- K2 once more: off, and the input is given back ---- */
    await v.key(1);
    await v.page.waitForTimeout(600);
    assert.deepEqual([(await state(app)).listen, (await state(app)).sound, (await stats(app)).listening], [false, false, false]);
    assert.deepEqual(await everyFrame(v.page, () => (window.__tracks || []).map(track => track.readyState)), ['ended'], 'the input is given back');
    const stays = await state(app);
    await v.page.waitForTimeout(1200);
    assert.deepEqual([(await state(app)).n, (await state(app)).m], [stays.n, stays.m], 'and the figure stays');

    /* ---- passing Listen on the way to off asks for nothing ---- */
    await v.key(1); await v.key(1); await v.key(1);
    await v.page.waitForTimeout(1500);
    assert.deepEqual([(await state(app)).listen, (await state(app)).sound], [false, false]);
    assert.equal((await everyFrame(v.page, () => window.__asked || [])).length, 1, 'K2 pressed straight through Listen opens no input');
    assert.deepEqual(t.errors, [], 'no page errors');
    await v.context.close();
  } finally { await t.close(); }

  /* ---- an input that is refused: said once, and K2 is back at off ---- */
  t = await open({args: ['--use-fake-device-for-media-stream'], permissions: []});
  try {
    const v = await t.visit(''), app = await v.find('control');
    await v.key(1); await v.key(1);
    await app.waitForFunction(() => !__chladni.state().listen, null, {timeout: 15000});
    result.refused = await notice(app);
    assert.equal(result.refused, 'Audio input is not allowed.');
    assert.deepEqual([(await t.state(app)).sound, (await t.state(app)).listen], [false, false]);
    await v.page.waitForTimeout(2500);
    assert.equal((await everyFrame(v.page, () => window.__asked || [])).length, 1, 'a refusal is not asked again by itself');
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
  console.log(JSON.stringify(result, null, 1));
  console.log('PASS Chladni listening in the Playground' + (LIVE ? ' at ' + LIVE : '') + ': two modes kept and let go with two notes under the ceiling, the plate following three sung notes while the App stays silent, the input asked for once and given back, nothing asked when K2 passes Listen, and a refusal said once. The microphone is a file; how it sounds to a person is not checked here.');
})().catch(error => { console.error(error); process.exit(1); });
