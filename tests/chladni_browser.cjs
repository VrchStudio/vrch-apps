// Chladni in the real Playground: the acceptance checks of the implementation brief.
//   node tests/chladni_browser.cjs            software drawing: behaviour only, speed is reported
//   CHLADNI_GPU=1 node tests/...              this machine's GPU: speed is checked too
//   CHLADNI_ORIGIN=https://dev-3090.vrch.ai   a deployed Playground and the published App
// Screenshots go to CHLADNI_OUT (default /tmp/chladni-test). The host output is tapped with the SDK's own PCM
// processor, so "heard" means the samples the host hands to the audio device.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const {open, OUT, GPU, LIVE} = require('./chladni_playground.cjs');
// The first figure as a link.
const REST = '&s=v1.3.5.60.0.0';
const COLOURS = ['Sand', 'Night', 'Brass'], PRESETS = 8;

(async () => {
  const t = await open(), {state, stats} = t, result = {gpu: GPU, origin: t.origin, packageBytes: t.fx?.size, files: t.fx?.files.map(f => [f.path, f.size])};
  const save = (name, data) => fs.writeFileSync(path.join(OUT, name), Buffer.from(data.split(',')[1], 'base64'));
  const everyFrame = async (page, read) => { const all = []; for (const frame of page.frames()) all.push(...await frame.evaluate(read).catch(() => [])); return all; };
  const figure = s => ({n: s.n, m: s.m, drive: s.drive, shape: s.shape, palette: s.palette});
  const amplitude = async frame => (await stats(frame)).amplitude;
  // The mean amplitude under the sand, read "count" times "gap" ms apart.
  const watch = async (page, frame, count, gap = 100) => { const seen = []; for (let i = 0; i < count; i++) { seen.push(await amplitude(frame)); await page.waitForTimeout(gap); } return seen; };
  const mean = list => list.reduce((sum, value) => sum + value, 0) / list.length;
  const round = value => Math.round(value * 1000) / 1000;
  // How alike two pictures are as figures: only the sand counts (what is lighter than the bare plate, which is what most of
  // the picture shows), and grain by grain they differ, so it is first gathered into 16 x 16 cells.
  const coarse = light => { const plate = light.slice().sort((a, b) => a - b)[2048], cells = new Array(256).fill(0); light.forEach((value, i) => { cells[(Math.floor(i / 64) >> 2) * 16 + ((i % 64) >> 2)] += Math.max(0, value - plate); }); return cells; };
  const alike = (a, b) => round(t.alike(coarse(a), coarse(b)));
  try {
    /* ---- it opens with the plate and its sand, silent, asking for nothing; the sand gathers by itself ---- */
    const v = await t.visit(''), app = await v.find('control');
    result.firstFrameMs = await app.evaluate(() => __chladni.firstFrameAt);
    if (GPU) assert(result.firstFrameMs < 1000, 'plate and sand within 1 s: ' + result.firstFrameMs);
    assert.deepEqual(await state(app), {n: 3, m: 5, drive: 0.6, shape: 0, palette: 'Sand', sound: false, shaking: false, preset: 1, shapeNow: 0, note: 'F#3'});
    await v.page.waitForTimeout(3000);
    result.opened = {amplitude: await amplitude(app), stats: await stats(app)};
    assert.deepEqual(await everyFrame(v.page, () => window.__asked || []), [], 'nothing is asked for');
    assert.deepEqual(await everyFrame(v.page, () => window.__sound || []), [], 'no sound is set up before K2');
    assert.equal((await t.heard(v.page, 2000)).left, 0, 'it opens silent');
    assert.equal(await app.evaluate(() => document.getElementById('notice').hidden), true);
    if (GPU) assert(result.opened.stats.fps >= 55, 'the device screen at 60 frames a second: ' + JSON.stringify(result.opened.stats));
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-open.png')});
    const out = await v.output();
    await v.page.waitForTimeout(3000);
    assert.deepEqual(figure(await state(out)), figure(await state(app)), 'the output shows the same settings');
    assert.equal(await out.evaluate(() => document.body.innerText.trim()), '', 'no text on the output');

    /* ---- K3: the sand is thrown and gathers again; held, the plate keeps shaking ---- */
    const rest = mean(await watch(v.page, app, 5));
    await v.key(2);
    const thrown = await watch(v.page, app, 34), peak = Math.max(...thrown.slice(0, 6)), far = await amplitude(out);
    result.scatter = {rest: round(rest), peak: round(peak), after1s: round(thrown[9]), after3s: round(thrown[29]), outputPeak: round(far)};
    assert(peak > 2.5 * rest && peak > 0.2, 'K3 throws the sand: ' + JSON.stringify(result.scatter));
    assert(thrown[29] < 0.5 * peak, 'within 3 s it has gathered again: ' + JSON.stringify(result.scatter));
    assert(result.opened.amplitude < 0.5 * peak, 'and 3 s after opening the figure was there: ' + JSON.stringify(result.opened));
    const holding = v.key(2, 2600);
    await v.page.waitForTimeout(900);
    const held = await watch(v.page, app, 12), heldState = await state(app), heldFar = await watch(v.page, out, 3);
    await holding;
    result.hold = {lowest: round(Math.min(...held)), outputLowest: round(Math.min(...heldFar))};
    assert(heldState.shaking && Math.min(...held) > 0.8 * peak && Math.min(...heldFar) > 0.8 * peak, 'held, the sand stays scattered, on the output too: ' + JSON.stringify(result.hold));
    await v.page.waitForTimeout(3000);
    assert(!(await state(app)).shaking && await amplitude(app) < 0.5 * peak && await amplitude(out) < 0.5 * peak, 'let go, it gathers on both');
    // The same figure on both screens: the same lines, each from its own grains.
    await v.page.waitForTimeout(1500);
    result.outputAlike = alike(await t.grid(app), await t.grid(out));
    assert(result.outputAlike > 0.8, 'device and output show the same figure: ' + result.outputAlike);
    await v.page.screenshot({path: path.join(OUT, 'page.png')});

    /* ---- K2: the note is heard; a turn of E1 changes figure and pitch together, without a click ---- */
    await v.key(1);
    await app.waitForFunction(() => __chladni.stats().audible, null, {timeout: 15000});
    await v.page.waitForTimeout(800);
    const before = await stats(app);
    result.sound = {heard: await t.heard(v.page, 600), state: (await state(app)).sound};
    assert(result.sound.state && result.sound.heard.left > 0.02 && result.sound.heard.right > 0.02 && Math.max(result.sound.heard.left, result.sound.heard.right) <= 0.5005, 'the note is heard, under the ceiling: ' + JSON.stringify(result.sound));
    assert.deepEqual(await everyFrame(v.page, () => window.__sound || []), [{sampleRate: 48000, sink: 'none'}], 'one 48 kHz context that leaves the speakers to the host');
    assert.deepEqual(await everyFrame(v.page, () => window.__asked || []), [], 'sound asks for no input');
    await v.turn(0, 1, 150);
    const turned = [await state(app), await stats(app)], moved = await amplitude(app);
    assert(turned[0].n === 4 && turned[1].hertz > before.hertz, 'E1 raises n and the pitch: ' + JSON.stringify(turned));
    assert(Math.abs(turned[1].changedAt - turned[1].tunedAt) <= 50, 'figure and pitch change together: ' + JSON.stringify(turned[1]));
    assert(moved > 1.5 * rest, 'the sand lets go of the old lines: ' + moved);
    await v.page.waitForTimeout(3000);
    result.change = {moved: round(moved), after3s: round(await amplitude(app)), apartMs: Math.abs(turned[1].changedAt - turned[1].tunedAt)};
    assert(result.change.after3s < 0.5 * peak, 'and has found the new ones within 3 s: ' + JSON.stringify(result.change));
    await v.turn(0, 6, 45); await v.turn(1, 5, 45); await v.turn(0, -6, 45); await v.turn(1, -5, 45);
    await v.page.waitForTimeout(200);
    result.fast = await t.heard(v.page, 2200);
    assert(result.fast.step < 0.09 && result.fast.left > 0.02, 'fast turning makes no click: ' + JSON.stringify(result.fast));
    assert.deepEqual([(await state(app)).n, (await state(app)).m], [4, 5]);
    await v.turn(0, -1, 150);
    await v.key(1);
    await v.page.waitForTimeout(500);
    result.silent = await t.heard(v.page, 250);
    assert(!(await state(app)).sound && result.silent.left < 0.002 && result.silent.right < 0.002, 'K2 again: silence: ' + JSON.stringify(result.silent));
    assert((await t.heard(v.page, 800)).step < 0.09, 'fading out makes no click');

    /* ---- E3: at 0 the sand lies still; at full drive the lines are finer and it gathers faster ---- */
    await v.turn(2, -12, 60);
    await v.page.waitForTimeout(700);
    const still = [await t.bytes(app), null];
    await v.page.waitForTimeout(500);
    still[1] = await t.bytes(app);
    assert.equal((await state(app)).drive, 0);
    assert(still[0] === still[1], 'at 0% nothing moves');
    await v.press(2);
    assert.equal((await state(app)).drive, 0.6, 'a press of E3 sets drive back');
    await v.turn(2, 8, 60);
    assert.equal((await state(app)).drive, 1);
    await v.page.waitForTimeout(3500);
    const fine = mean(await watch(v.page, app, 5));
    await v.key(2);
    const quick = await watch(v.page, app, 12);
    result.drive = {restAt60: round(rest), restAt100: round(fine), after1sAt60: round(thrown[9]), after1sAt100: round(quick[9])};
    assert(fine < 0.85 * rest && quick[9] < thrown[9], 'full drive: finer lines, sooner: ' + JSON.stringify(result.drive));
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-drive-100.png')});
    await v.press(2);

    /* ---- E4: square to round without a jump, the rim with it; a press goes straight to one of them ---- */
    // (A corner of the square: plate when square, black when round.)
    const corner = async frame => { const light = await t.grid(frame); return light[2 * 64 + 2] + light[2 * 64 + 61] + light[61 * 64 + 2] + light[61 * 64 + 61]; };
    assert(await corner(app) > 60, 'the square plate reaches its corners');
    save('shape-square.png', await t.bytes(out));
    const sliding = [];
    const slide = v.turn(3, 25, 70);
    for (let i = 0; i < 40; i++) { sliding.push((await state(app)).shapeNow); await v.page.waitForTimeout(50); }
    await slide; await v.page.waitForTimeout(600);
    result.shape = {largestStep: round(Math.max(...sliding.slice(1).map((value, i) => value - sliding[i]))), backwards: round(Math.min(...sliding.slice(1).map((value, i) => value - sliding[i])))};
    assert.deepEqual([(await state(app)).shape, (await state(app)).shapeNow, (await state(out)).shape], [1, 1, 1], 'E4 reaches the round plate, on the output too');
    assert(result.shape.largestStep < 0.2 && result.shape.backwards >= 0, 'the shape slides without a jump: ' + JSON.stringify(sliding));
    assert.equal(await corner(app), 0, 'the round plate leaves the corners black');
    await v.page.waitForTimeout(2500);
    save('shape-round.png', await t.bytes(out));
    await v.turn(3, -12, 70); await v.page.waitForTimeout(3000);
    assert.equal((await state(app)).shape, 0.52);
    save('shape-between.png', await t.bytes(out));
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-between.png')});
    await v.press(3); await v.page.waitForTimeout(900);
    assert.equal((await state(app)).shape, 1, 'a press of E4 goes to the nearer plate');
    await v.press(3); await v.page.waitForTimeout(900);
    assert.deepEqual([(await state(app)).shape, (await state(app)).shapeNow], [0, 0], 'and from a plate to the other one');

    /* ---- E1 pressed swaps n and m; E2 pressed goes through the colours ---- */
    await v.press(0);
    assert.deepEqual([(await state(app)).n, (await state(app)).m], [5, 3], 'E1 pressed swaps n and m');
    await v.press(0);
    result.colours = [];
    for (let i = 0; i < COLOURS.length; i++) {
      result.colours.push((await state(app)).palette);
      assert.equal((await state(out)).palette, COLOURS[i]);
      await v.page.waitForTimeout(700);
      save('colours-' + (i + 1) + '.png', await t.bytes(out));
      await v.press(1); await v.page.waitForTimeout(300);
    }
    assert.deepEqual(result.colours, COLOURS);
    assert.equal((await state(app)).palette, 'Sand');

    /* ---- a tap knocks the sand away from one spot, on both screens; it flows back ---- */
    await v.page.waitForTimeout(2500);
    // A spot on one of the figure's lines: a quarter of the way across the plate, half way up.
    const spot = await app.evaluate(() => { const c = document.getElementById('picture'), side = 0.94 * Math.min(c.clientWidth, c.clientHeight); return [0.5 - 0.25 * side / c.clientWidth, 0.5]; });
    // How much sand lies there, frame by frame for five seconds: the light of that spot above the bare plate (which is
    // what most of the picture shows).
    const follow = frame => frame.evaluate(() => {
      const source = document.getElementById('picture'), copy = document.createElement('canvas'), seen = window.__spot = []; copy.width = copy.height = 64;
      const g = copy.getContext('2d', {willReadFrequently: true}), began = performance.now();
      const look = now => {
        const side = Math.min(source.width, source.height);
        g.drawImage(source, (source.width - side) / 2, (source.height - side) / 2, side, side, 0, 0, 64, 64);
        const d = g.getImageData(0, 0, 64, 64).data, light = []; for (let i = 0; i < d.length; i += 4) light.push(d[i] + d[i + 1] + d[i + 2]);
        let sum = 0; for (let row = 31; row <= 33; row++) for (let column = 14; column <= 20; column++) sum += light[row * 64 + column];
        seen.push(sum / 21 - light.slice().sort((a, b) => a - b)[2048]);
        if (now - began < 5000) requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
    const calm = await amplitude(app);
    await follow(app); await follow(out);
    await v.page.waitForTimeout(400);
    await v.click(app, '#picture', spot);
    await v.page.waitForTimeout(5200);
    const seenSpot = [await app.evaluate(() => window.__spot), await out.evaluate(() => window.__spot)], settled = await amplitude(app);
    const lying = seenSpot.map(list => mean(list.slice(0, 12))), knocked = seenSpot.map(list => Math.min(...list)), back = seenSpot.map(list => mean(list.slice(-12)));
    result.tap = {lying: lying.map(Math.round), knocked: knocked.map(Math.round), back: back.map(Math.round), amplitude: [calm, settled].map(round)};
    assert(knocked[0] < 0.5 * lying[0] && knocked[1] < 0.5 * lying[1], 'a tap knocks the sand off the line there, on both screens: ' + JSON.stringify(result.tap));
    assert(back[0] > 0.45 * lying[0] && back[1] > 0.45 * lying[1] && settled < 1.05 * calm, 'and the sand flows back: ' + JSON.stringify(result.tap));
    assert.deepEqual(figure(await state(app)), {n: 3, m: 5, drive: 0.6, shape: 0, palette: 'Sand'}, 'a tap changes no setting');

    /* ---- K4: eight presets, each a figure of its own ---- */
    const seen = [];
    for (let i = 0; i < PRESETS; i++) {
      await v.page.waitForTimeout(i ? 3200 : 0);
      const now = await state(app);
      assert.equal(now.preset, i + 1);
      seen.push({key: [now.n, now.m, now.shape].join(' '), light: await t.grid(out)});
      save('preset-' + (i + 1) + '.png', await t.bytes(out));
      await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-preset-' + (i + 1) + '.png')});
      await v.key(3);
      if (i === 0) {
        // Half way there the shape and the plate are between the two.
        await v.page.waitForTimeout(250);
        assert.notDeepEqual([(await state(app)).n, (await state(app)).m, (await state(app)).shape].join(' '), seen[0].key, 'K4 goes to the next preset');
      }
    }
    await v.page.waitForTimeout(1200);
    result.presets = seen.map(s => s.key);
    assert.equal(new Set(result.presets).size, PRESETS, 'eight different presets: ' + result.presets);
    assert.equal((await state(app)).preset, 1, 'K4 comes round to the first');
    result.presetsAlike = 0;
    for (let a = 0; a < PRESETS; a++) for (let b = a + 1; b < PRESETS; b++) result.presetsAlike = Math.max(result.presetsAlike, alike(seen[a].light, seen[b].light));
    result.presetPairs = seen.map((a, i) => seen.map((b, j) => j > i ? alike(a.light, b.light) : null).filter(v => v !== null));
    // (Every square figure has the same diagonal line, so two of them are never wholly unlike.)
    assert(result.presetsAlike < 0.8, 'no two presets look alike: ' + result.presetsAlike);

    /* ---- settings are kept, sound is not; the share link opens the same figure in another browser ---- */
    await v.turn(0, 1, 150); await v.turn(3, 6, 70); await v.press(1); await v.turn(2, 2, 70);
    await v.page.waitForTimeout(3500);
    const sent = figure(await state(app)), link = new URL(v.page.url()), sentLight = await t.grid(app);
    result.shareState = link.searchParams.get('s');
    assert.deepEqual(sent, {n: 4, m: 5, drive: 0.7, shape: 0.24, palette: 'Night'});
    assert.equal(result.shareState, 'v1.4.5.70.24.1', 'the address carries the figure: ' + link.search);
    await v.key(1);
    await app.waitForFunction(() => __chladni.stats().audible, null, {timeout: 15000});
    await v.page.goto(v.page.url().replace(/[?&]s=[^&]*/, ''));
    const again = await v.find('control');
    assert.deepEqual([figure(await state(again)), (await state(again)).sound], [sent, false], 'opened again: the same settings, and silent');
    await v.context.close();
    const w = await t.visit('&s=' + encodeURIComponent(result.shareState)), theirs = await w.find('control');
    await w.page.waitForTimeout(4000);
    assert.deepEqual(figure(await state(theirs)), sent, 'the link restores n, m, drive, shape and colours');
    result.sharedAlike = alike(await t.grid(theirs), sentLight);
    assert(result.sharedAlike > 0.7, 'and shows the same figure: ' + result.sharedAlike);
    await w.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'shared.png')});
    await w.context.close();
    for (const broken of ['v1.0.5.60.0.0', 'v1.3.13.60.0.0', 'v1.3.5.101.0.0', 'v1.3.5.60.0.3', 'v2.3.5.60.0.0', 'nonsense']) {
      const bad = await t.visit('&s=' + broken), fallback = await bad.find('control');
      assert.deepEqual(figure(await state(fallback)), {n: 3, m: 5, drive: 0.6, shape: 0, palette: 'Sand'}, 'a link that cannot be read is ignored: ' + broken);
      await bad.context.close();
    }

    /* ---- output formats: the plate stays square and inside the picture ---- */
    result.formats = {};
    for (const ratio of ['16:9', '9:16', '21:9', '4:3']) {
      const o = await t.visit(REST, {ratio, size: 0});
      await o.find('control');
      const picture = await o.output();
      await o.page.waitForTimeout(3500);
      assert.equal(await picture.evaluate(() => document.body.innerText.trim()), '');
      await o.page.locator('#outputScreen').screenshot({path: path.join(OUT, 'output-' + ratio.replace(':', 'x') + '.png')});
      // The plate, in canvas pixels: everything that is not black.
      const shape = await picture.evaluate(() => {
        const source = document.getElementById('picture'), w = source.width, h = source.height, copy = document.createElement('canvas'); copy.width = w; copy.height = h;
        const g = copy.getContext('2d', {willReadFrequently: true}); g.drawImage(source, 0, 0);
        const d = g.getImageData(0, 0, w, h).data; let x0 = w, x1 = 0, y0 = h, y1 = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[4 * (y * w + x)] + d[4 * (y * w + x) + 1] + d[4 * (y * w + x) + 2] > 12) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        return {canvas: [w, h], css: [innerWidth, innerHeight], wide: x1 - x0 + 1, tall: y1 - y0 + 1, left: x0, right: w - 1 - x1, top: y0, bottom: h - 1 - y1};
      });
      result.formats[ratio] = shape;
      const wanted = ratio.split(':').reduce((a, b) => a / b), side = Math.min(...shape.canvas);
      assert(Math.abs(shape.css[0] / shape.css[1] / wanted - 1) < 0.03 && Math.abs(shape.canvas[0] / shape.canvas[1] / wanted - 1) < 0.03, ratio + ' panel: ' + JSON.stringify(shape));
      assert(Math.abs(shape.wide - shape.tall) <= 2 && Math.abs(shape.wide / side - 0.94) < 0.02, ratio + ': the plate is square and fills the shorter side: ' + JSON.stringify(shape));
      assert(Math.abs(shape.left - shape.right) <= 2 && Math.abs(shape.top - shape.bottom) <= 2 && Math.min(shape.left, shape.top) > 0, ratio + ': in the middle, inside the picture: ' + JSON.stringify(shape));
      await o.context.close();
    }

    /* ---- a 1080p output while a knob keeps turning ---- */
    const big = await t.visit(REST, {ratio: '16:9', size: 1080}), small = await big.find('control'), wall = await big.output();
    await big.page.waitForTimeout(3000);
    result.large = {size: (await stats(wall)).size, grains: (await stats(wall)).grains, resting: (await stats(wall)).fps};
    assert.deepEqual(result.large.size, [1920, 1080]);
    assert.equal(result.large.grains, 80000);
    const busy = [];
    for (let i = 0; i < 24; i++) { await big.turn(0, i % 2 ? -1 : 1, 110); if (i >= 12) busy.push([await stats(small), await stats(wall)]); }
    result.large.turning = {device: Math.min(...busy.map(b => b[0].fps)), output: Math.min(...busy.map(b => b[1].fps))};
    if (GPU) assert(result.large.turning.output >= 50 && result.large.turning.device >= 50, 'a 1080p output keeps 50 frames a second while turning: ' + JSON.stringify(result.large));
    await big.page.locator('#outputScreen').screenshot({path: path.join(OUT, 'output-1080p.png')});
    save('output-1080p-picture.png', await t.bytes(wall));
    await big.context.close();

    assert.deepEqual(t.errors, [], 'no page errors');
    console.log(JSON.stringify(result, null, 1));
    console.log('PASS Chladni in the Playground' + (LIVE ? ' at ' + LIVE : '') + ': opening silent with the sand gathering, K3 thrown and held, the note with figure and pitch changing together and no click, drive, shape, swap, colours, a tap, eight presets, saved settings, share link, formats and a 1080p output. Screenshots in ' + OUT + '.' + (GPU ? '' : ' Speed was not checked (software drawing).'));
  } catch (error) {
    console.log(JSON.stringify(result, null, 1));
    console.log('errors', JSON.stringify(t.errors));
    throw error;
  } finally { await t.close(); }
})().catch(error => { console.error(error); process.exit(1); });
