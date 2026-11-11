// Attractor's sound in the real Playground: its own music, the speaker, the Player panel, and the figure following
// the audio input. Chrome's microphone is a file: bass bursts twice a second over a quiet tone. The host output is
// tapped with the SDK's own PCM processor, so "heard" means the samples the host hands to the audio device.
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
const speaker = app => app.evaluate(() => { const b = document.getElementById('speaker'); return {on: b.dataset.on, label: b.getAttribute('aria-label')}; });
// The Player panel as it stands: every choice in order, which are chosen, and where the knob's cursor is.
const panel = app => app.evaluate(() => [...document.querySelectorAll('#playerBody button')].map(b => b.textContent + (b.classList.contains('is-active') ? '*' : '') + (b.classList.contains('is-cursor') ? '<' : '')));
const sway = async (page, state, app, count = 30) => { const seen = []; for (let i = 0; i < count; i++) { seen.push(await state(app)); await page.waitForTimeout(75); } return seen; };
const spread = (seen, key) => Math.round((Math.max(...seen.map(s => s[key])) - Math.min(...seen.map(s => s[key]))) * 1000) / 1000;

(async () => {
  const result = {};
  let t = await open({args: ['--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + bursts()], permissions: ['microphone']});
  try {
    const {state, stats, stopped, heard} = t, v = await t.visit(''), app = await v.find('control');

    /* ---- it opens with its music: heard, followed by the figure, with nothing asked for ---- */
    await app.waitForFunction(() => __attractor.state().audible, null, {timeout: 15000});
    await v.page.waitForTimeout(2500);
    let seen = await sway(v.page, state, app);
    result.music = {heard: await heard(v.page, 800), sway: ['a', 'b', 'c', 'd'].map(k => spread(seen, k)), mode: (await stats(app)).mode};
    assert(result.music.heard.left > 0.005 && result.music.heard.right > 0.005 && result.music.heard.left <= 1, 'the music is heard: ' + JSON.stringify(result.music));
    assert(Math.max(...result.music.sway) >= 0.02 && result.music.mode === 'live', 'the letters move with the music: ' + JSON.stringify(result.music));
    assert.deepEqual([(await state(app)).source, (await state(app)).track, await status(app)], ['music', 'Strange Loop', 'Strange Loop']);
    assert.deepEqual(await speaker(app), {on: 'true', label: 'Mute'});
    assert.deepEqual(await everyFrame(v.page, () => window.__asked || []), [], 'music asks for no input');
    assert.deepEqual(await everyFrame(v.page, () => window.__sound || []), [{sampleRate: 48000, sink: 'none'}], 'one 48 kHz context that leaves the speakers to the host');
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-music.png')});

    /* ---- the speaker: muted, the music plays on unheard and the figure keeps time; tapped again it is back ---- */
    await v.click(app, '#speaker');
    await v.page.waitForTimeout(1200);
    seen = await sway(v.page, state, app);
    result.muted = {heard: await heard(v.page, 400), sway: Math.max(...['a', 'b', 'c', 'd'].map(k => spread(seen, k)))};
    assert(result.muted.heard.left < 0.002 && result.muted.heard.right < 0.002, 'muted, nothing is heard: ' + JSON.stringify(result.muted));
    assert(result.muted.sway >= 0.02 && (await state(app)).muted && (await state(app)).source === 'music', 'and the figure still follows the music: ' + JSON.stringify(result.muted));
    assert.deepEqual([await speaker(app), await status(app)], [{on: 'false', label: 'Unmute'}, '']);
    await v.click(app, '#speaker');
    await v.page.waitForTimeout(1200);
    assert((await heard(v.page, 400)).left > 0.005 && !(await state(app)).muted, 'tapped again the music is back');

    /* ---- Player: K4 opens it, E1 moves through the choices, a press of E1 takes one ---- */
    await v.key(3);
    assert.equal((await state(app)).panel, 'player');
    assert.deepEqual(await panel(app), ['Music*<', 'Mic / Line in', 'Silent', 'Strange Loop*', 'Sacred Orbit', 'Auto*', 'Hold', 'Still']);
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-player.png')});
    // The second piece.
    await v.turn(0, 4, 150);
    assert.deepEqual(await panel(app), ['Music*', 'Mic / Line in', 'Silent', 'Strange Loop*', 'Sacred Orbit<', 'Auto*', 'Hold', 'Still']);
    await v.press(0);
    await app.waitForFunction(() => __attractor.state().track === 'Sacred Orbit' && __attractor.state().audible, null, {timeout: 15000});
    await v.page.waitForTimeout(2500);
    result.second = await heard(v.page, 800);
    assert(result.second.left > 0.005 && result.second.right > 0.005 && result.second.left <= 1, 'the second piece is heard: ' + JSON.stringify(result.second));
    assert.equal(await status(app), 'Sacred Orbit');
    // Hold: the figure goes on performing, on this figure.
    await v.turn(0, 2, 150); await v.press(0);
    assert.deepEqual([(await state(app)).show, (await panel(app)).slice(5)], ['hold', ['Auto', 'Hold*<', 'Still']]);
    // The audio input.
    await v.turn(0, -5, 150); await v.press(0);
    await app.waitForFunction(() => __attractor.state().listening, null, {timeout: 8000});
    // (With the audio input there is no piece to choose.)
    assert.deepEqual(await panel(app), ['Music', 'Mic / Line in*<', 'Silent', 'Auto', 'Hold*', 'Still']);
    await v.key(3);
    assert.equal((await state(app)).panel, null, 'K4 closes it');
    await v.page.waitForTimeout(1200);
    const base = {...(await state(app))}, out = await v.output(), both = [];
    for (let i = 0; i < 40; i++) { both.push(await Promise.all([state(app), state(out)])); await v.page.waitForTimeout(75); }
    const asked = await everyFrame(v.page, () => window.__asked || []);
    assert(asked.length === 1 && /audio/.test(asked[0]) && !/video":(true|\{)/.test(asked[0]), 'the input is asked for once, sound only: ' + JSON.stringify(asked));
    const a = both.map(s => s[0].a);
    result.listening = {swing: Math.round((Math.max(...a) - Math.min(...a)) * 1000) / 1000, kick: Math.max(...['b', 'c', 'd'].map(k => spread(both.map(s => s[0]), k))),
      apart: Math.max(...both.map(s => Math.abs(s[0].a - s[1].a))), mode: (await stats(app)).mode};
    assert(result.listening.swing >= 0.05 && result.listening.swing <= 0.3, 'bass sways a, by 0.12 either way at most (and it drifts a little): ' + JSON.stringify(result.listening));
    assert(result.listening.kick >= 0.02 && result.listening.kick <= 0.3, 'a beat nudges b, c or d a little: ' + JSON.stringify(result.listening));
    assert(result.listening.apart <= 0.12 && result.listening.mode === 'live', 'the output follows: ' + JSON.stringify(result.listening));
    assert.equal(await status(app), 'listening');
    assert.deepEqual(await speaker(app), {on: 'false', label: 'Play music'});
    assert.equal((await heard(v.page, 400)).left, 0, 'what the input hears is never played back');
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-listening.png')});

    /* ---- Silent: the input is given back. Still: the figure rests and sharpens ---- */
    await v.key(3); await v.turn(0, 1, 150); await v.press(0);
    await app.waitForFunction(() => __attractor.state().source === 'silent', null, {timeout: 5000});
    assert.deepEqual(await everyFrame(v.page, () => (window.__tracks || []).map(track => track.readyState)), ['ended'], 'the input is given back');
    await v.turn(0, -1, 150); await v.turn(0, -2, 150);
    assert.deepEqual(await panel(app), ['Music', 'Mic / Line in', 'Silent*', 'Strange Loop', 'Sacred Orbit', 'Auto', 'Hold*', 'Still<'], 'the knob goes round the end of the list');
    await v.press(0); await v.key(3);
    await stopped(app);
    assert.deepEqual([(await stats(app)).stopped, await status(app), (await state(app)).show], [true, '', 'still']);
    // The speaker brings the music back.
    await v.click(app, '#speaker');
    await app.waitForFunction(() => __attractor.state().audible, null, {timeout: 15000});
    assert.deepEqual([(await state(app)).source, (await speaker(app)).label], ['music', 'Mute']);
    assert.deepEqual(t.errors, [], 'no page errors');
  } catch (error) { console.log(JSON.stringify(result, null, 1)); console.error('errors', t.errors); throw error; } finally { await t.close(); }

  /* ---- an input that is refused: said once, not asked again until it is chosen again ---- */
  t = await open({args: ['--use-fake-device-for-media-stream'], permissions: []});
  try {
    // (Opened from a link, so the letters stand still.)
    const v = await t.visit('&s=v2.dejong.149.-228.236.-213.0.0.0'), app = await v.find('control');
    await v.key(3); await v.turn(0, 1, 150); await v.press(0);
    await app.waitForFunction(() => /not allowed|No audio input/.test(document.getElementById('status').innerText), null, {timeout: 8000});
    result.refused = await status(app);
    assert.equal(result.refused, 'Audio input is not allowed.');
    assert.deepEqual([(await t.state(app)).listening, (await t.state(app)).source, (await t.state(app)).a], [false, 'silent', 1.49], 'and with Player open E1 moved the choice, not the letter');
    await v.page.waitForTimeout(1500);
    assert.equal((await everyFrame(v.page, () => window.__asked || [])).length, 1, 'a refusal is not asked again by itself');
    await v.key(3);
    await v.key(1); await v.page.waitForTimeout(1800);
    assert.equal((await t.state(app)).a, -2, 'the keys go on working');
    assert.deepEqual(t.errors, [], 'no page errors');
  } catch (error) { console.log(JSON.stringify(result, null, 1)); console.error('errors', t.errors); throw error; } finally { await t.close(); }

  console.log(JSON.stringify(result, null, 1));
  console.log('PASS Attractor sound in the Playground: it opens with its music heard and followed, the speaker mutes and brings it back, Player chooses the piece, the show and the source with a knob that goes round its list, the figure and the output follow the audio input, which is never played back and is given back, Silent lets the figure rest, and a refusal is said once. The microphone is a file; how it sounds to a person is not checked here.');
})().catch(error => { console.error(error); process.exit(1); });
