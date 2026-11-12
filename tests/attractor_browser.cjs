// Attractor in the real Playground: the acceptance checks of the implementation brief, and the show it opens in.
//   node tests/attractor_browser.cjs            software drawing: behaviour only, speed is reported
//   ATTRACTOR_GPU=1 node tests/...              this machine's GPU: speed is checked too
//   ATTRACTOR_ORIGIN=https://dev-3090.vrch.ai   a deployed Playground and the published App
// Screenshots go to ATTRACTOR_OUT (default /tmp/attractor-test).
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const {open, OUT, GPU, LIVE} = require('./attractor_playground.cjs');
const FORMULAS = ['dejong', 'clifford', 'svensson', 'dream', 'mira', 'ikeda', 'lorenz', 'aizawa', 'thomas'], FLOWS = ['lorenz', 'aizawa', 'thomas'];
const COLOURS = ['Ember', 'Neon', 'Silver', 'Iris', 'Aurora', 'Flare'], BATCH = 50000;
// The reference figure as a link: a link opens one figure at rest, with no show and no sound moving it.
const REST = '&s=v2.dejong.149.-228.236.-213.0.0.0';

(async () => {
  const t = await open(), {state, stats, stopped} = t, result = {gpu: GPU, origin: t.origin, packageBytes: t.fx?.size, files: t.fx?.files.map(f => [f.path, f.size])};
  const save = (name, data) => fs.writeFileSync(path.join(OUT, name), Buffer.from(data.split(',')[1], 'base64'));
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  // The open panel as it stands: every choice in order, with * on the ones chosen.
  const app0 = frame => frame.evaluate(() => [...document.querySelectorAll('.ui-modal.is-visible .ui-grid-btn')].map(b => b.textContent + (b.classList.contains('is-active') ? '*' : '')));
  // What the figure is, without what the sound happens to be doing.
  const figure = s => ({formula: s.formula, a: s.a, b: s.b, c: s.c, d: s.d, palette: s.palette, show: s.show, spin: s.spin, turn: s.turn, tilt: s.tilt});
  // Take a choice in a panel: open it with its key (2 is K3, Figures; 3 is K4, Player), touch the choice, close it.
  const choose = async (v, app, key, row, value) => { await v.key(key); await v.click(app, '[data-row="' + row + '"] [data-value="' + value + '"]'); await v.key(key); };
  // Turn knob "index" one slow detent at a time until its letter reads "target".
  const reach = async (v, app, index, letter, target) => { for (let i = 0; i < 200; i++) { const now = (await state(app))[letter]; if (near(now, target)) return; await v.turn(index, now < target ? 1 : -1, 130); } throw new Error(letter + ' did not reach ' + target); };
  try {
    /* ---- opens performing: the show is on, the music plays and the figure moves with it, asking for nothing ---- */
    const d = await t.visit(''), fresh = await d.find('control');
    result.firstFrameMs = await fresh.evaluate(() => __attractor.firstFrameAt);
    if (GPU) assert(result.firstFrameMs < 1000, 'a first figure within 1 s: ' + result.firstFrameMs);
    await fresh.waitForFunction(() => __attractor.state().audible, null, {timeout: 15000});
    await d.page.waitForTimeout(2500);
    const opened = [await state(fresh), await stats(fresh)], stage = await d.output(), far0 = [await state(stage), await stats(stage)];
    assert.deepEqual([opened[0].formula, opened[0].show, opened[0].source, opened[0].track, opened[0].muted, opened[0].spin, opened[0].panel], ['dejong', 'auto', 'music', 'Strange Loop', false, 1, null], 'it opens in the show, with its music: ' + JSON.stringify(opened[0]));
    assert(opened[1].mode === 'live' && Math.abs(opened[0].a - 1.49) > 0.001 && Math.abs(opened[0].a - 1.49) < 0.2, 'the figure moves: ' + JSON.stringify(opened));
    if (GPU) assert(opened[1].fps >= 30 && opened[1].pointsPerFrame >= BATCH, 'at 30 frames a second or more: ' + JSON.stringify(opened[1]));
    assert.equal(await fresh.evaluate(() => document.getElementById('status').innerText), 'Strange Loop');
    assert.equal(await fresh.evaluate(() => document.getElementById('speaker').dataset.on), 'true', 'the speaker shows the music playing');
    assert(far0[0].show === 'on' && far0[0].spin === 1 && far0[1].mode === 'live', 'the output is in the show too: ' + JSON.stringify(far0));
    assert.deepEqual(d.prompts, []);
    for (const frame of d.page.frames()) assert.deepEqual(await frame.evaluate(() => window.__asked || []).catch(() => []), [], 'no microphone or camera request');
    await d.page.screenshot({path: path.join(OUT, 'show-open.png')});
    // The show moves on by itself: within its longest scene the letters slide to another figure of the formula.
    await fresh.waitForFunction(() => __attractor.state().scene >= 1, null, {timeout: 40000});
    await d.page.waitForTimeout(1500);
    const moved = [await state(fresh), await state(stage)];
    assert(moved[0].formula === 'dejong' && Math.abs(moved[0].a - 1.49) > 0.2 && Math.abs(moved[0].a - moved[1].a) < 0.3 && moved[0].palette === 'Ember', 'the next figure, on the output too: ' + JSON.stringify(moved));
    result.show = {scene: moved[0].scene, zoom: (await stats(stage)).fit, device: opened[1].fps, output: far0[1].fps};
    await d.page.screenshot({path: path.join(OUT, 'show-scene.png')});
    // A tap on the picture opens Player; Still there stops the show where it is, and the music plays on.
    await d.tap();
    assert.equal((await state(fresh)).panel, 'player', 'a tap opens Player');
    await d.click(fresh, '[data-row="show"] [data-value="still"]');
    await d.key(3);
    const halted = await state(fresh);
    assert.deepEqual([halted.show, halted.spin, halted.source, halted.audible, halted.palette, halted.panel], ['still', 0, 'music', true, 'Ember', null], 'Still stops the show: ' + JSON.stringify(halted));
    await d.page.waitForTimeout(2200);
    assert(Math.abs((await state(fresh)).turn - halted.turn) < 0.01 && (await state(stage)).show === 'still' && Math.abs((await stats(stage)).fit - 1.06) < 0.25, 'the figure stays where it was, whole again on the output');
    await stopped(fresh);
    assert.equal((await state(fresh)).audible, true, 'and rests while the music plays');
    await d.context.close();

    /* ---- a link opens one figure still, asking for nothing ---- */
    const v = await t.visit(REST);
    const app = await v.find('control');
    await app.waitForFunction(() => __attractor.twoMillionAt !== null, null, {timeout: 60000});
    result.twoMillionMs = await app.evaluate(() => __attractor.twoMillionAt);
    if (GPU) assert(result.twoMillionMs < 3000, 'two million points within 3 s: ' + JSON.stringify(result));
    assert.deepEqual(figure(await state(app)), {formula: 'dejong', a: 1.49, b: -2.28, c: 2.36, d: -2.13, palette: 'Ember', show: 'still', spin: 0, turn: 0, tilt: 0});
    await stopped(app);
    result.finished = await stats(app);
    assert(result.finished.points === result.finished.cap && result.finished.cap >= 5e6 && result.finished.cap <= 20e6 && result.finished.degenerate === false, 'the picture finishes at its limit: ' + JSON.stringify(result.finished));
    assert.equal(await app.evaluate(() => document.getElementById('corner').innerText), 'x ← sin(a·y) − cos(b·x)\ny ← sin(c·x) − cos(d·y)\na=1.49  b=-2.28  c=2.36  d=-2.13\nn = ' + result.finished.cap.toLocaleString('en-US') + '\n\nStrange Loop');
    assert.deepEqual(v.prompts, []);
    for (const frame of v.page.frames()) assert.deepEqual(await frame.evaluate(() => window.__asked || []).catch(() => []), [], 'no microphone or camera request');
    await v.settled();
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-open.png')});
    save('still.png', await t.bytes(app));

    /* ---- at rest nothing more is drawn ---- */
    await v.page.waitForTimeout(1300);
    const idle = await stats(app);
    assert(idle.stopped && idle.pointsPerFrame === 0 && idle.points === idle.cap, 'a finished picture adds no points: ' + JSON.stringify(idle));
    const mine = await t.bytes(app), mineGrid = await t.grid(app);

    /* ---- a knob: the next frame differs, nothing flashes, and the same letters give the same picture again ---- */
    await t.watch(app);
    await v.page.waitForTimeout(250);
    await v.turn(0, 30, 80);
    const frames = await t.watched(app), turned = frames.findIndex(f => !near(f.a, 1.49));
    assert(turned > 0, 'the knob reached the App');
    assert(frames[turned].moved > 0 || frames[turned + 1].moved > 0, 'the picture changes in the frame the letter changes: ' + JSON.stringify(frames.slice(turned - 1, turned + 2)));
    const lights = frames.slice(turned).map(f => f.light), middle = lights.slice().sort((a, b) => a - b)[lights.length >> 1];
    result.turning = {frames: lights.length, light: [Math.min(...lights), middle, Math.max(...lights)].map(x => Math.round(x * 1000) / 1000), still: Math.round(frames[0].light * 1000) / 1000};
    assert(Math.min(...lights) > 0.6 * middle && Math.max(...lights) < 1.6 * middle, 'no flash and no cleared frame while turning: ' + JSON.stringify(result.turning));
    assert(middle > 0.5 * frames[0].light && middle < 2 * frames[0].light, 'the bending figure is about as bright as the finished one: ' + JSON.stringify(result.turning));
    if (GPU) assert(near((await state(app)).a, 1.79), '30 slow detents are 0.30: ' + (await state(app)).a);
    save('turning.png', await t.bytes(app));
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-turning.png')});
    // Speed while a knob keeps turning (measured without the frame watcher, which reads pixels back).
    await v.turn(0, -12, 80);
    const fast = [];
    for (let i = 0; i < 18; i++) { await v.page.mouse.wheel(0, i % 2 ? -100 : 100); await v.page.waitForTimeout(100); if (i >= 10) fast.push(await stats(app)); }
    result.turningSpeed = {fps: Math.min(...fast.map(s => s.fps)), pointsPerFrame: Math.min(...fast.map(s => s.pointsPerFrame)), mode: fast[0].mode};
    assert.equal(fast[0].mode, 'live');
    if (GPU) assert(result.turningSpeed.fps >= 30 && result.turningSpeed.pointsPerFrame >= BATCH, 'at least 30 frames a second and 50,000 new points a frame while turning: ' + JSON.stringify(result.turningSpeed));
    await reach(v, app, 0, 'a', 1.49);
    const early = await stats(app);
    await stopped(app);
    assert(early.points < (await stats(app)).points, 'the figure keeps gathering points after the hand lets go');
    // (A slow machine may by now draw fewer pixels: then the picture is the same figure, not the same bytes.)
    const again = await stats(app);
    result.again = {size: again.size, quality: again.quality, alike: t.alike(await t.grid(app), mineGrid)};
    if (String(again.size) === String(idle.size)) assert((await t.bytes(app)) === mine, 'the same formula, letters and colours finish as the same picture: ' + JSON.stringify([result.again, await state(app)]));
    else assert(result.again.alike > 0.97, 'the same formula, letters and colours finish as the same figure: ' + JSON.stringify(result.again));
    // And again and again: a nudge there and back, with the pause between falling around the moment the picture
    // would come to rest (uploading the starting points into a buffer the graphics chip was still writing once made
    // about one picture in fourteen come out different).
    if (GPU) for (let i = 0; i < 12; i++) { await v.turn(0, 1, 120); await v.turn(0, -1, 120); await v.page.waitForTimeout(100); await stopped(app); assert((await t.bytes(app)) === mine, 'the same picture every time: differs after nudge ' + i); }

    /* ---- the output: the same figure, no text ---- */
    const out = await v.output();
    await stopped(out);
    assert.equal(await out.evaluate(() => document.body.innerText.trim()), '', 'the output shows no text');
    assert.equal(await out.evaluate(() => getComputedStyle(document.getElementById('corner')).display), 'none');
    // (The output draws the figure a little larger, to fill its height.)
    const larger = async () => (await stats(out)).fit / (await stats(app)).fit;
    result.outputAlike = t.alike(await t.grid(app, 1 / await larger()), await t.grid(out));
    assert(result.outputAlike > 0.9, 'the output shows the device figure: ' + result.outputAlike);
    result.output = await stats(out);

    /* ---- fine and coarse steps ---- */
    await v.press(1); await v.turn(1, 1, 150);
    assert(near((await state(app)).b, -2.18), 'a pressed knob steps by 0.10: ' + (await state(app)).b);
    await v.press(1); await v.turn(1, -10, 150);
    assert(near((await state(app)).b, -2.28), 'pressed again it steps by 0.01: ' + (await state(app)).b);

    /* ---- every formula, every preset: reached by gliding, none collapsed ---- */
    result.presets = {};
    for (let f = 0; f < FORMULAS.length; f++) {
      const first = await state(app), seen = [], flow = FLOWS.includes(FORMULAS[f]);
      assert.equal(first.formula, FORMULAS[f]);
      // (K2 goes through the presets and then on to the next formula.)
      for (let i = 0; i < 12; i++) {
        await stopped(app);
        const now = await state(app), key = [now.a, now.b, now.c, now.d].join(' ');
        if (now.formula !== FORMULAS[f]) break;
        assert(!seen.includes(key), FORMULAS[f] + ' preset ' + key + ' comes once');
        seen.push(key);
        assert.equal((await stats(app)).degenerate, flow ? null : false, FORMULAS[f] + ' preset ' + key + ' has not collapsed');
        if (flow) { await stopped(out); const lit = (await t.grid(out)).filter(light => light > 60).length; assert(lit > 300, FORMULAS[f] + ' preset ' + key + ' fills the picture: ' + lit + ' of 4096 cells lit'); }
        if (i < 2) { await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'preset-' + FORMULAS[f] + '-' + (i + 1) + '.png')}); save('figure-' + FORMULAS[f] + '-' + (i + 1) + '.png', await t.bytes(out)); }
        await v.key(1);
        if (i === 0) {
          // Half way through the glide the letters are between the two presets, and the output is at the same place.
          await v.page.waitForTimeout(650);
          const [a, b] = await Promise.all([state(app), state(out)]);
          assert(!near(a.a, now.a) || !near(a.b, now.b), 'a preset change glides');
          assert(Math.abs(a.a - b.a) < 0.2 && a.formula === b.formula, 'the output glides with the device: ' + JSON.stringify([a, b]));
        }
        await v.page.waitForTimeout(1700);
      }
      result.presets[FORMULAS[f]] = seen.length;
      assert.equal(seen.length, 6, FORMULAS[f] + ' has six presets');
    }
    assert.equal((await state(app)).formula, 'dejong', 'K2 comes round to the first formula');
    assert.deepEqual(figure(await state(out)), figure(await state(app)));

    /* ---- colours ---- */
    result.colours = [];
    await stopped(out);
    await v.key(2);
    assert.equal((await state(app)).panel, 'figures', 'K3 opens Figures');
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-figures.png')});
    for (let i = 0; i < COLOURS.length; i++) {
      result.colours.push((await state(app)).palette);
      await v.page.waitForTimeout(200);
      save('colours-' + (i + 1) + '.png', await t.bytes(out));
      await v.click(app, '[data-row="colours"] [data-value="' + (i + 1) % COLOURS.length + '"]'); await v.page.waitForTimeout(200);
    }
    assert.deepEqual(result.colours, COLOURS);
    assert.equal((await state(app)).palette, 'Ember');
    assert.equal((await stats(app)).stopped, true, 'a colour change does not start the picture again');

    /* ---- Figures hides and shows the text; a formula and a preset are chosen there too ---- */
    await v.click(app, '[data-row="text"] [data-value="off"]');
    assert.equal((await state(app)).textVisible, false);
    assert.equal(await app.evaluate(() => getComputedStyle(document.getElementById('corner')).display), 'none');
    await v.click(app, '[data-row="text"] [data-value="on"]');
    assert.equal((await state(app)).textVisible, true);
    await v.click(app, '[data-row="formula"] [data-value="6"]');
    assert.deepEqual([(await state(app)).formula, (await state(app)).a], ['lorenz', 1], 'a formula chosen in Figures opens at its first preset');
    // With the panel open E1 moves through its choices and a press takes one: the letter a is left alone.
    await v.turn(0, -6, 150); await v.press(0);
    assert.deepEqual([(await state(app)).formula, (await state(app)).a], ['dejong', 1.49], 'E1 chooses in the panel');
    await v.click(app, '[data-row="preset"] [data-value="2"]'); await v.page.waitForTimeout(1800);
    assert.equal((await state(app)).a, -1.19, 'a preset chosen in Figures');
    await v.click(app, '[data-row="preset"] [data-value="0"]'); await v.page.waitForTimeout(1800);
    await v.key(2);
    assert.deepEqual([(await state(app)).panel, (await state(app)).a, (await state(app)).turn], [null, 1.49, 0], 'K3 closes it');

    /* ---- share link: another browser opens the same figure ---- */
    await v.key(1); await v.page.waitForTimeout(1800); await choose(v, app, 2, 'colours', '1'); await stopped(app); await v.page.waitForTimeout(1200);
    const sent = figure(await state(app)), link = new URL(v.page.url());
    result.shareState = link.searchParams.get('s');
    assert(/^v2\.dejong\.(-?\d+\.){4}1\.0\.0$/.test(result.shareState || ''), 'the address carries the figure: ' + link.search);
    const sentPicture = await t.bytes(app);
    await v.context.close();
    const w = await t.visit('&s=' + encodeURIComponent(result.shareState)), theirs = await w.find('control');
    await stopped(theirs);
    assert.deepEqual(figure(await state(theirs)), sent, 'the link restores the formula, the letters and the colours');
    assert.equal(await t.bytes(theirs), sentPicture, 'the link opens the same picture');
    await w.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'shared.png')});
    await w.context.close();
    const bad = await t.visit('&s=v1.nothing.1.2.3.4.0'), fallback = await bad.find('control');
    assert.deepEqual([(await state(fallback)).formula, (await state(fallback)).show], ['dejong', 'auto'], 'an unreadable link opens as the App does by itself');
    await bad.context.close();
    const old = await t.visit('&s=v1.clifford.-140.160.100.70.2'), earlier = await old.find('control');
    assert.deepEqual([(await state(earlier)).formula, (await state(earlier)).a, (await state(earlier)).palette], ['clifford', -1.4, 'Silver'], 'a link from an earlier version still opens');
    await old.context.close();

    /* ---------- the show from a still figure: Auto starts it, a knob holds it, Still stops it there ---------- */
    const m = await t.visit(REST), dev = await m.find('control'), far = await m.output();
    await stopped(dev); await stopped(far);
    const front = await t.grid(far);
    await choose(m, dev, 3, 'show', 'auto');
    assert.deepEqual([(await state(dev)).show, (await state(dev)).spin, (await state(dev)).palette], ['auto', 1, 'Ember'], 'Auto: the show, and the colours stay');
    await m.page.waitForTimeout(2500);
    const spun = [await state(dev), await state(far), await stats(dev), await stats(far)];
    assert(spun[0].turn > 10 && Math.abs(spun[0].turn - spun[1].turn) < 3 && spun[1].spin === 1 && spun[1].show === 'on', 'the figure turns, and the output with it: ' + JSON.stringify([spun[0].turn, spun[1].turn]));
    assert(spun[0].tilt > 1 && Math.abs(spun[0].tilt - spun[1].tilt) < 0.5, 'it tilts: ' + JSON.stringify([spun[0].tilt, spun[1].tilt]));
    assert(Math.abs(spun[0].a - 1.49) > 0.003 && Math.abs(spun[0].a - 1.49) <= 0.2 && Math.abs(spun[0].a - spun[1].a) < 0.08, 'the letters sway a little, on the output too: ' + JSON.stringify([spun[0].a, spun[1].a]));
    assert(spun[2].mode === 'live' && spun[3].mode === 'live');
    result.spin = {device: {fps: spun[2].fps, pointsPerFrame: spun[2].pointsPerFrame}, output: {fps: spun[3].fps, pointsPerFrame: spun[3].pointsPerFrame}};
    await m.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-spin.png')});
    save('output-spin.png', await t.bytes(far));
    // A knob in the hand: the show holds, and goes on performing on this figure.
    await m.turn(0, 3, 120);
    assert.deepEqual([(await state(dev)).show, (await state(dev)).scene, (await state(dev)).spin], ['hold', 0, 1], 'a knob turned holds the show');
    await choose(m, dev, 3, 'show', 'still');
    const rested = figure(await state(dev));
    assert.deepEqual([rested.show, rested.spin], ['still', 0], 'Still: the show stops');
    await m.page.waitForTimeout(600);
    assert.deepEqual(figure(await state(dev)), rested, 'the letters and the view stay where they were');
    await stopped(dev); await stopped(far);
    const aside = t.alike(await t.grid(far), front);
    assert(aside < 0.9, 'seen from another side it is another picture: ' + aside);
    // A drag: across turns the figure, down tilts it. (The whole short side of the screen is half a turn.)
    await m.drag(0.15, 0.05);
    const dragged = await state(dev);
    assert(dragged.turn - rested.turn > 15 && dragged.turn - rested.turn < 90 && dragged.tilt - rested.tilt > 3 && dragged.tilt < 57 && dragged.spin === 0 && dragged.textVisible, 'a drag turns and tilts the figure and hides nothing: ' + JSON.stringify([rested.turn, dragged.turn, dragged.tilt]));
    await stopped(dev); await stopped(far);
    assert(Math.abs((await state(far)).turn - dragged.turn) < 0.2 && Math.abs((await state(far)).tilt - dragged.tilt) < 0.2, 'the output is seen from the same side');
    result.turnedAlike = t.alike(await t.grid(dev, (await stats(dev)).fit / (await stats(far)).fit), await t.grid(far));
    assert(result.turnedAlike > 0.9, 'and shows the same turned figure: ' + result.turnedAlike);
    await m.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-turned.png')});
    save('output-turned.png', await t.bytes(far));
    await m.page.waitForTimeout(1200);
    const viewed = new URL(m.page.url()).searchParams.get('s');
    const from = await t.visit('&s=' + encodeURIComponent(viewed)), same = await from.find('control');
    assert(Math.abs((await state(same)).turn - dragged.turn % 360) < 0.6 && Math.abs((await state(same)).tilt - dragged.tilt) < 0.6, 'the link opens the figure from the same side: ' + viewed);
    await from.context.close();
    await m.drag(-0.2, 0, true);
    assert.equal((await state(dev)).spin, -1, 'a flick sets it spinning the way it was thrown');
    await m.tap();
    assert.deepEqual([(await state(dev)).spin, (await state(dev)).panel], [-1, 'player'], 'a tap is still a tap');
    await m.key(3);
    await m.drag(0.05, 0);
    assert.equal((await state(dev)).spin, 0, 'a drag stops the spin');
    await m.context.close();

    /* ---- a collapsed setting: marked on the device only, and K2 leads back ---- */
    const c = await t.visit('&s=v1.dejong.0.0.0.0.0'), lone = await c.find('control');
    await stopped(lone);
    assert.equal((await stats(lone)).degenerate, true, 'every letter at 0 collapses to one point');
    assert.equal(await lone.evaluate(() => getComputedStyle(document.getElementById('flag')).display !== 'none' && document.getElementById('flag').innerText), 'Collapsed to a few points · K2 next preset');
    const loneOut = await c.output();
    await stopped(loneOut);
    assert.equal(await loneOut.evaluate(() => document.body.innerText.trim()), '', 'the output says nothing about it');
    await c.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-collapsed.png')});
    await c.key(1); await c.page.waitForTimeout(1800); await stopped(lone);
    assert.equal((await stats(lone)).degenerate, false, 'K2 leads to a preset');
    assert.equal(await lone.evaluate(() => getComputedStyle(document.getElementById('flag')).display), 'none');
    await c.context.close();

    /* ---- output formats: the figure keeps its shape and stays inside ---- */
    result.formats = {};
    let reference = null;
    for (const ratio of ['16:9', '9:16', '21:9', '4:3']) {
      const o = await t.visit(REST, {ratio, size: 0});
      await o.find('control');
      const picture = await o.output();
      await stopped(picture);
      assert.equal(await picture.evaluate(() => document.body.innerText.trim()), '');
      await o.page.locator('#outputScreen').screenshot({path: path.join(OUT, 'output-' + ratio.replace(':', 'x') + '.png')});
      // The lit part of the picture, in canvas pixels.
      const shape = await picture.evaluate(() => {
        const source = document.getElementById('picture'), w = source.width, h = source.height, copy = document.createElement('canvas'); copy.width = w; copy.height = h;
        const g = copy.getContext('2d', {willReadFrequently: true}); g.drawImage(source, 0, 0);
        const d = g.getImageData(0, 0, w, h).data; let x0 = w, x1 = 0, y0 = h, y1 = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[4 * (y * w + x)] + d[4 * (y * w + x) + 1] + d[4 * (y * w + x) + 2] > 90) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        return {canvas: [w, h], css: [innerWidth, innerHeight], wide: x1 - x0, tall: y1 - y0, left: x0, right: w - 1 - x1, top: y0, bottom: h - 1 - y1};
      });
      result.formats[ratio] = shape;
      const wanted = ratio.split(':').reduce((a, b) => a / b), side = Math.min(...shape.canvas);
      assert(Math.abs(shape.css[0] / shape.css[1] / wanted - 1) < 0.03 && Math.abs(shape.canvas[0] / shape.canvas[1] / wanted - 1) < 0.03, ratio + ' panel: ' + JSON.stringify(shape));
      // The figure takes the same share of the shorter side, both ways, whatever the format.
      reference ||= [shape.wide / side, shape.tall / side];
      assert(reference[0] > 0.6 && reference[1] > 0.6 && Math.abs(shape.wide / side - reference[0]) < 0.03 && Math.abs(shape.tall / side - reference[1]) < 0.03, ratio + ': the figure keeps its proportions: ' + JSON.stringify(shape));
      assert(Math.min(shape.left, shape.right, shape.top, shape.bottom) > 0.004 * side, ratio + ': the figure stays inside the picture: ' + JSON.stringify(shape));
      assert(shape.tall > 0.9 * side, ratio + ': and fills its height: ' + JSON.stringify(shape));
      await o.context.close();
    }

    /* ---- how an output shows the figure: whole, three or mirrored; the device keeps the one whole figure ---- */
    const y = await t.visit(REST, {ratio: '16:9', size: 0}), hand = await y.find('control'), screen = await y.output();
    await stopped(screen);
    // Where the light is across the picture, and how alike its left half is to its right half turned over.
    const spread = frame => frame.evaluate(() => {
      const source = document.getElementById('picture'), copy = document.createElement('canvas'); copy.width = 96; copy.height = 54;
      const g = copy.getContext('2d', {willReadFrequently: true}); g.drawImage(source, 0, 0, 96, 54);
      const d = g.getImageData(0, 0, 96, 54).data, light = (x, y) => d[4 * (y * 96 + x)] + d[4 * (y * 96 + x) + 1] + d[4 * (y * 96 + x) + 2];
      let left = 96, right = 0, ab = 0, aa = 0, bb = 0;
      for (let y = 0; y < 54; y++) for (let x = 0; x < 96; x++) { if (light(x, y) > 90) { left = Math.min(left, x); right = Math.max(right, x); } if (x < 48) { const a = light(x, y), b = light(95 - x, y); ab += a * b; aa += a * a; bb += b * b; } }
      return {wide: Math.max(0, right - left + 1) / 96, left: left / 96, right: (95 - right) / 96, mirrored: ab / Math.sqrt(aa * bb || 1)};
    });
    await y.key(2);
    assert.deepEqual((await app0(hand)).slice(-5), ['Whole*', 'Three', 'Mirror', 'Show*', 'Hide'], 'Figures offers the three ways, in one row');
    result.layouts = {};
    for (const [i, name] of ['Whole', 'Three', 'Mirror'].entries()) {
      await y.click(hand, '[data-row="output"] [data-value="' + i + '"]');
      await y.page.waitForTimeout(400); await stopped(screen); await stopped(hand);
      result.layouts[name] = {...(await spread(screen)), fit: (await stats(screen)).fit, copies: (await stats(screen)).copies};
      assert.deepEqual([(await state(screen)).layout, (await stats(hand)).copies, (await stats(hand)).fit], [name, 0, 1], 'the output is told; the device keeps its one whole figure');
      await y.page.locator('#outputScreen').screenshot({path: path.join(OUT, 'output-layout-' + name.toLowerCase() + '.png')});
    }
    const {Whole, Three, Mirror} = result.layouts;
    assert(Whole.copies === 0 && Whole.wide < 0.6 && Whole.mirrored < 0.9, 'whole: one figure in the middle: ' + JSON.stringify(Whole));
    assert(Three.copies === 2 && Three.wide > 1.4 * Whole.wide, 'three: the figure with one more at each side: ' + JSON.stringify(Three));
    assert(Mirror.copies >= 1 && Mirror.mirrored > 0.97 && Mirror.wide > 1.4 * Whole.wide, 'mirror: the two halves answer each other: ' + JSON.stringify(Mirror));
    await y.click(hand, '[data-row="output"] [data-value="0"]');
    await y.context.close();

    /* ---- a 1080p output while a knob keeps turning ---- */
    const big = await t.visit(REST, {ratio: '16:9', size: 1080}), small = await big.find('control'), wall = await big.output();
    await stopped(wall);
    result.large = {size: (await stats(wall)).size, cap: (await stats(wall)).cap};
    assert.deepEqual(result.large.size, [1920, 1080]);
    const busy = [];
    await big.turn(2, 6, 60);
    for (let i = 0; i < 22; i++) { await big.page.mouse.wheel(0, i % 2 ? -100 : 100); await big.page.waitForTimeout(100); if (i >= 12) busy.push([await stats(small), await stats(wall)]); }
    result.large.turning = {device: {fps: Math.min(...busy.map(b => b[0].fps)), pointsPerFrame: Math.min(...busy.map(b => b[0].pointsPerFrame))}, output: {fps: Math.min(...busy.map(b => b[1].fps)), pointsPerFrame: Math.min(...busy.map(b => b[1].pointsPerFrame))}};
    if (GPU) assert(result.large.turning.output.fps >= 30 && result.large.turning.output.pointsPerFrame >= BATCH && result.large.turning.device.fps >= 30, 'a 1080p output keeps 30 frames a second while turning: ' + JSON.stringify(result.large.turning));
    await big.page.locator('#outputScreen').screenshot({path: path.join(OUT, 'output-1080p-turning.png')});
    await big.context.close();

    assert.deepEqual(t.errors, [], 'no page errors');
    console.log(JSON.stringify(result, null, 1));
    console.log('PASS Attractor in the Playground' + (LIVE ? ' at ' + LIVE : '') + ': opening in the show, a link at rest, turning without flashes, the same picture again, output, steps, all presets, colours, the show, text, share link, collapsed setting, formats, the three ways an output shows the figure and a 1080p output. Screenshots in ' + OUT + '.' + (GPU ? '' : ' Speed was not checked (software drawing).'));
  } catch (error) {
    console.log(JSON.stringify(result, null, 1));
    console.error('errors', t.errors);
    throw error;
  } finally { await t.close(); }
})().catch(error => { console.error(error); process.exit(1); });
