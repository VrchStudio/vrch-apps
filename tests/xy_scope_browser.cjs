// XY Scope in the real Pages Playground (Shell, SDK, local runtime, PCM bridge, virtual E/K hardware and the output
// panel), packaged from this working tree as tools/apps.py publishes it. The catalog entry is a fixture: the App is
// listed before its first release. Chrome's audio device is a fixture; the host output is tapped with the SDK's own
// PCM processor, so "heard" below means the exact samples the host hands to the device.
//
//   VRCH_PAGES_ROOT=../vrch-web-viewer-pages node tests/xy_scope_browser.cjs      (XY_SCOPE_GPU=1 for a real GPU)
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto'), {execFileSync} = require('node:child_process');
const APPS = path.resolve(__dirname, '..'), PAGES = process.env.VRCH_PAGES_ROOT || path.resolve(APPS, '../vrch-web-viewer-pages'), STATIC = path.join(PAGES, 'static');
const SLUG = 'xy-scope', OUT = process.env.XY_SCOPE_OUT || '/tmp/xy-scope-test';
const RAW = 'https://raw.githubusercontent.com/VrchStudio/vrch-apps/', RELEASE = 'https://github.com/VrchStudio/vrch-apps/releases/download/', ZERO = '0'.repeat(40);
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json', '.glb': 'model/gltf-binary'};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const PACK = ['import base64,hashlib,json,pathlib,sys,tempfile', 'root=pathlib.Path(sys.argv[1]);sys.path.insert(0,str(root/"tools"))', 'import apps',
  'manifest,records,revision=apps.source(sys.argv[2],root)', 'out=pathlib.Path(tempfile.mkdtemp())', 'package,release=apps.build(sys.argv[2],root,out,"0"*40)',
  'sys.stdout.write(json.dumps({"manifest":manifest,"revision":revision,"zip":base64.b64encode(package.read_bytes()).decode(),"files":[{"path":n,"size":len(d),"sha256":hashlib.sha256(d).hexdigest()} for n,d in records]}))'].join('\n');

function fixture() {
  const catalog = JSON.parse(fs.readFileSync(path.join(APPS, 'catalog/playground.json'), 'utf8')), served = new Map();
  const meta = JSON.parse(execFileSync('python3', ['-c', PACK, APPS, SLUG], {maxBuffer: 64 << 20}).toString()), bytes = Buffer.from(meta.zip, 'base64'), digest = sha(bytes), version = meta.manifest.version;
  assert.deepEqual(meta.manifest.roles, ['output']);
  assert(bytes.length <= 0.3 * 1024 * 1024, 'the package is at most 0.3 MB: ' + bytes.length);
  const listing = Buffer.from(JSON.stringify({schemaVersion: 1, appId: meta.manifest.id, version, revision: meta.revision, packageDigest: digest, base: RAW + ZERO + '/apps/' + SLUG + '/src/', files: meta.files}));
  const icon = fs.readFileSync(path.join(APPS, 'apps', SLUG, 'src', meta.manifest.icon));
  served.set('catalog/assets/' + sha(listing) + '.json', listing); served.set('catalog/assets/' + sha(icon) + '.svg', icon);
  catalog.apps = catalog.apps.filter(app => app.slug !== SLUG);
  catalog.apps.push({appId: meta.manifest.id, slug: SLUG, name: meta.manifest.name, version, summary: meta.manifest.guide.description, category: 'audiovisual', featured: null, tags: [], capabilities: ['audio_output', 'controls'],
    size: bytes.length, revision: meta.revision, packageDigest: digest, roles: ['output'], assets: {
      files: {url: RAW + 'main/catalog/assets/' + sha(listing) + '.json', sha256: sha(listing), size: listing.length},
      package: {url: RELEASE + SLUG + '-v' + version + '/' + SLUG + '-' + version + '.vrchapp', size: bytes.length, sha256: digest},
      icon: {url: RAW + 'main/catalog/assets/' + sha(icon) + '.svg', sha256: sha(icon), size: icon.length, mediaType: 'image/svg+xml'}}});
  return {catalog: Buffer.from(JSON.stringify(catalog)), served, packages: new Map([[SLUG + '-v' + version + '/' + SLUG + '-' + version, bytes]]), name: meta.manifest.name, size: bytes.length, files: meta.files};
}

// Runs in every frame before its scripts. Top page: tap the host's playback node. App frames: note the engine's
// blocks and any request for a microphone or camera.
function instrument() {
  const Native = window.AudioWorkletNode, wall = () => performance.timeOrigin + performance.now();
  window.__asked = [];
  if (navigator.mediaDevices?.getUserMedia) { const ask = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = constraints => { __asked.push(JSON.stringify(constraints)); return ask(constraints); }; }
  if (!Native) return;
  if (window === top) {
    const tap = window.__host = {base: null, blocks: 0, peak: 0, step: 0, armed: false, onset: null, last: null, recent: []};
    tap.reset = () => { tap.peak = 0; tap.step = 0; };
    tap.when = frame => tap.base + frame / 48;
    window.AudioWorkletNode = class extends Native {
      constructor(ctx, name, options) {
        super(ctx, name, options);
        if (options?.processorOptions?.mode !== 'playback') return;
        const listen = new Native(ctx, 'vrch-apps-pcm-v1', {numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit', processorOptions: {mode: 'capture', channels: 2, generation: -7}});
        const pair = new MessageChannel();
        pair.port2.onmessage = ({data}) => {
          if (data?.type !== 'pcm') return;
          const now = wall(), samples = data.samples; pair.port2.postMessage({type: 'ack', sequence: data.sequence, generation: -7});
          const made = now - data.sequence * 20; tap.base = tap.base === null ? made : Math.min(made, tap.base + 0.02); tap.blocks++;
          let peak = 0, square = 0;
          for (let i = 0; i < 960; i++) for (let c = 0; c < 2; c++) {
            const value = samples[2 * i + c]; peak = Math.max(peak, Math.abs(value)); square += value * value;
            if (tap.last) tap.step = Math.max(tap.step, Math.abs(value - tap.last[c]));
            (tap.last ||= [0, 0])[c] = value;
          }
          tap.peak = Math.max(tap.peak, peak); tap.recent.push({at: now, peak, rms: Math.sqrt(square / 1920)}); if (tap.recent.length > 400) tap.recent.shift();
          if (tap.armed && !tap.onset) for (let i = 0; i < 960; i++) if (Math.abs(samples[2 * i]) + Math.abs(samples[2 * i + 1]) > 1e-4) { tap.onset = {frame: (data.sequence - 1) * 960 + i, first: Array.from(samples.slice(2 * i, Math.min(1920, 2 * i + 64)))}; break; }
        };
        listen.port.postMessage({type: 'attach', port: pair.port1}, [pair.port1]);
        this.connect(listen); tap.node = listen; tap.context = ctx;
      }
    };
  } else {
    const tap = window.__tap = {base: null, armed: false, onset: null, blocks: 0};
    tap.when = frame => tap.base + frame / 48;
    window.AudioWorkletNode = class extends Native {
      constructor(ctx, name, options) {
        super(ctx, name, options);
        if (name !== 'scope-engine') return;
        this.port.addEventListener('message', ({data}) => {
          if (data?.type !== 'pcm') return;
          const now = wall(), frames = data.samples.length / 2, made = now - (data.frame + frames) / 48;
          tap.base = tap.base === null ? made : Math.min(made, tap.base + 0.02); tap.blocks++;
          if (tap.armed && !tap.onset) for (let i = 0; i < frames; i++) if (Math.abs(data.samples[2 * i]) + Math.abs(data.samples[2 * i + 1]) > 1e-4) { tap.onset = {frame: data.frame + i, first: Array.from(data.samples.slice(2 * i, Math.min(frames * 2, 2 * i + 64)))}; break; }
        });
      }
    };
  }
}

async function main() {
  fs.mkdirSync(OUT, {recursive: true});
  const fx = fixture(), result = {packageBytes: fx.size, files: fx.files.map(f => [f.path, f.size])};
  const server = http.createServer((req, res) => {
    const route = decodeURIComponent(req.url.split('?')[0]), marked = {'X-Vrch-Playground-Route': '1', 'Content-Type': 'application/octet-stream'};
    if (route === '/playground/events') { req.resume(); res.writeHead(204); return res.end(); }
    if (route.startsWith('/playground/github/') || route.startsWith('/playground/packages/')) {
      let body = null; const pkg = /^\/playground\/packages\/(.+)\.zip$/.exec(route);
      if (pkg) body = fx.packages.get(pkg[1]) || null;
      else if (route === '/playground/github/main/catalog/playground.json') body = fx.catalog;
      else if (route.startsWith('/playground/github/main/')) { const file = route.slice(24); body = fx.served.get(file) || (fs.existsSync(path.join(APPS, file)) ? fs.readFileSync(path.join(APPS, file)) : null); }
      else if (route.startsWith('/playground/github/' + ZERO + '/')) { const file = path.join(APPS, route.slice(20 + ZERO.length)); body = fs.existsSync(file) ? fs.readFileSync(file) : null; }
      if (!body) { res.writeHead(404, marked); return res.end('404'); }
      res.writeHead(200, marked); return res.end(body);
    }
    const file = path.join(STATIC, route === '/playground' ? '/vrch_playground.html' : route);
    if (!file.startsWith(STATIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store'}); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');
  const gpu = process.env.XY_SCOPE_GPU ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const browser = await require(path.join(PAGES, 'tests/vrch_playground_test_github.cjs')).launch(chromium, {executablePath: '/usr/bin/google-chrome', headless: true, args: [...gpu, '--autoplay-policy=no-user-gesture-required']});
  try {
    const errors = [];
    async function visit(query, format) {
      const context = await browser.newContext({viewport: {width: 1440, height: 900}});
      await context.route(RAW + '**', route => route.abort('blockedbyclient'));
      await context.addInitScript(instrument);
      if (format) await context.addInitScript(value => { if (window === top) localStorage.setItem('vrch-playground-output-format', value); }, JSON.stringify(format));
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|blockedbyclient|ERR_BLOCKED/i.test(m.text())) errors.push(m.text()); });
      const prompts = []; page.on('dialog', d => { prompts.push(d.message()); void d.dismiss(); });
      await page.goto(origin + '/playground?view=2d&app=' + SLUG + (query || ''));
      const find = async role => {
        // The Shell loads a candidate and then shows it: take the frame once it has stayed for half a second.
        let seen = null, since = 0;
        for (let i = 0; i < 300; i++) {
          let now = null;
          for (const f of page.frames()) { try { if (await f.evaluate(r => !!window.__xy && __xy.role === r && __xy.firstFrameAt !== null, role)) now = f; } catch {} }
          if (now && now === seen && Date.now() - since > 500) return now;
          if (now !== seen) { seen = now; since = Date.now(); }
          await page.waitForTimeout(100);
        }
        await page.screenshot({path: path.join(OUT, 'stuck.png')});
        throw new Error('no ' + role + ' frame: ' + JSON.stringify({errors, frames: page.frames().map(f => f.url().slice(0, 60)), preview: await page.evaluate(() => document.getElementById('previewProgressText')?.textContent)}));
      };
      const control = (group, index) => page.locator('[data-hardware="' + group + '"] button').nth(index);
      const settled = () => page.waitForFunction(() => !document.getAnimations().some(a => a.effect?.pseudoElement?.startsWith('::view-transition')), null, {timeout: 15000});
      // Turn an encoder by its wheel, one detent an event (positive is clockwise); press by clicking it.
      const turn = async (index, detents) => { const box = await control('encoders', index).boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); for (let i = 0; i < Math.abs(detents); i++) await page.mouse.wheel(0, detents > 0 ? -100 : 100); await page.waitForTimeout(80); };
      const key = async (index, holdMs = 60) => { const box = await control('keys', index).boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.waitForTimeout(holdMs); await page.mouse.up(); };
      return {context, page, find, control, settled, turn, key, prompts};
    }
    const state = frame => frame.evaluate(() => __xy.state()), probe = frame => frame.evaluate(() => __xy.probe());
    // Distinct animation frames a second (the Playground may call back twice within one frame).
    const fps = frame => frame.evaluate(() => new Promise(resolve => { let n = 0, last = 0; const t0 = performance.now(), tick = t => { if (t > last) n++; last = t; if (t - t0 < 2000) requestAnimationFrame(tick); else resolve(Math.round(n / (t - t0) * 10000) / 10); }; requestAnimationFrame(tick); }));
    const view = frame => frame.evaluate(() => ({signal: __xy.signal(), wall: performance.timeOrigin + performance.now()}));
    const until = async (frame, wanted, label, turnBy) => { for (let i = 0; i < 60; i++) { if (await frame.evaluate(wanted)) return; await turnBy(); } throw new Error('could not reach ' + label + ': ' + JSON.stringify(await state(frame))); };
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
    assert.deepEqual(await state(app), {mode: 'synth', pitchHz: 110, ratio: 1.5, free: false, drift: 0.1, shape: 0, spin: 0, decay: 1.5, glow: 0.35, colour: 'Green', holding: false, page: 'Tone'});
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

    /* ---- no clicks: fast turns of pitch, ratio and drift, and hold on and off ---- */
    await v.key(1); await v.page.waitForTimeout(300); await v.page.evaluate(() => __host.reset());
    for (let i = 0; i < 4; i++) { await v.turn(0, 36); await v.turn(1, 9); await v.turn(2, 60); await v.turn(0, -30); await v.turn(1, -9); await v.turn(2, -90); await v.key(1); await v.key(1); }
    await v.page.waitForTimeout(300);
    // A full-scale sine at the highest pitch here (A4 x 4:1 + 2 Hz) moves at most this far between two samples.
    result.largestStep = await v.page.evaluate(() => __host.step); const steepest = 2 * Math.PI * 1762 / 48000 * 0.345;
    assert(result.largestStep < steepest * 1.05, 'no jump between neighbouring samples: ' + result.largestStep + ' against ' + steepest);
    await v.key(1); await v.page.waitForTimeout(200);

    /* ---- the Motion page, colours, and what is saved ---- */
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
  } finally { await browser.close(); server.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
