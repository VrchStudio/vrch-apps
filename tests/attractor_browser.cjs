// Attractor in the real Playground: the acceptance checks of the implementation brief.
//   node tests/attractor_browser.cjs            software drawing: behaviour only, speed is reported
//   ATTRACTOR_GPU=1 node tests/...              this machine's GPU: speed is checked too
//   ATTRACTOR_ORIGIN=https://dev-3090.vrch.ai   a deployed Playground and the published App
// Screenshots go to ATTRACTOR_OUT (default /tmp/attractor-test).
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const {open, OUT, GPU, LIVE} = require('./attractor_playground.cjs');
const FORMULAS = ['dejong', 'clifford', 'svensson', 'dream'], COLOURS = ['Ember', 'Neon', 'Silver', 'Iris'], BATCH = 50000;

(async () => {
  const t = await open(), {state, stats, stopped} = t, result = {gpu: GPU, origin: t.origin, packageBytes: t.fx?.size, files: t.fx?.files.map(f => [f.path, f.size])};
  const save = (name, data) => fs.writeFileSync(path.join(OUT, name), Buffer.from(data.split(',')[1], 'base64'));
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  // Turn knob "index" one slow detent at a time until its letter reads "target".
  const reach = async (v, app, index, letter, target) => { for (let i = 0; i < 200; i++) { const now = (await state(app))[letter]; if (near(now, target)) return; await v.turn(index, now < target ? 1 : -1, 130); } throw new Error(letter + ' did not reach ' + target); };
  try {
    /* ---- opens with the reference figure, asking for nothing, silent ---- */
    const v = await t.visit('');
    const app = await v.find('control');
    result.firstFrameMs = await app.evaluate(() => __attractor.firstFrameAt);
    await app.waitForFunction(() => __attractor.twoMillionAt !== null, null, {timeout: 60000});
    result.twoMillionMs = await app.evaluate(() => __attractor.twoMillionAt);
    if (GPU) assert(result.firstFrameMs < 1000 && result.twoMillionMs < 3000, 'a first figure within 1 s and two million points within 3 s: ' + JSON.stringify(result));
    assert.deepEqual(await state(app), {formula: 'dejong', a: 1.49, b: -2.28, c: 2.36, d: -2.13, palette: 'Ember', drift: false, textVisible: true});
    await stopped(app);
    result.finished = await stats(app);
    assert(result.finished.points === result.finished.cap && result.finished.cap >= 5e6 && result.finished.cap <= 20e6 && result.finished.degenerate === false, 'the picture finishes at its limit: ' + JSON.stringify(result.finished));
    assert.equal(await app.evaluate(() => document.getElementById('corner').innerText), 'x ← sin(a·y) − cos(b·x)\ny ← sin(c·x) − cos(d·y)\na=1.49  b=-2.28  c=2.36  d=-2.13\nn = ' + result.finished.cap.toLocaleString('en-US'));
    assert.deepEqual(v.prompts, []);
    for (const frame of v.page.frames()) {
      assert.deepEqual(await frame.evaluate(() => window.__asked || []).catch(() => []), [], 'no microphone or camera request');
      assert.equal(await frame.evaluate(() => window.__sound || 0).catch(() => 0), 0, 'no sound is set up');
    }
    await v.settled();
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-open.png')});
    save('still.png', await t.bytes(app));

    /* ---- at rest nothing more is drawn ---- */
    await v.page.waitForTimeout(1300);
    const idle = await stats(app);
    assert(idle.stopped && idle.pointsPerFrame === 0 && idle.points === idle.cap, 'a finished picture adds no points: ' + JSON.stringify(idle));
    const mine = await t.bytes(app);

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
    assert.equal(await t.bytes(app), mine, 'the same formula, letters and colours finish as the same picture');

    /* ---- the output: the same figure, no text ---- */
    const out = await v.output();
    await stopped(out);
    assert.equal(await out.evaluate(() => document.body.innerText.trim()), '', 'the output shows no text');
    assert.equal(await out.evaluate(() => getComputedStyle(document.getElementById('corner')).display), 'none');
    result.outputAlike = t.alike(await t.grid(app), await t.grid(out));
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
      const first = await state(app), seen = [];
      assert.equal(first.formula, FORMULAS[f]);
      for (let i = 0; i < 12; i++) {
        await stopped(app);
        const now = await state(app), key = [now.a, now.b, now.c, now.d].join(' ');
        if (seen.includes(key)) break;
        seen.push(key);
        assert.equal((await stats(app)).degenerate, false, FORMULAS[f] + ' preset ' + key + ' has not collapsed');
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
      assert(seen.length >= 6, FORMULAS[f] + ' has six or more presets: ' + seen.length);
      await v.key(3); await v.page.waitForTimeout(300);
    }
    assert.equal((await state(app)).formula, 'dejong', 'K4 comes round to the first formula');
    assert.deepEqual(await state(out), await state(app).then(s => ({...s, textVisible: false})));

    /* ---- colours ---- */
    result.colours = [];
    await stopped(out);
    for (let i = 0; i < COLOURS.length; i++) {
      result.colours.push((await state(app)).palette);
      await v.page.waitForTimeout(200);
      save('colours-' + (i + 1) + '.png', await t.bytes(out));
      await v.key(2); await v.page.waitForTimeout(200);
    }
    assert.deepEqual(result.colours, COLOURS);
    assert.equal((await state(app)).palette, 'Ember');
    assert.equal((await stats(app)).stopped, true, 'a colour change does not start the picture again');

    /* ---- drift ---- */
    await v.key(2, 900);
    assert.equal((await state(app)).drift, true, 'K3 held turns drift on');
    assert.equal((await state(app)).palette, 'Ember', 'holding K3 does not change the colours');
    await v.page.waitForTimeout(2500);
    const adrift = [await state(app), await state(out), await stats(app)];
    assert(Math.abs(adrift[0].a - 1.49) > 0.005 && Math.abs(adrift[0].a - 1.49) <= 0.0701, 'the letters sway a little: ' + adrift[0].a);
    assert(Math.abs(adrift[0].a - adrift[1].a) < 0.01 && adrift[1].drift, 'the output sways with the device');
    assert.equal(adrift[2].mode, 'live');
    result.drift = {fps: adrift[2].fps, pointsPerFrame: adrift[2].pointsPerFrame};
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-drift.png')});
    await v.key(2, 900);
    const rested = await state(app);
    assert.equal(rested.drift, false);
    await v.page.waitForTimeout(600);
    assert.deepEqual(await state(app), rested, 'with drift off the letters stay where they were');

    /* ---- a tap hides and shows the text ---- */
    await v.tap();
    assert.equal((await state(app)).textVisible, false);
    assert.equal(await app.evaluate(() => getComputedStyle(document.getElementById('text')).display), 'none');
    await v.tap();
    assert.equal((await state(app)).textVisible, true);

    /* ---- share link: another browser opens the same figure ---- */
    await v.key(1); await v.page.waitForTimeout(1800); await v.key(2); await stopped(app); await v.page.waitForTimeout(1200);
    const sent = await state(app), link = new URL(v.page.url());
    result.shareState = link.searchParams.get('s');
    assert(/^v1\.dejong\.(-?\d+\.){4}1$/.test(result.shareState || ''), 'the address carries the figure: ' + link.search);
    const sentPicture = await t.bytes(app);
    await v.context.close();
    const w = await t.visit('&s=' + encodeURIComponent(result.shareState)), theirs = await w.find('control');
    await stopped(theirs);
    assert.deepEqual(await state(theirs), sent, 'the link restores the formula, the letters and the colours');
    assert.equal(await t.bytes(theirs), sentPicture, 'the link opens the same picture');
    await w.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'shared.png')});
    await w.context.close();
    const bad = await t.visit('&s=v1.nothing.1.2.3.4.0'), fallback = await bad.find('control');
    assert.equal((await state(fallback)).a, 1.49, 'an unreadable link opens with the defaults');
    await bad.context.close();

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
      const o = await t.visit('', {ratio, size: 0});
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
      assert(Math.min(shape.left, shape.right, shape.top, shape.bottom) > 0.02 * side, ratio + ': the figure stays inside the picture: ' + JSON.stringify(shape));
      await o.context.close();
    }

    /* ---- a 1080p output while a knob keeps turning ---- */
    const big = await t.visit('', {ratio: '16:9', size: 1080}), small = await big.find('control'), wall = await big.output();
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
    console.log('PASS Attractor in the Playground' + (LIVE ? ' at ' + LIVE : '') + ': opening, turning without flashes, the same picture again, output, steps, all presets, colours, drift, text, share link, collapsed setting, formats and a 1080p output. Screenshots in ' + OUT + '.' + (GPU ? '' : ' Speed was not checked (software drawing).'));
  } catch (error) {
    console.log(JSON.stringify(result, null, 1));
    console.error('errors', t.errors);
    throw error;
  } finally { await t.close(); }
})().catch(error => { console.error(error); process.exit(1); });
