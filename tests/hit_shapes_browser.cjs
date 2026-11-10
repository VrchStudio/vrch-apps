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
    // The same loop draws the same frames: bar 2 and bar 3, pixel for pixel, at several moments in the bar.
    result.loopFramesCompared = await control.evaluate(([width, height]) => {
      const run = simulate({width, height, rows: {BD: 'X..x..x.X...x.x.', SD: '....X..x....X...', CH: 'x.xxx.xxX.xxx.xx', OH: '.x...x...X...x..', CP: '....x.......X...', LT: '......x......xX.', RS: '..x......x......', CB: 'X..x..x..x..x...'}, swing: 0.16, loops: 5});
      const moments = [0, 20, 61, 125, 333, 700, 1001, 1500, 1990], second = moments.map(at => run.pixels(16 * run.stepMs + at).slice());
      moments.forEach((at, k) => {
        const third = run.pixels(32 * run.stepMs + at);
        for (let i = 0; i < third.length; i++) if (second[k][i] !== third[i]) throw new Error('bar 2 and bar 3 differ ' + at + ' ms into the bar');
        if (k && second[k].every((v, i) => v === second[0][i])) throw new Error('the picture does not move');
      });
      return moments.length;
    }, [960, 540]);

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
    assert(await red(control) > 0.05 && await red(output) > 0.05, 'the still picture of pattern A, with its four kicks, is on both screens');
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
    assert(Object.values(result.patternsDiffer).every(share => share > 0.02), 'A, B and C are clearly different pictures: ' + JSON.stringify(result.patternsDiffer));
    await pg.key(3).click(); await pg.key(3).click(); await page.waitForTimeout(300); // D, then A again
    assert.equal((await control.evaluate(() => __hitShapes.state())).pattern, 0);
    // K4 held: next colours, same pattern.
    const hold = async () => { const box = await pg.key(3).boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.waitForTimeout(750); await page.mouse.up(); await page.waitForTimeout(300); };
    for (const name of ['paper', 'pool']) { await hold(); await shot('colours-' + name); await shot('device-' + name, '#stageDevice'); }
    let now = await control.evaluate(() => __hitShapes.state());
    assert.equal(now.theme, 2); assert.equal(now.pattern, 0, 'holding K4 changes the colours, not the pattern');
    assert.equal((await output.evaluate(() => __hitShapes.state())).theme, 2, 'the output takes the colours');
    await hold(); assert.equal((await control.evaluate(() => __hitShapes.state())).theme, 0);

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
    await pg.encoder(2).click(); await pg.encoder(3).click(); await page.waitForTimeout(200);
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
    const tap = selector => control.evaluate(s => document.querySelector(s).dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true})), selector);
    await tap('#voices .voice:nth-child(6)');
    assert.equal((await control.evaluate(() => __hitShapes.state())).voice, 'LT');
    const cell = () => control.evaluate(() => state.cells[cellIndex(state.pattern, state.sel, 2)]);
    await tap('#steps .step:nth-child(3)'); assert.equal(await cell(), 1); await tap('#steps .step:nth-child(3)'); assert.equal(await cell(), 2);
    await control.waitForFunction(() => __hitShapes.hits().some(hit => hit.voice === 'LT' && hit.step === 2 && hit.accent && hit.drawnAt), null, {timeout: 5000});
    await tap('#steps .step:nth-child(3)'); assert.equal(await cell(), 0);
    await pg.key(1).click(); await page.waitForTimeout(700);
    assert.equal((await control.evaluate(() => __hitShapes.state())).playing, false);
    // K3 and a tap on the picture play the selected voice while stopped, and draw it.
    const manual = () => control.evaluate(() => __hitShapes.hits().filter(hit => hit.manual && hit.drawnAt).length);
    const before = await manual();
    await pg.key(2).click(); await tap('#picture');
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
    assert(result.fps.output1080p.fps >= 50, 'the 1080p output keeps its frame rate: ' + JSON.stringify(result.fps.output1080p));
    await pg.key(1).click(); await format('Fit');

    /* ---------- saved, and shared ---------- */
    await pg.turn(0, -30); await hold(); await pg.turn(2, 40); await page.waitForTimeout(900);
    const mine = await control.evaluate(() => ({state: __hitShapes.state(), cells: Array.from(state.cells).join(''), share: shareState()}));
    assert(/^v1\.[A-Za-z0-9_-]+$/.test(mine.share) && mine.share.length <= 120, 'the share state is short: ' + mine.share.length);
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
    for (const key of ['pattern', 'bpm', 'swing', 'theme']) assert.equal(theirs.state[key], mine.state[key], 'the link carries ' + key);
    assert.deepEqual(theirs.state.voices.map(v => [v.tune, v.decay]), mine.state.voices.map(v => [v.tune, v.decay]), 'the link carries tune and decay');
    assert.equal(theirs.state.playing, false, 'a shared link opens stopped');
    // The same still picture in both browsers (the still picture breathes, so both are drawn at one moment).
    const stillAt = frame => frame.evaluate(() => { const c = document.createElement('canvas'), s = createStage(c, {readback: true}); s.resize(640, 360, 1); s.set(picture()); s.set({sel: -1}); s.render(1000); return Array.from(c.getContext('2d').getImageData(0, 0, 640, 360).data).join(); });
    assert.equal(await stillAt(shared), await stillAt(control), 'the link opens the same picture');
    assert.equal(await shared.evaluate(() => applyShare({state: 'v1.!!!'}) || applyShare({state: 'v9.' + 'A'.repeat(59)}) || applyShare({state: 'v1.' + '_'.repeat(59)})), false, 'an unreadable link is ignored');
    await other.close();
    console.log(JSON.stringify({pass: true, ...result}, null, 1));
  } finally {
    await pg.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
