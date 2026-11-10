// Hit Shapes in the real Playground page (see hit_shapes_playground.cjs): the picture's rules measured on the stage
// itself, then the App driven through the Playground's knobs, keys, device screen and output screen.
//   node tests/hit_shapes_browser.cjs            checks; prints measurements as JSON
//   HIT_SHAPES_SHOTS=/tmp/dir node tests/...      also saves screenshots (patterns, colours, output shapes)
//   HIT_SHAPES_GPU=1 node tests/...               use the machine's GPU instead of software GL (frame rates)
//   HIT_SHAPES_ORIGIN=https://host node tests/... a deployed Playground and the published App, not this working tree
const fs = require('node:fs'), path = require('node:path');
const {start, assert, SLUG} = require('./hit_shapes_playground.cjs');
const SHOTS = process.env.HIT_SHAPES_SHOTS || '';
const SIZES = {'16:9': [1920, 1080], '9:16': [1080, 1920], '21:9': [2520, 1080], '4:3': [1440, 1080], device: [468, 324]};

// Runs inside the App: see hit_shapes_measure.js.
const SIMULATE = fs.readFileSync(path.join(__dirname, 'hit_shapes_measure.js'), 'utf8');
const FULL = Object.fromEntries(['BD', 'SD', 'CH', 'OH', 'CP', 'LT', 'RS', 'CB'].map(id => [id, 'X'.repeat(16)]));
const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

(async () => {
  const pg = await start();
  const {page} = pg, result = {};
  const shot = async (name, locator = '#outputScreen') => { if (SHOTS) { fs.mkdirSync(SHOTS, {recursive: true}); await page.locator(locator).screenshot({path: path.join(SHOTS, name + '.png')}); } };
  try {
    // Nothing asks for a permission, and nothing but this host is contacted.
    await pg.context.addInitScript(() => {
      window.permissionAsks = 0;
      const count = (object, name) => { const native = object?.[name]; if (native) object[name] = function (...args) { window.permissionAsks++; return native.apply(this, args); }; };
      count(navigator.mediaDevices, 'getUserMedia'); count(navigator.mediaDevices, 'getDisplayMedia'); count(globalThis.Notification, 'requestPermission');
      count(navigator, 'requestMIDIAccess'); count(navigator.permissions, 'request'); count(globalThis.DeviceMotionEvent, 'requestPermission');
      if (window === top) { // the host's playback of App sound: what leaves the Playground, and when
        const Native = AudioWorkletNode;
        window.outputMeters = []; window.outputTaps = []; window.onsets = []; window.outputClock = null;
        window.AudioWorkletNode = class extends Native {
          constructor(ctx, name, options) {
            super(ctx, name, options);
            if (options?.processorOptions?.mode !== 'playback') return;
            const meter = ctx.createAnalyser(); meter.fftSize = 2048; this.connect(meter); outputMeters.push(meter);
            // The wall-clock moment each sound after a silence reaches the speaker: its exact sample, placed on the
            // output device's clock (getOutputTimestamp includes the device's own latency).
            const tap = ctx.createScriptProcessor(256, 1, 1), mute = ctx.createGain();
            let quiet = 1e9;
            outputTaps.push(tap, mute); // held, or the browser may collect the tap
            tap.onaudioprocess = event => {
              const pcm = event.inputBuffer.getChannelData(0);
              for (let i = 0; i < pcm.length; i++) {
                if (Math.abs(pcm[i]) < 0.004) { quiet++; continue; }
                if (quiet > ctx.sampleRate * 0.15) {
                  const stamp = ctx.getOutputTimestamp(), heard = stamp.performanceTime + (event.playbackTime + i / ctx.sampleRate - stamp.contextTime) * 1000;
                  onsets.push(heard + Date.now() - performance.now());
                }
                quiet = 0;
              }
              window.outputClock = {outputLatency: ctx.outputLatency, baseLatency: ctx.baseLatency, sinkId: typeof ctx.sinkId === 'string' ? ctx.sinkId : ctx.sinkId?.type};
            };
            mute.gain.value = 0; this.connect(tap); tap.connect(mute); mute.connect(ctx.destination);
          }
        };
        window.loudest = () => Math.max(0, ...outputMeters.map(meter => { const pcm = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(pcm); return pcm.reduce((peak, v) => Math.max(peak, Math.abs(v)), 0); }));
      }
    });
    const opened = Date.now();
    let {control, output} = await pg.open();
    result.package = {bytes: pg.fx.size, files: pg.fx.files.map(file => [file.path, file.size])};
    assert(pg.fx.size <= 500000, 'the package is at most 0.5 MB: ' + pg.fx.size);
    assert.deepEqual(pg.fx.manifest.capabilities, {controls: true, audio_output: true});
    await control.evaluate(SIMULATE);

    /* ---------- the picture's rules, measured on the stage ---------- */
    // The same loop draws the same frames: Score closes its lanes and opens them again over eight bars, so bar 2 and
    // bar 10 are the same pixel for pixel, at several moments in the bar.
    result.loopFramesCompared = await control.evaluate(([width, height]) => {
      const run = simulate({width, height, rows: {BD: 'X..x..x.X...x.x.', SD: '....X..x....X...', CH: 'x.xxx.xxX.xxx.xx', OH: '.x...x...X...x..', CP: '....x.......X...', LT: '......x......xX.', RS: '..x......x......', CB: 'X..x..x..x..x...'}, swing: 0.16, loops: 12});
      const moments = [0, 20, 61, 125, 333, 700, 1001, 1500, 1990], second = moments.map(at => run.pixels(16 * run.stepMs + at).slice());
      moments.forEach((at, k) => {
        const third = run.pixels(144 * run.stepMs + at);
        for (let i = 0; i < third.length; i++) if (second[k][i] !== third[i]) throw new Error('bar 2 and bar 10 differ ' + at + ' ms into the bar');
        if (k && second[k].every((v, i) => v === second[0][i])) throw new Error('the picture does not move');
      });
      return moments.length;
    }, [960, 540]);

    // Orbit repeats with its sixteen-bar opening and closing, Weave with its pair of four-bar phrases.
    result.styleFramesCompared = await control.evaluate(() => {
      const rows = {BD: 'X..x..x.X...x.x.', SD: '....X..x....X...', CH: 'x.xxx.xxX.xxx.xx', OH: '.x...x...X...x..', CP: '....x.......X...', LT: '......x......xX.', RS: '..x......x......', CB: 'X..x..x..x..x...'};
      let compared = 0;
      for (const [style, first, period] of [[1, 17, 16], [2, 10, 8]]) {
        const run = simulate({width: 640, height: 360, rows, style, swing: 0.08, loops: first + period + 2});
        const moments = [0, 40, 700, 1300], before = moments.map(at => run.pixels(first * 16 * run.stepMs + at).slice());
        moments.forEach((at, k) => {
          const after = run.pixels((first + period) * 16 * run.stepMs + at);
          for (let i = 0; i < after.length; i++) if (before[k][i] !== after[i]) throw new Error(STYLES[style] + ' differs ' + period + ' bars on, ' + at + ' ms into the bar');
          if (k && before[k].every((v, i) => v === before[0][i])) throw new Error(STYLES[style] + ' does not move');
          compared++;
        });
        const next = run.pixels((first + period + 1) * 16 * run.stepMs);
        if (before[0].every((v, i) => v === next[i])) throw new Error(STYLES[style] + ' does not move on from bar to bar');
      }
      return compared;
    });

    // Every screen shape: the kick stays a circle and nothing is stretched; an upright screen uses two rows of steps.
    result.shapes = {};
    for (const [name, [width, height]] of Object.entries(SIZES)) {
      const kick = await control.evaluate(([w, h]) => { const run = simulate({width: w, height: h, rows: {BD: '....X...........'}, playing: false}); return {...blob(run.pixels(0), w, PALETTES[0].colors[0], 100), rows: run.sim.columns().rows}; }, [width, height]);
      assert(kick.count > 50 && Math.abs(kick.width - kick.height) <= 2, name + ': the kick is round: ' + JSON.stringify(kick));
      assert.equal(kick.rows, width < height ? 2 : 1, name + ' rows');
      result.shapes[name] = {kick: [kick.width, kick.height], rows: kick.rows, kickShare: round(kick.share, 4)};
    }

    // Tune moves a voice up and down; Decay keeps its shape longer; a muted voice leaves the picture.
    const kickAt = options => control.evaluate(o => { const run = simulate({width: 960, height: 540, rows: {BD: '....x...........'}, loops: 1, ...o}); return blob(run.pixels(4 * run.stepMs + (o.after || 0)), 960, PALETTES[0].colors[0], 150); }, options);
    const [low, flat, high] = [await kickAt({tune: {BD: -12}}), await kickAt({}), await kickAt({tune: {BD: 12}})];
    assert(high.centerY < flat.centerY - 30 && low.centerY > flat.centerY + 30, 'a higher pitch sits higher: ' + [high.centerY, flat.centerY, low.centerY]);
    const [short, normal, long] = [await kickAt({decay: {BD: 0}, after: 300}), await kickAt({after: 300}), await kickAt({decay: {BD: 100}, after: 300})];
    assert(short.count < normal.count && normal.count < long.count, 'a longer decay keeps a larger shape: ' + [short.count, normal.count, long.count]);
    assert.equal((await kickAt({mutes: 1})).count, 0, 'a muted voice is not drawn');
    result.tuneCenterY = [high.centerY, flat.centerY, low.centerY].map(v => round(v, 1)); result.decayPixels = [short.count, normal.count, long.count];

    // A kick shoves the shapes near it aside: the clap two steps on is flung somewhere else than it would be without
    // the kick, and is back where it belongs well within a second.
    result.shovePx = await control.evaluate(() => {
      const out = {};
      for (const style of [0, 1, 2]) {
        const clap = (mutes, after) => { const run = simulate({width: 960, height: 540, rows: {BD: '....x...........', CP: '......x.........'}, style, mutes, loops: 1}); return blob(run.pixels(4 * run.stepMs + after), 960, PALETTES[0].colors[3], 60); };
        const moved = after => { const alone = clap(1, after), shoved = clap(0, after); return Math.round(Math.hypot(shoved.centerX - alone.centerX, shoved.centerY - alone.centerY) * 10) / 10; };
        out[STYLES[style]] = [moved(60), moved(900)];
      }
      return out;
    });
    for (const [name, [during, later]] of Object.entries(result.shovePx)) assert(during > 5 && during < 40 && later < 0.5, name + ': a kick shoves its neighbours aside and they come back: ' + [during, later]);
    // Score moves on too: four bars in, its lanes have closed toward the middle of the row and its shapes are larger.
    const clapIn = bar => control.evaluate(n => { const run = simulate({width: 960, height: 540, rows: {CP: '....x...........'}, loops: n + 1}); return blob(run.pixels((n * 16 + 8) * run.stepMs), 960, PALETTES[0].colors[3], 60); }, bar);
    const [open, closed] = [await clapIn(0), await clapIn(4)];
    assert(closed.centerY > open.centerY + 30 && closed.count > open.count * 1.3, 'Score closes its lanes: ' + JSON.stringify([open, closed]));
    result.scoreFoldCenterY = [open.centerY, closed.centerY].map(v => round(v, 1));

    // The knobs change the whole picture, not only their voice. With two other voices tuned all the way up, a clap that
    // was not touched sits higher toward the right of Score and Weave and rises off Orbit's hub; with their decays
    // long every trace is larger, and with them short, smaller. (Weave's rows leave the top of the screen as they
    // rise, so the middle of all its claps moves less one way than the other.)
    result.knobs = await control.evaluate(() => {
      const out = {};
      for (const style of [0, 1, 2]) {
        const clap = o => blob(simulate({width: 960, height: 540, rows: {CP: '..............x.'}, style, playing: false, ...o}).pixels(1000), 960, PALETTES[0].colors[3], 60);
        const plain = clap({}), up = clap({tune: {BD: 12, SD: 12}}), down = clap({tune: {BD: -12, SD: -12}}), long = clap({decay: {BD: 100, SD: 100}}), short = clap({decay: {BD: 0, SD: 0}});
        out[STYLES[style]] = {leanUpPx: Math.round(plain.centerY - up.centerY), leanDownPx: Math.round(down.centerY - plain.centerY), long: Math.round(long.count / plain.count * 100) / 100, short: Math.round(short.count / plain.count * 100) / 100};
      }
      return out;
    });
    for (const [name, knob] of Object.entries(result.knobs)) assert(knob.leanUpPx > 8 && knob.leanDownPx > 8 && knob.leanUpPx + knob.leanDownPx > 40 && knob.long > 1.3 && knob.short < 0.75, name + ': Tune and Decay change the whole picture: ' + JSON.stringify(knob));

    // Photosensitivity: 240 BPM with every step of every voice accented, each palette, each screen shape, then other
    // dense patterns. Less than a quarter of the picture may flash more than three times a second, and a quarter of the
    // picture may change at once at most three times a second.
    result.flashing = {};
    for (const [name, [width, height]] of Object.entries(SIZES)) for (let theme = 0; theme < 3; theme++) {
      const scale = 480 / Math.max(width, height);
      const measured = await control.evaluate(o => flashing(o), {width: Math.round(width * scale), height: Math.round(height * scale), rows: FULL, bpm: 240, theme});
      result.flashing[name + ' palette ' + theme] = Object.fromEntries(Object.entries(measured).map(([key, value]) => [key, round(value)]));
      assert(measured.fast < 0.25 && measured.bursts <= 3, name + ' palette ' + theme + ': ' + JSON.stringify(measured));
    }
    // Every voice has a second shape: choosing it changes that voice's picture in every style, and with all eight chosen
    // the picture is as safe to watch.
    result.otherShapes = await control.evaluate(() => {
      const out = {};
      SHAPES.forEach(({id}, v) => {
        out[id] = [0, 1, 2].map(style => {
          const shot = alt => simulate({width: 480, height: 270, rows: {[id]: 'x...X...x...x...'}, style, alt, playing: false}).pixels(1000).slice();
          const first = shot(0), other = shot(1 << v);
          let n = 0;
          for (let i = 0; i < first.length; i += 4) if (Math.abs(first[i] - other[i]) + Math.abs(first[i + 1] - other[i + 1]) + Math.abs(first[i + 2] - other[i + 2]) > 60) n++;
          return n;
        });
      });
      return out;
    });
    for (const [id, changed] of Object.entries(result.otherShapes)) assert(changed.every(n => n >= 40), id + ' has a second shape in every style: ' + changed);
    for (const style of [0, 1, 2]) for (const [label, rows, bpm] of [['every step', FULL, 240], ['every fourth step', Object.fromEntries(Object.keys(FULL).map(id => [id, 'X...'.repeat(4)])), 180]]) for (const [name, [width, height]] of [['16:9', SIZES['16:9']], ['9:16', SIZES['9:16']]]) {
      const scale = 480 / Math.max(width, height);
      const measured = await control.evaluate(o => flashing(o), {width: Math.round(width * scale), height: Math.round(height * scale), rows, bpm, style, alt: 255});
      const key = ['Score ', 'Orbit ', 'Weave '][style] + 'second shapes, ' + label + ', ' + bpm + ' BPM, ' + name;
      result.flashing[key] = Object.fromEntries(Object.entries(measured).map(([k, value]) => [k, round(value)]));
      assert(measured.fast < 0.25 && measured.bursts <= 3, key + ': ' + JSON.stringify(measured));
    }
    // The kick's shove at full strength: roomy patterns of large shapes at tempos where every kick shoves all the way
    // or nearly, with long decays, on a wide and an upright screen.
    const ROOMY = {
      'halves': {BD: 'X...X...X...X...', SD: 'x.x.x.x.x.x.x.x.', CP: 'x.x.x.x.x.x.x.x.', LT: 'x.x.x.x.x.x.x.x.', OH: 'x.x.x.x.x.x.x.x.', CB: 'x...x...x...x...'},
      'off the beat': Object.fromEntries(Object.keys(FULL).map(id => [id, id === 'BD' ? 'X...X...X...X...' : '..x...x...x...x.'])),
    };
    for (const style of [0, 1, 2]) for (const [label, rows] of Object.entries(ROOMY)) for (const bpm of [120, 150]) for (const [name, [width, height]] of [['16:9', SIZES['16:9']], ['9:16', SIZES['9:16']]]) {
      const scale = 480 / Math.max(width, height);
      const measured = await control.evaluate(o => flashing(o), {width: Math.round(width * scale), height: Math.round(height * scale), rows, bpm, style, decay: Object.fromEntries(Object.keys(FULL).map(id => [id, 100]))});
      const key = ['Score ', 'Orbit ', 'Weave '][style] + 'kick shoving, ' + label + ', ' + bpm + ' BPM, ' + name;
      result.flashing[key] = Object.fromEntries(Object.entries(measured).map(([k, value]) => [k, round(value)]));
      assert(measured.fast < 0.25 && measured.bursts <= 3, key + ': ' + JSON.stringify(measured));
    }
    // The knobs at their ends: every voice tuned all the way and every decay long, on every beat and on every step.
    for (const style of [0, 1, 2]) for (const [label, rows, bpm] of [['every fourth step at 200 BPM', Object.fromEntries(Object.keys(FULL).map(id => [id, 'X...'.repeat(4)])), 200], ['every step', FULL, 240]]) for (const [name, [width, height]] of [['16:9', SIZES['16:9']], ['9:16', SIZES['9:16']]]) {
      const scale = 480 / Math.max(width, height), all = value => Object.fromEntries(Object.keys(FULL).map(id => [id, value]));
      const measured = await control.evaluate(o => flashing(o), {width: Math.round(width * scale), height: Math.round(height * scale), rows, bpm, style, tune: all(-12), decay: all(100)});
      const key = ['Score ', 'Orbit ', 'Weave '][style] + label + ', long and low, ' + name;
      result.flashing[key] = Object.fromEntries(Object.entries(measured).map(([k, value]) => [k, round(value)]));
      assert(measured.fast < 0.25 && measured.bursts <= 3, key + ': ' + JSON.stringify(measured));
    }
    for (const style of [1, 2]) for (const [name, [width, height]] of Object.entries(SIZES)) {
      const scale = 480 / Math.max(width, height);
      const measured = await control.evaluate(o => flashing(o), {width: Math.round(width * scale), height: Math.round(height * scale), rows: FULL, bpm: 240, style});
      result.flashing[['', 'Orbit ', 'Weave '][style] + name] = Object.fromEntries(Object.entries(measured).map(([key, value]) => [key, round(value)]));
      assert(measured.fast < 0.25 && measured.bursts <= 3, ['', 'Orbit ', 'Weave '][style] + name + ': ' + JSON.stringify(measured));
    }
    for (const style of [1, 2]) for (const [label, rows, bpm] of [['every fourth step', Object.fromEntries(Object.keys(FULL).map(id => [id, 'X...'.repeat(4)])), 240], ['every fourth step at 180 BPM', Object.fromEntries(Object.keys(FULL).map(id => [id, 'X...'.repeat(4)])), 180], ['kick and snare every step', {BD: FULL.BD, SD: FULL.SD}, 240]]) {
      const measured = await control.evaluate(o => flashing(o), {width: 480, height: 270, rows, bpm, style});
      result.flashing[['', 'Orbit ', 'Weave '][style] + label] = Object.fromEntries(Object.entries(measured).map(([key, value]) => [key, round(value)]));
      assert(measured.fast < 0.25 && measured.bursts <= 3, ['', 'Orbit ', 'Weave '][style] + label + ': ' + JSON.stringify(measured));
    }
    for (const [label, rows, bpm] of [['kick and snare every step', {BD: FULL.BD, SD: FULL.SD}, 240], ['every other step', Object.fromEntries(Object.keys(FULL).map(id => [id, 'X.'.repeat(8)])), 240], ['every fourth step', Object.fromEntries(Object.keys(FULL).map(id => [id, 'X...'.repeat(4)])), 240], ['every fourth step at 180 BPM', Object.fromEntries(Object.keys(FULL).map(id => [id, 'X...'.repeat(4)])), 180], ['full at 200 BPM', FULL, 200]]) {
      const measured = await control.evaluate(o => flashing(o), {width: 480, height: 270, rows, bpm, theme: 0});
      result.flashing[label] = Object.fromEntries(Object.entries(measured).map(([key, value]) => [key, round(value)]));
      assert(measured.fast < 0.25 && measured.bursts <= 3, label + ': ' + JSON.stringify(measured));
    }

    /* ---------- opening ---------- */
    const first = await Promise.all([control, output].map(frame => frame.evaluate(() => ({at: __hitShapes.firstFrameAt, origin: performance.timeOrigin, asks: window.permissionAsks}))));
    result.firstFrameMs = {device: round(first[0].at, 1), output: round(first[1].at, 1), fromLink: Math.round(Math.max(first[0].origin + first[0].at, first[1].origin + first[1].at) - opened)};
    assert(first[0].at > 0 && first[0].at < 1000 && first[1].at > 0 && first[1].at < 1000, 'the first picture is drawn within a second: ' + JSON.stringify(result.firstFrameMs));
    assert.equal(first[0].asks + first[1].asks + await page.evaluate(() => window.permissionAsks), 0, 'no permission is requested');
    if (!pg.live) assert.deepEqual(pg.requests, [], 'nothing outside the host is requested');
    const still = await control.evaluate(() => ({state: __hitShapes.state(), cells: Array.from(state.cells.subarray(0, 128)).join(''), preset: Array.from(presetCells().subarray(0, 128)).join(''), title: document.title}));
    assert.equal(still.state.pattern, 0); assert.equal(still.state.playing, false); assert.equal(still.cells, still.preset, 'it opens on pattern A');
    assert.equal(still.title, pg.fx.manifest.name, 'the name comes from app.json');
    await output.evaluate(SIMULATE);
    const red = frame => frame.evaluate(() => { const c = document.getElementById('picture'); return blob(c.getContext('2d').getImageData(0, 0, c.width, c.height).data, c.width, PALETTES[0].colors[0], 100).share; });
    assert(await red(control) > 0.03 && await red(output) > 0.03, 'the still picture of pattern A, with its four kicks, is on both screens');
    assert.equal(still.state.style, 'Orbit', 'it opens in Orbit');
    await page.waitForTimeout(1200);
    result.silentBeforeStart = await page.evaluate(() => loudest());
    assert(result.silentBeforeStart < 0.001, 'it makes no sound before Start');
    assert.equal(await output.evaluate(() => document.body.innerText.trim()), '', 'the output shows no text');
    await shot('pattern-a'); await shot('device-a', '#stageDevice');

    /* ---------- patterns and colours, stopped ---------- */
    const picture = frame => frame.evaluate(() => { const c = document.getElementById('picture'); return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data); });
    const pictures = [await picture(output)];
    for (const name of ['b', 'c']) {
      await pg.key(3).click(); await page.waitForTimeout(400);
      pictures.push(await picture(output)); await shot('pattern-' + name);
    }
    assert.equal((await control.evaluate(() => __hitShapes.state())).pattern, 2); assert.equal((await output.evaluate(() => __hitShapes.state())).pattern, 2, 'the output follows the pattern');
    const differ = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 60) n++; return n / (a.length / 4); };
    result.patternsDiffer = {ab: round(differ(pictures[0], pictures[1])), ac: round(differ(pictures[0], pictures[2])), bc: round(differ(pictures[1], pictures[2]))};
    assert(Object.values(result.patternsDiffer).every(share => share > 0.12), 'A, B and C are clearly different pictures: ' + JSON.stringify(result.patternsDiffer));
    await pg.key(3).click(); await pg.key(3).click(); await page.waitForTimeout(300); // D, then A again
    assert.equal((await control.evaluate(() => __hitShapes.state())).pattern, 0);
    // K4 held: next style, same pattern. The colour button: next colours.
    const hold = async () => { const box = await pg.key(3).boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.waitForTimeout(750); await page.mouse.up(); await page.waitForTimeout(300); };
    const tap = selector => control.evaluate(s => document.querySelector(s).dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true})), selector);
    for (const name of ['Weave', 'Score']) {
      await hold(); await shot('style-' + name.toLowerCase()); await shot('device-' + name.toLowerCase(), '#stageDevice');
      assert.equal((await control.evaluate(() => __hitShapes.state())).style, name); assert.equal((await output.evaluate(() => __hitShapes.state())).style, name, 'the output takes the style');
    }
    let now = await control.evaluate(() => __hitShapes.state());
    assert.equal(now.pattern, 0, 'holding K4 changes the style, not the pattern');
    await hold(); assert.equal((await control.evaluate(() => __hitShapes.state())).style, 'Orbit');
    for (const name of ['paper', 'pool']) { await tap('#colorChip'); await page.waitForTimeout(300); await shot('colours-' + name); await shot('device-' + name, '#stageDevice'); }
    now = await control.evaluate(() => __hitShapes.state());
    assert.equal(now.theme, 2); assert.equal((await output.evaluate(() => __hitShapes.state())).theme, 2, 'the output takes the colours');
    await tap('#colorChip'); await tap('#styleChip');
    now = await control.evaluate(() => __hitShapes.state());
    assert.deepEqual([now.theme, now.style], [0, 'Weave'], 'the style button is the same as holding K4');
    await tap('#styleChip'); await tap('#styleChip');
    // E1 held: next colours, on the device and on the big screen, and the swing stays (the Playground presses a knob
    // only once the pointer has rested on it a while, hence the long hold). A short press changes the swing
    // and keeps the colours. Neither makes a sound.
    const e1 = async ms => { const box = await pg.encoder(0).boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.waitForTimeout(ms); await page.mouse.up(); await page.waitForTimeout(300); };
    const looks = async () => { const at = await control.evaluate(() => __hitShapes.state()); return [at.theme, at.swing]; };
    const [, swing] = await looks();
    await e1(1300);
    assert.deepEqual(await looks(), [1, swing], 'holding E1 changes the colours and keeps the swing'); assert.equal((await output.evaluate(() => __hitShapes.state())).theme, 1, 'the output takes the colours from E1');
    await e1(1300); await e1(1300);
    assert.deepEqual(await looks(), [0, swing]);
    await e1(100);
    now = await looks();
    assert(now[0] === 0 && now[1] !== swing, 'a short press of E1 changes the swing and keeps the colours: ' + JSON.stringify(now));
    await e1(100); await e1(100); await e1(100);
    assert.deepEqual(await looks(), [0, swing], 'four presses bring the swing round again');
    // K3 held rolls the voice, a hit on every step, and the colours stay; a short press is one hit.
    const byHand = () => control.evaluate(() => __hitShapes.hits().filter(hit => hit.manual).length), handBefore = await byHand();
    const box3 = await pg.key(2).boundingBox(); await page.mouse.move(box3.x + box3.width / 2, box3.y + box3.height / 2); await page.mouse.down(); await page.waitForTimeout(750); await page.mouse.up(); await page.waitForTimeout(300);
    assert.equal((await looks())[0], 0, 'holding K3 keeps the colours');
    result.rolledWhileStopped = (await byHand()) - handBefore;
    assert(result.rolledWhileStopped >= 4 && result.rolledWhileStopped <= 7, 'K3 held for 0.75 s at 120 BPM rolls: ' + result.rolledWhileStopped);
    await page.waitForTimeout(400);
    assert.equal((await byHand()) - handBefore, result.rolledWhileStopped, 'the roll ends when K3 is let go');
    await pg.key(2).click(); await page.waitForTimeout(300);
    assert.equal((await byHand()) - handBefore, result.rolledWhileStopped + 1, 'a short press is one hit');
    // E4 held: the selected voice's other shape, on the device and on the big screen, and its decay stays. Tapping the
    // selected voice again brings the first shape back.
    const shapeOf = async frame => { const at = await frame.evaluate(() => __hitShapes.state()), voice = at.voices.find(v => v.id === 'BD'); return [voice.other, voice.decay]; };
    const e4 = await pg.encoder(3).boundingBox(); await page.mouse.move(e4.x + e4.width / 2, e4.y + e4.height / 2); await page.mouse.down(); await page.waitForTimeout(1300); await page.mouse.up(); await page.waitForTimeout(300);
    assert.deepEqual(await shapeOf(control), [true, 50], 'holding E4 gives the voice its other shape and keeps its decay'); assert.deepEqual(await shapeOf(output), [true, 50], 'the output takes the shape');
    await shot('other-shape'); await shot('device-other-shape', '#stageDevice');
    await tap('#voices .voice:nth-child(1)');
    assert.deepEqual(await shapeOf(control), [false, 50], 'tapping the selected voice again changes its shape back');
    assert.equal(result.silentBeforeStart < 0.001, true);
    await page.waitForTimeout(1300); // the voice played by K3 rings out

    /* ---------- playing ---------- */
    await pg.key(1).click();
    await control.waitForFunction(() => __hitShapes.hits().filter(hit => hit.drawnAt).length >= 40, null, {timeout: 15000});
    await output.waitForFunction(() => __hitShapes.hits().filter(hit => hit.drawnAt).length >= 40, null, {timeout: 15000});
    result.loudWhilePlaying = round(await page.evaluate(() => loudest()));
    assert(result.loudWhilePlaying > 0.01, 'the beat is heard: ' + result.loudWhilePlaying);
    result.sync = {};
    for (const [name, frame] of [['device', control], ['output', output]]) {
      const hits = (await frame.evaluate(() => __hitShapes.hits())).filter(hit => hit.drawnAt), gaps = hits.map(hit => hit.drawnAt - hit.audioTime);
      assert(hits.length >= 40 && gaps.every(gap => Math.abs(gap) <= 33), name + ': every shape is drawn within 33 ms of its sound: ' + JSON.stringify(gaps.map(g => Math.round(g))));
      assert.deepEqual([...new Set(hits.map(hit => hit.voice))].sort(), ['BD', 'CH', 'CP', 'OH'], name + ' draws every voice of pattern A');
      result.sync[name] = {hits: hits.length, minMs: round(Math.min(...gaps), 1), maxMs: round(Math.max(...gaps), 1), meanMs: round(gaps.reduce((a, b) => a + b, 0) / gaps.length, 1)};
    }
    // The output draws a hit at the same moment as the device (same wall clock).
    const wall = frame => frame.evaluate(() => { const shift = Date.now() - performance.now(); return __hitShapes.hits().filter(hit => hit.drawnAt && !hit.manual).slice(-24).map(hit => ({key: hit.voice + hit.step, heard: hit.audioTime + shift, drawn: hit.drawnAt + shift})); });
    const [deviceWall, outputWall] = [await wall(control), await wall(output)];
    const apart = outputWall.map(hit => [hit, deviceWall.find(other => other.key === hit.key && Math.abs(other.heard - hit.heard) < 5)]).filter(([, other]) => other).map(([hit, other]) => hit.drawn - other.drawn);
    assert(apart.length >= 8 && apart.every(gap => Math.abs(gap) <= 33), 'device and output draw a hit together: ' + JSON.stringify(apart.map(g => Math.round(g))));
    result.sync.outputAfterDeviceMs = {min: round(Math.min(...apart), 1), max: round(Math.max(...apart), 1)};
    await shot('playing'); await shot('device-playing', '#stageDevice');
    // Frame rates while playing: frames per second and the longest wait between two frames, over two seconds.
    const rate = frame => frame.evaluate(() => new Promise(resolve => {
      const stamps = [], began = __hitShapes.frames;
      const tick = now => { stamps.push(now); if (now - stamps[0] < 2000) requestAnimationFrame(tick); else resolve({fps: Math.round((__hitShapes.frames - began) / (now - stamps[0]) * 10000) / 10, longestMs: Math.round(Math.max(...stamps.slice(1).map((t, i) => t - stamps[i])) * 10) / 10}); };
      requestAnimationFrame(tick);
    }));
    result.fps = {device: await rate(control), output: await rate(output)};
    assert(result.fps.device.fps >= 55 && result.fps.output.fps >= 50, 'both screens keep their frame rate: ' + JSON.stringify(result.fps));

    // E2 selects, E2 press mutes: the voice leaves both screens. E3 tunes, E4 changes decay, a press resets.
    await pg.encoder(1).click(); await page.waitForTimeout(1300);
    now = await control.evaluate(() => __hitShapes.state());
    assert.equal(now.voices[0].mute, true); assert.equal(await red(control), 0, 'the muted kick leaves the device picture'); assert.equal(await red(output), 0, 'and the output');
    await pg.encoder(1).click(); await page.waitForTimeout(300);
    await pg.turn(2, -60); await pg.turn(3, -60);
    now = await control.evaluate(() => __hitShapes.state());
    assert(now.voices[0].tune > 0 && now.voices[0].decay > 50, 'E3 tunes and E4 lengthens the selected voice: ' + JSON.stringify(now.voices[0]));
    assert.deepEqual((await output.evaluate(() => __hitShapes.state())).voices[0], now.voices[0], 'the output takes tune and decay');
    result.turned = now.voices[0];
    // The knobs reset when they come up, and the Playground cancels a tap whose knob loses the focus before then.
    await pg.encoder(2).click(); await page.waitForTimeout(250); await pg.encoder(3).click(); await page.waitForTimeout(250);
    now = await control.evaluate(() => __hitShapes.state());
    assert.deepEqual([now.voices[0].tune, now.voices[0].decay], [0, 50], 'pressing E3 and E4 resets them');
    await pg.turn(1, -40);
    now = await control.evaluate(() => __hitShapes.state());
    assert.notEqual(now.voice, 'BD', 'E2 selects another voice'); assert.equal((await output.evaluate(() => __hitShapes.state())).voice, now.voice);
    // A pattern chosen while playing waits for the end of the bar.
    await pg.key(3).click();
    assert.equal((await control.evaluate(() => __hitShapes.state())).pattern, 0, 'the pattern does not change mid-bar');
    await control.waitForFunction(() => __hitShapes.state().pattern === 1, null, {timeout: 5000});
    // Touch: a step pad cycles on, accent, off; a voice button selects; the picture plays the voice.
    await tap('#voices .voice:nth-child(6)');
    assert.equal((await control.evaluate(() => __hitShapes.state())).voice, 'LT');
    const cell = () => control.evaluate(() => state.cells[cellIndex(state.pattern, state.sel, 2)]);
    await tap('#steps .step:nth-child(3)'); assert.equal(await cell(), 1); await tap('#steps .step:nth-child(3)'); assert.equal(await cell(), 2);
    await control.waitForFunction(() => __hitShapes.hits().some(hit => hit.voice === 'LT' && hit.step === 2 && hit.accent && hit.drawnAt), null, {timeout: 5000});
    await tap('#steps .step:nth-child(3)'); assert.equal(await cell(), 0);
    // Record starts off: a hit played while the pattern runs only sounds. E3 held switches Record on (the Playground
    // presses a knob only once the pointer has rested on it a while, hence the long hold); then a hit is written into the
    // nearest step, and K3 held rolls, a hit on every step, and those are written too. Undo takes back one press of K3
    // at a time: the Undo button, or E2 held, which leaves the mute as it was.
    const row = frame => frame.evaluate(() => __hitShapes.state().voices[5].steps);
    const count = async () => (await row(control)).replace(/\./g, '').length;
    const tom = async () => { const at = await control.evaluate(() => __hitShapes.state()); return {record: at.record, takes: at.takes, tune: at.voices[5].tune, mute: at.voices[5].mute}; };
    const holdKnob = async index => { const box = await pg.encoder(index).boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.waitForTimeout(1300); await page.mouse.up(); await page.waitForTimeout(300); };
    const start = await tom();
    assert.equal(start.record, false, 'Record starts off');
    await pg.key(2).click(); await page.waitForTimeout(500);
    assert.equal(await count(), 0, 'with Record off a hit is not written');
    assert.equal(await control.evaluate(() => document.querySelector('#undoChip').hidden), true, 'nothing to undo, no Undo button');
    await holdKnob(2);
    assert.deepEqual(await tom(), {...start, record: true}, 'holding E3 switches Record on and keeps the tune');
    await pg.key(2).click(); await page.waitForTimeout(500);
    assert.equal(await count(), 1, 'one hit, one step: ' + await row(control));
    assert.equal(await row(output), await row(control), 'the big screen has the same pattern');
    const k3 = await pg.key(2).boundingBox(); await page.mouse.move(k3.x + k3.width / 2, k3.y + k3.height / 2); await page.mouse.down(); await page.waitForTimeout(900); await page.mouse.up(); await page.waitForTimeout(400);
    result.stepsWrittenByRoll = (await count()) - 1;
    assert(result.stepsWrittenByRoll >= 4 && result.stepsWrittenByRoll <= 9, 'a held K3 rolls on every step and writes them: ' + await row(control));
    assert.equal((await tom()).takes, 2);
    await shot('recording'); await shot('device-recording', '#stageDevice');
    await tap('#undoChip'); await page.waitForTimeout(300);
    assert.equal(await count(), 1, 'Undo takes back the roll and leaves the hit before it: ' + await row(control));
    await holdKnob(1);
    assert.deepEqual([await count(), (await tom()).mute], [0, false], 'holding E2 takes back the hit and leaves the voice unmuted');
    assert.equal(await row(output), '.'.repeat(16), 'the big screen follows the undo');
    assert.equal(await control.evaluate(() => document.querySelector('#undoChip').hidden), true);
    await tap('#recChip'); await page.waitForTimeout(300);
    assert.equal((await tom()).record, false, 'the Record button switches it off');
    await pg.key(2).click(); await page.waitForTimeout(500);
    assert.equal(await count(), 0, 'and hits are no longer written');
    await pg.key(1).click(); await page.waitForTimeout(700);
    assert.equal((await control.evaluate(() => __hitShapes.state())).playing, false);
    // K3 and a tap on the picture play the selected voice while stopped, and draw it.
    const manual = () => control.evaluate(() => __hitShapes.hits().filter(hit => hit.manual && hit.drawnAt).length);
    const before = await manual();
    await pg.key(2).click(); await tap('#picture'); await control.evaluate(() => document.querySelector('#picture').dispatchEvent(new PointerEvent('pointerup', {bubbles: true})));
    await control.waitForFunction(n => __hitShapes.hits().filter(hit => hit.manual && hit.drawnAt).length >= n + 2, before, {timeout: 5000});
    await output.waitForFunction(() => __hitShapes.hits().some(hit => hit.manual && hit.drawnAt), null, {timeout: 5000});
    // Latency: single rim shots by hand (the shortest voice, so each starts from silence), each one's first sample
    // timed at the host's output against the moment the App drew it. The App draws LATENCY_MS after rendering a hit;
    // the measured gap says how far off that is on this machine.
    await tap('#voices .voice:nth-child(7)'); await page.waitForTimeout(600);
    await page.evaluate(() => { onsets.length = 0; });
    for (let i = 0; i < 16; i++) { await control.evaluate(() => hit()); await page.waitForTimeout(430 + i * 7); }
    const heard = await page.evaluate(() => ({onsets, clock: outputClock}));
    const planned = await control.evaluate(() => ({at: __hitShapes.hits().filter(hit => hit.manual).slice(-16).map(hit => hit.audioTime + Date.now() - performance.now()), assumed: LATENCY_MS}));
    const late = planned.at.map(at => heard.onsets.find(onset => Math.abs(onset - at) < 200) - at).filter(Number.isFinite).sort((a, b) => a - b);
    assert(late.length >= 12, 'the rim shots are found at the output: ' + JSON.stringify([heard.onsets.length, planned.at.length]));
    assert(late[0] > -45 && late.at(-1) < 125, 'sound and picture stay within what reads as together (sound up to 45 ms early or 125 ms late): ' + JSON.stringify(late.map(Math.round)));
    result.latency = {assumedMs: planned.assumed, soundAfterPictureMs: {min: round(late[0], 1), median: round(late[late.length >> 1], 1), max: round(late.at(-1), 1)},
      measuredMs: round(planned.assumed + late[late.length >> 1], 1), hostOutputLatencyMs: round((heard.clock?.outputLatency || 0) * 1000, 1), hostBaseLatencyMs: round((heard.clock?.baseLatency || 0) * 1000, 1), sink: heard.clock?.sinkId ?? null, hits: late.length};
    assert.deepEqual(pg.errors, [], 'no page errors');

    /* ---------- the output's shapes ---------- */
    const format = async label => { await page.click('#outputFormat'); await page.locator('.ui-action-popover button', {hasText: new RegExp('^\\s*' + label + '\\s*$')}).first().click(); await page.waitForTimeout(600); };
    result.output = {};
    for (const ratio of ['9:16', '21:9', '4:3', '16:9']) {
      await format(ratio);
      ({output} = await pg.frames());
      const size = await output.evaluate(() => { const c = document.getElementById('picture'); return [innerWidth, innerHeight, c.width, c.height, document.body.innerText.trim()]; });
      const [w, h] = ratio.split(':').map(Number);
      assert(Math.abs(size[0] / size[1] - w / h) < 0.02 && Math.abs(size[2] / size[3] - size[0] / size[1]) < 0.01, ratio + ': the canvas has the screen shape: ' + size);
      assert.equal(size[4], '', ratio + ': no text');
      result.output[ratio] = size.slice(0, 4); await shot('output-' + ratio.replace(':', 'x'));
    }
    await format('1080p');
    ({output} = await pg.frames());
    result.output['1080p'] = await output.evaluate(() => { const c = document.getElementById('picture'); return [innerWidth, innerHeight, c.width, c.height]; });
    assert.deepEqual(result.output['1080p'].slice(2), [1920, 1080], 'the 1080p output draws 1920x1080 pixels');
    await pg.key(1).click(); await page.waitForTimeout(1500);
    result.fps.output1080p = await rate(output);
    // Software GL, the default here, rasterizes 1080p on the CPU: the rate is only held to account on a GPU.
    if (process.env.HIT_SHAPES_GPU) assert(result.fps.output1080p.fps >= 50, 'the 1080p output keeps its frame rate: ' + JSON.stringify(result.fps.output1080p));
    await pg.key(1).click(); await format('Fit');

    /* ---------- saved, and shared ---------- */
    await pg.turn(0, -30); await hold(); await pg.turn(2, 40); await page.waitForTimeout(900);
    const mine = await control.evaluate(() => ({state: __hitShapes.state(), cells: Array.from(state.cells).join(''), share: shareState()}));
    assert(/^v3\.[A-Za-z0-9_-]+$/.test(mine.share) && mine.share.length <= 120, 'the share state is short: ' + mine.share.length);
    result.shareLength = mine.share.length;
    await page.reload(); await page.keyboard.press('Shift');
    ({control, output} = await pg.frames());
    await control.waitForFunction(() => ready);
    const reopened = await control.evaluate(() => ({state: __hitShapes.state(), cells: Array.from(state.cells).join('')}));
    assert.deepEqual(reopened, {state: mine.state, cells: mine.cells}, 'reopening keeps patterns, tempo, colours and voice settings');
    // Another browser: nothing saved, only the link.
    const other = await pg.browser.newContext({viewport: {width: 1440, height: 900}});
    if (!pg.live) await other.route('https://raw.githubusercontent.com/**', route => route.abort('blockedbyclient'));
    const visit = await other.newPage();
    await visit.goto(pg.origin + '/playground?view=2d&app=' + SLUG + '&s=' + encodeURIComponent(mine.share));
    await visit.keyboard.press('Shift');
    let shared = null;
    for (let i = 0; i < 300 && !shared; i++) { for (const frame of visit.frames()) { try { if (await frame.evaluate(() => window.__hitShapes?.role === 'control' && ready)) shared = frame; } catch {} } if (!shared) await visit.waitForTimeout(100); }
    assert(shared, 'the shared link opens the App');
    const theirs = await shared.evaluate(() => ({state: __hitShapes.state(), cells: Array.from(state.cells.subarray(cellIndex(state.pattern, 0, 0), cellIndex(state.pattern + 1, 0, 0))).join('')}));
    const from = mine.state.pattern * 128;
    assert.equal(theirs.cells, mine.cells.slice(from, from + 128), 'the link carries the rhythm');
    for (const key of ['pattern', 'bpm', 'swing', 'theme', 'style']) assert.equal(theirs.state[key], mine.state[key], 'the link carries ' + key);
    assert.deepEqual(theirs.state.voices.map(v => [v.tune, v.decay]), mine.state.voices.map(v => [v.tune, v.decay]), 'the link carries tune and decay');
    assert.equal(theirs.state.playing, false, 'a shared link opens stopped');
    // The same still picture in both browsers (the still picture breathes, so both are drawn at one moment).
    const stillAt = frame => frame.evaluate(() => { const c = document.createElement('canvas'), s = createStage(c, {readback: true}); s.resize(640, 360, 1); s.set(picture()); s.set({sel: -1}); s.render(1000); return Array.from(c.getContext('2d').getImageData(0, 0, 640, 360).data).join(); });
    assert.equal(await stillAt(shared), await stillAt(control), 'the link opens the same picture');
    assert.equal(await shared.evaluate(() => applyShare({state: 'v1.!!!'}) || applyShare({state: 'v9.' + 'A'.repeat(59)}) || applyShare({state: 'v1.' + '_'.repeat(59)})), false, 'an unreadable link is ignored');
    assert.deepEqual(await shared.evaluate(() => { const style = state.style; return [applyShare({state: 'v1.' + 'A'.repeat(59)}), state.bpm, state.style === style]; }), [true, 40, true], 'a link from before styles still opens, in the style already chosen');
    await other.close();
    console.log(JSON.stringify({pass: true, ...result}, null, 1));
  } finally {
    await pg.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
