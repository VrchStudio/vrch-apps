// XY Scope in the real Pages Playground: the synthesizer. See xy_scope_playground.cjs for what is real and what is a
// fixture, and xy_scope_input_browser.cjs for input mode.
//
//   VRCH_PAGES_ROOT=../vrch-web-viewer-pages node tests/xy_scope_browser.cjs      (XY_SCOPE_GPU=1 for a real GPU)
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const {open, OUT} = require('./xy_scope_playground.cjs');

async function main() {
  const playground = await open(), {fx, errors, visit, state, probe, fps, view, until} = playground;
  const result = {packageBytes: fx.size, files: fx.files.map(f => [f.path, f.size])};
  try {
    const turns = value => ((value % 1) + 1.5) % 1 - 0.5;

    /* ---- opens with a picture, silent, asking for nothing ---- */
    const v = await visit('');
    const app = await v.find('control');
    await app.waitForFunction(() => __xy.firstFrameAt !== null);
    result.firstPictureMs = await app.evaluate(() => __xy.firstFrameAt);
    result.startMarks = await app.evaluate(() => __xy.timing().marks);
    if (process.env.XY_SCOPE_MARKS) { console.log(JSON.stringify(result.startMarks)); return; }
    // Software GL needs over a second just to compile the beam shaders; a GPU takes a few hundred milliseconds in all.
    assert(result.firstPictureMs < (process.env.XY_SCOPE_GPU ? 1000 : 4000), 'the figure shows within a second of the App starting: ' + result.firstPictureMs);
    await v.page.waitForTimeout(1200);
    result.trace = await app.evaluate(() => __xy.trace);
    const opened = await probe(app);
    result.deviceFps = await fps(app);
    assert.equal(opened.source, 'analytic'); assert(opened.samples * result.deviceFps > 40000 && opened.rmsL > 0.1, 'a full figure is drawn before any sound: ' + JSON.stringify(opened));
    assert.deepEqual(await state(app), {mode: 'synth', pitchHz: 110, ratio: 1.5, free: false, drift: 0.1, shape: 0, spin: 0, decay: 1.5, glow: 0.35, colour: 'Green', holding: false, page: 'Tone', ghost: false});
    assert.equal(await v.page.evaluate(() => __host.peak), 0, 'nothing sounds on opening');
    assert.deepEqual(v.prompts, []);
    for (const frame of v.page.frames()) assert.deepEqual(await frame.evaluate(() => window.__asked || []).catch(() => []), [], 'no microphone or camera request');
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'device-open.png')});

    /* ---- first key: the picture hands over to the samples being heard ---- */
    await v.page.keyboard.press('Shift');
    await v.page.waitForFunction(() => document.body.dataset.output === 'panel', null, {timeout: 30000}); await v.settled();
    const out = await v.find('output');
    const before = await view(app);
    await v.key(1);
    await app.waitForFunction(() => __xy.probe().source === 'audio', null, {timeout: 8000});
    await v.page.waitForTimeout(700);
    const after = await view(app), timing = await app.evaluate(() => { const t = __xy.timing(); delete t.frames; return t; });
    // The engine's state runs ahead of the screen by the display delay; tumble moves at den x drift turns a second.
    result.handoverTurn = turns(after.signal.tumble - before.signal.tumble - 2 * 0.1 * (after.wall - before.wall + timing.displayDelayMs) / 1000);
    assert(Math.abs(result.handoverTurn) < 0.02, 'the figure keeps its view across the hand-over: ' + result.handoverTurn);
    const held = await probe(app);
    assert.equal((await state(app)).holding, true); assert(held.rmsL > 0.2 && held.rmsR > 0.2, JSON.stringify(held));
    assert(await v.page.evaluate(() => __host.peak) > 0.3, 'the host output carries the tone');
    result.hostPeak = await v.page.evaluate(() => __host.peak); assert(result.hostPeak <= 0.5012, 'at most -6 dBFS: ' + result.hostPeak);
    result.timing = timing;

    /* ---- ratio: picture and pitch change together, whole-number ratios are exact ---- */
    await v.control('encoders', 2).click(); await v.page.waitForTimeout(150);   // E3 press: no drift
    assert.equal((await state(app)).drift, 0);
    result.ratios = {};
    await until(app, () => __xy.state().ratio === 1, '1:1', () => v.turn(1, -1));
    for (const [name, wanted] of [['1:1', 1], ['3:2', 1.5], ['2:1', 2], ['4:1', 4]]) {
      await until(app, new Function('return __xy.state().ratio===' + wanted), name, () => v.turn(1, 1));
      await v.page.waitForTimeout(900);
      const p = await probe(app); result.ratios[name] = p.fy / p.fx;
      assert(Math.abs(p.fy / p.fx / wanted - 1) < 0.01, name + ' is heard and drawn as ' + p.fy / p.fx);
      const a = await view(app); await v.page.waitForTimeout(500); const b = await view(app);
      assert(Math.abs(turns(b.signal.tumble - a.signal.tumble)) < 1e-6, name + ' rests with no drift');
      if (['1:1', '2:1', '3:2'].includes(name)) await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'figure-' + name.replace(':', '-') + '.png')});
      if (name === '2:1') await v.page.locator('#outputScreen').screenshot({path: path.join(OUT, 'output-2-1.png')});
    }
    result.monitor = await v.page.evaluate(() => [...document.querySelectorAll('[data-hardware] button')].map(b => (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\s+/g, ' ')).slice(0, 8));

    /* ---- the output: the same figure, nothing else ---- */
    assert.equal(await out.evaluate(() => document.body.innerText.trim()), '', 'the output shows no text');
    assert.equal(await out.evaluate(() => [...document.querySelectorAll('header,footer,.cross')].some(e => getComputedStyle(e).display !== 'none')), false, 'no labels or scale on the output');
    await v.turn(2, 30); await v.page.waitForTimeout(1500);   // some drift, so the views must agree in motion
    const pair = await Promise.all([view(app), view(out)]);
    // The engine is ahead of both screens by the display delay; bring both to the same wall time.
    const den = 1, drift = (await state(app)).drift;
    result.outputTurnGap = turns(pair[1].signal.tumble - pair[0].signal.tumble + den * drift * (timing.displayDelayMs - (pair[1].wall - pair[0].wall)) / 1000);
    assert(Math.abs(result.outputTurnGap) < 0.03, 'the output shows the device view: ' + result.outputTurnGap + ' ' + drift);
    const outProbe = await probe(out), devProbe = await probe(app);
    assert(Math.abs(outProbe.fy / outProbe.fx - devProbe.fy / devProbe.fx) < 0.01 && Math.abs(outProbe.rmsL - devProbe.rmsL) < 0.03, JSON.stringify([outProbe, devProbe]));
    const f0 = await out.evaluate(() => __xy.timing().frames.length);
    result.outputTrace = await out.evaluate(() => __xy.trace);

    /* ---- strike: sound and picture die away together within Decay ---- */
    await v.control('encoders', 2).click(); await v.key(1); await v.page.waitForTimeout(400);   // no drift, hold off
    assert.equal((await state(app)).holding, false);
    const quiet = await probe(app); assert(quiet.rmsL < 1e-4 && quiet.rmsR < 1e-4, 'hold off is silent: ' + JSON.stringify(quiet));
    const decay = (await state(app)).decay, keyBox = await v.control('keys', 2).boundingBox();
    await v.page.evaluate(() => __host.reset());
    await v.page.mouse.move(keyBox.x + keyBox.width / 2, keyBox.y + keyBox.height / 2); await v.page.mouse.down(); await v.page.waitForTimeout(250);
    const struck = await Promise.all([probe(app), probe(out)]);
    assert(struck[0].rmsL > 0.2 && struck[1].rmsL > 0.2, 'a strike sounds and shows at once, on both screens: ' + JSON.stringify(struck));
    await v.page.mouse.up(); await v.page.waitForTimeout(decay * 1000 + 200);
    const died = await Promise.all([probe(app), probe(out)]), heardNow = await v.page.evaluate(() => __host.recent[__host.recent.length - 1]);
    result.strike = {decay, drawnRmsAfter: died[0].rmsL, outputRmsAfter: died[1].rmsL, heardPeakAfter: heardNow.peak};
    assert(died[0].rmsL < 0.25 * 2e-3 && died[1].rmsL < 0.25 * 2e-3 && heardNow.peak < 0.5 * 2e-3, 'after Decay the strike is gone from the screen, the output and the sound: ' + JSON.stringify(result.strike));

    /* ---- with nothing sounding, the figure stays as a faint preview on both screens; the samples stay silent ---- */
    // How wide the lit part of a picture is (as a share of its width) and how much light there is in all (mean
    // brightness, 0..255). The device's beam canvas is read in the frame right after the App drew it (the device
    // screen carries labels over it); the output is a plain picture and is measured from a screenshot.
    const seen = async frame => frame === app
      ? frame.evaluate(() => new Promise(resolve => {
        // A frame in which the browser has already taken the picture away reads as black: look again, a few times.
        let tries = 0;
        const look = () => {
          const canvas = document.getElementById('beam'), copy = document.createElement('canvas'), width = copy.width = canvas.width, height = copy.height = canvas.height;
          const g = copy.getContext('2d'); g.drawImage(canvas, 0, 0);
          const d = g.getImageData(0, 0, width, height).data;
          let x0 = width, x1 = 0, sum = 0;
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const value = Math.max(d[4 * (y * width + x)], d[4 * (y * width + x) + 1], d[4 * (y * width + x) + 2]); sum += value; if (value > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; } }
          if (sum || ++tries > 30) resolve({wide: Math.max(0, x1 - x0) / width, light: Math.round(sum / (width * height) * 100) / 100});
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      }))
      : v.page.evaluate(async url => {
        const image = new Image(); image.src = url; await image.decode();
        const copy = document.createElement('canvas'), width = copy.width = image.naturalWidth, height = copy.height = image.naturalHeight;
        const g = copy.getContext('2d'); g.drawImage(image, 0, 0);
        const d = g.getImageData(0, 0, width, height).data;
        let x0 = width, x1 = 0, sum = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const value = Math.max(d[4 * (y * width + x)], d[4 * (y * width + x) + 1], d[4 * (y * width + x) + 2]); sum += value; if (value > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; } }
        return {wide: Math.max(0, x1 - x0) / width, light: Math.round(sum / (width * height) * 100) / 100};
      }, 'data:image/png;base64,' + (await frame.locator('#beam').screenshot()).toString('base64'));
    await v.page.evaluate(() => __host.reset()); await v.page.waitForTimeout(1300);
    const faint = {device: await seen(app), output: await seen(out), probes: await Promise.all([probe(app), probe(out)]), heardPeak: await v.page.evaluate(() => __host.peak)};
    assert.deepEqual([(await state(app)).ghost, (await state(out)).ghost], [true, true], 'the faint preview is on, on both screens');
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'faint-preview.png')});
    await v.key(1); await app.waitForFunction(() => __xy.state().holding && __xy.probe().rmsL > 0.2, null, {timeout: 8000}); await v.page.waitForTimeout(500);
    faint.held = {device: await seen(app), output: await seen(out), ghost: [(await state(app)).ghost, (await state(out)).ghost]};
    await v.key(1); await v.page.waitForTimeout(400);
    result.faint = faint;
    assert(faint.device.wide > 0.3 && faint.output.wide > 0.15, 'the preview shows the whole figure, not a dot: ' + JSON.stringify(faint));
    for (const screen of ['device', 'output']) assert(faint[screen].light > faint.held[screen].light * 0.04 && faint[screen].light < faint.held[screen].light * 0.5, 'the preview is clearly fainter than the sounding figure, and can be seen: ' + JSON.stringify(faint));
    assert(faint.probes.every(q => q.rmsL < 2e-3 && q.rmsR < 2e-3) && faint.heardPeak < 2e-3, 'the preview is not in the samples or the sound: ' + JSON.stringify(faint));
    assert.deepEqual(faint.held.ghost, [false, false], 'a sounding figure is drawn at full light');

    /* ---- no clicks: fast turns of pitch, ratio and drift, and hold on and off ---- */
    await v.key(1); await v.page.waitForTimeout(300); await v.page.evaluate(() => __host.reset()); await app.evaluate(() => __tap.reset());
    for (let i = 0; i < 4; i++) { await v.turn(0, 36); await v.turn(1, 9); await v.turn(2, 60); await v.turn(0, -30); await v.turn(1, -9); await v.turn(2, -90); await v.key(1); await v.key(1); }
    await v.page.waitForTimeout(300);
    // A full-scale sine at the highest pitch here (A4 x 4:1 + 2 Hz) moves at most this far between two samples. The
    // engine's stream is what the App answers for; the host output is reported too (a starved test machine can drop
    // one of the host's 20 ms blocks, which is heard as a gap and is not the App's doing).
    const engineStream = await app.evaluate(() => ({step: __tap.step, breaks: __tap.breaks}));
    result.largestStep = engineStream.step; result.largestHostStep = await v.page.evaluate(() => __host.step); const steepest = 2 * Math.PI * 1762 / 48000 * 0.345;
    assert.equal(engineStream.breaks, 0, 'the engine posts every frame it plays');
    if (process.env.XY_SCOPE_DEBUG) console.log('STEP', JSON.stringify(await v.page.evaluate(() => ({nodes: __host.nodes, stepAt: __host.stepAt, blocks: __host.blocks, now: Math.round(performance.now()), dialogs: [...document.querySelectorAll('dialog[open]')].map(d => d.textContent.trim().slice(0, 80))}))), JSON.stringify(await app.evaluate(() => ({notice: document.getElementById('notice').textContent, state: __xy.state(), timing: {...__xy.timing(), frames: undefined, marks: undefined}}))));
    assert(result.largestStep < steepest * 1.05, 'no jump between neighbouring samples: ' + result.largestStep + ' against ' + steepest);

    /* ---- the Motion page, colours, and what is saved (the tone is still held, so each picture shows the figure) ---- */
    await v.key(3); await v.page.waitForTimeout(200);
    assert.equal((await state(app)).page, 'Motion');
    result.colours = [];
    for (let i = 0; i < 40 && result.colours.length < 4; i++) {
      const colour = (await state(app)).colour;
      if (!result.colours.includes(colour)) { result.colours.push(colour); await v.page.waitForTimeout(300); await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'colour-' + colour.toLowerCase() + '.png')}); }
      await v.turn(3, 1);
    }
    assert.deepEqual(result.colours.slice().sort(), ['Amber', 'Green', 'Ice', 'Pink']);
    await v.key(3); await v.page.waitForTimeout(200);

    /* ---- share link: another browser opens the same figure, silent ---- */
    await until(app, () => __xy.state().ratio === 1.25, '5:4', () => v.turn(1, (0, 1)));
    await v.control('encoders', 2).click(); await v.turn(3, 20); await v.page.waitForTimeout(1500);
    const mine = await state(app), mineView = await view(app), link = new URL(v.page.url());
    assert(/^v1\./.test(link.searchParams.get('s') || ''), 'the address carries the figure: ' + link.search);
    result.shareState = link.searchParams.get('s');
    await v.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'figure-5-4.png')});
    await v.key(1); await v.page.waitForTimeout(200);
    const w = await visit('&s=' + encodeURIComponent(result.shareState)), theirs = await w.find('control');
    await theirs.waitForFunction(() => __xy.firstFrameAt !== null); await w.page.waitForTimeout(800);
    const got = await state(theirs), gotView = await view(theirs);
    for (const key of ['pitchHz', 'ratio', 'free', 'drift', 'shape', 'spin', 'glow', 'colour']) assert.equal(got[key], mine[key], 'the link restores ' + key);
    assert.equal((await probe(theirs)).source, 'analytic'); assert.equal(await w.page.evaluate(() => __host.peak), 0, 'a shared figure opens silent');
    result.shareTurnGap = turns(gotView.signal.tumble - mineView.signal.tumble); assert(Math.abs(result.shareTurnGap) < 0.011, 'the link restores the view: ' + result.shareTurnGap);
    await w.page.locator('#stageDevice').screenshot({path: path.join(OUT, 'shared.png')});
    const bad = await visit('&s=v1.99.zz'), fallback = await bad.find('control'); await fallback.waitForFunction(() => __xy.firstFrameAt !== null);
    assert.equal((await state(fallback)).pitchHz, 110, 'an unreadable link opens with the defaults');
    await bad.context.close(); await w.context.close(); await v.context.close();

    /* ---- output formats: the figure keeps its proportions ---- */
    result.formats = {};
    for (const ratio of ['16:9', '9:16', '21:9', '4:3']) {
      const o = await visit('&s=v1.45.r0.0.0.0.35.0.25', {ratio, size: 0});
      await o.page.keyboard.press('Shift');
      await o.page.waitForFunction(() => document.body.dataset.output === 'panel', null, {timeout: 30000}); await o.settled();
      const picture = await o.find('output'); await picture.waitForFunction(() => __xy.probe().samples > 0, null, {timeout: 10000}); await o.page.waitForTimeout(900);
      assert.equal(await picture.evaluate(() => document.body.innerText.trim()), '');
      // 1:1 at the open view is a circle: measure the lit area's width and height on a screenshot of the picture.
      const file = path.join(OUT, 'output-' + ratio.replace(':', 'x') + '.png');
      await o.page.locator('#outputScreen').screenshot({path: file});
      // (The panel's own resize corner is left out: 28 px at each edge.)
      const shape = await o.page.evaluate(async url => { const image = new Image(); image.src = url; await image.decode(); const w = image.naturalWidth, h = image.naturalHeight, copy = document.createElement('canvas'); copy.width = w; copy.height = h; const g = copy.getContext('2d'); g.drawImage(image, 0, 0); const d = g.getImageData(0, 0, w, h).data; let x0 = w, x1 = 0, y0 = h, y1 = 0; for (let y = 28; y < h - 28; y++) for (let x = 28; x < w - 28; x++) if (d[4 * (y * w + x) + 1] > 90) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return {w, h, wide: x1 - x0, tall: y1 - y0, cx: (x0 + x1) / 2 / w, cy: (y0 + y1) / 2 / h}; }, 'data:image/png;base64,' + fs.readFileSync(file).toString('base64'));
      shape.css = await picture.evaluate(() => [innerWidth, innerHeight]); shape.canvas = await picture.evaluate(() => [document.querySelector('canvas').width, document.querySelector('canvas').height]);
      result.formats[ratio] = shape;
      const wanted = ratio.split(':').reduce((a, b) => a / b);
      assert(Math.abs(shape.css[0] / shape.css[1] / wanted - 1) < 0.03, ratio + ' panel: ' + JSON.stringify(shape));
      assert(shape.wide > 40 && Math.abs(shape.wide / shape.tall - 1) < 0.03, ratio + ': the circle stays a circle: ' + JSON.stringify(shape));
      assert(Math.abs(shape.cx - 0.5) < 0.02 && Math.abs(shape.cy - 0.5) < 0.02, ratio + ': the figure is centred: ' + JSON.stringify(shape));
      await o.context.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify(result, null, 1));
    console.log('PASS XY Scope in the Playground: silent first picture, hand-over, exact ratios, strike decay, no sample jumps, output, formats and share link. Screenshots in ' + OUT + '. Acoustic output and real-device timing are not simulated evidence.');
  } finally { await playground.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
