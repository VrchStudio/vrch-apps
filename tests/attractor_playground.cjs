// What the Attractor browser tests share: the real Pages Playground (Shell, SDK, local runtime, virtual E/K hardware
// and the output panel) serving this working tree's package as tools/apps.py publishes it. The catalog entry is a
// fixture, so the App runs before its first release. ATTRACTOR_ORIGIN=https://host runs against a deployed Playground
// and the published App instead. ATTRACTOR_GPU=1 uses this machine's GPU; without it Chrome draws in software and the
// speed checks are only reported.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto'), {execFileSync} = require('node:child_process');
const APPS = path.resolve(__dirname, '..'), PAGES = process.env.VRCH_PAGES_ROOT || path.resolve(APPS, '../vrch-web-viewer-pages'), STATIC = path.join(PAGES, 'static');
const SLUG = 'attractor', OUT = process.env.ATTRACTOR_OUT || '/tmp/attractor-test', LIVE = (process.env.ATTRACTOR_ORIGIN || '').replace(/\/$/, ''), GPU = !!process.env.ATTRACTOR_GPU;
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
  assert(bytes.length <= 8 * 1024 * 1024, 'the package is at most 8 MB: ' + bytes.length);
  // As in the published catalog, the Playground may start the App before its music has arrived.
  const later = meta.files.map(file => file.path).filter(name => name.startsWith('music/')).sort();
  const listing = Buffer.from(JSON.stringify({schemaVersion: 1, appId: meta.manifest.id, version, revision: meta.revision, packageDigest: digest, base: RAW + ZERO + '/apps/' + SLUG + '/src/', files: meta.files}));
  const icon = fs.readFileSync(path.join(APPS, 'apps', SLUG, 'src', meta.manifest.icon));
  served.set('catalog/assets/' + sha(listing) + '.json', listing); served.set('catalog/assets/' + sha(icon) + '.svg', icon);
  catalog.apps = catalog.apps.filter(app => app.slug !== SLUG);
  catalog.apps.push({appId: meta.manifest.id, slug: SLUG, name: meta.manifest.name, version, summary: meta.manifest.guide.description, category: 'visuals', featured: null, tags: [], capabilities: Object.keys(meta.manifest.capabilities).sort(),
    size: bytes.length, revision: meta.revision, packageDigest: digest, roles: ['output'], ...(later.length ? {deferred: later} : {}), assets: {
      files: {url: RAW + 'main/catalog/assets/' + sha(listing) + '.json', sha256: sha(listing), size: listing.length},
      package: {url: RELEASE + SLUG + '-v' + version + '/' + SLUG + '-' + version + '.vrchapp', size: bytes.length, sha256: digest},
      icon: {url: RAW + 'main/catalog/assets/' + sha(icon) + '.svg', sha256: sha(icon), size: icon.length, mediaType: 'image/svg+xml'}}});
  return {catalog: Buffer.from(JSON.stringify(catalog)), served, packages: new Map([[SLUG + '-v' + version + '/' + SLUG + '-' + version, bytes]]), name: meta.manifest.name, size: bytes.length, files: meta.files};
}

// Runs in every frame before its scripts: notes any request for a microphone or camera and any sound being set up.
// In the top page it also listens to the host's playback node with the SDK's own PCM processor, so "heard" means the
// exact samples the host hands to the audio device.
function instrument() {
  window.__asked = []; window.__tracks = []; window.__sound = [];
  if (navigator.mediaDevices?.getUserMedia) { const ask = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = constraints => { __asked.push(JSON.stringify(constraints)); return ask(constraints).then(stream => { __tracks.push(...stream.getTracks()); return stream; }); }; }
  if (window !== top && window.AudioContext) { const Native = window.AudioContext; window.AudioContext = class extends Native { constructor(options) { super(options); window.__sound.push({sampleRate: options?.sampleRate, sink: options?.sinkId?.type}); } }; }
  if (window === top && window.AudioWorkletNode) {
    const Native = window.AudioWorkletNode, tap = window.__host = {nodes: 0, recent: []};
    window.AudioWorkletNode = class extends Native {
      constructor(ctx, name, options) {
        super(ctx, name, options);
        if (options?.processorOptions?.mode !== 'playback') return;
        tap.nodes++;
        const listen = new Native(ctx, 'vrch-apps-pcm-v1', {numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit', processorOptions: {mode: 'capture', channels: 2, generation: -7}});
        const pair = new MessageChannel();
        pair.port2.onmessage = ({data}) => {
          if (data?.type !== 'pcm') return;
          pair.port2.postMessage({type: 'ack', sequence: data.sequence, generation: -7});
          let left = 0, right = 0, apart = 0, step = 0;
          for (let i = 0; i < 960; i++) {
            const l = data.samples[2 * i], r = data.samples[2 * i + 1];
            left = Math.max(left, Math.abs(l)); right = Math.max(right, Math.abs(r)); apart = Math.max(apart, Math.abs(l - r));
            if (tap.last) step = Math.max(step, Math.abs(l - tap.last[0]), Math.abs(r - tap.last[1]));
            tap.last = [l, r];
          }
          tap.recent.push({at: performance.now(), left, right, apart, step}); if (tap.recent.length > 500) tap.recent.shift();
        };
        listen.port.postMessage({type: 'attach', port: pair.port1}, [pair.port1]);
        this.connect(listen);
      }
    };
  }
}

// args: extra Chrome switches; permissions: granted to every page (none: refused).
async function open({args = [], permissions = []} = {}) {
  fs.mkdirSync(OUT, {recursive: true});
  let fx = null, server = null, origin = LIVE;
  if (!LIVE) {
    fx = fixture();
    server = http.createServer((req, res) => {
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
    origin = 'http://127.0.0.1:' + server.address().port;
  }
  const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');
  const gpu = GPU ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const options = {executablePath: '/usr/bin/google-chrome', headless: true, args: [...gpu, '--autoplay-policy=no-user-gesture-required', ...args]};
  const browser = LIVE ? await chromium.launch(options) : await require(path.join(PAGES, 'tests/vrch_playground_test_github.cjs')).launch(chromium, options);
  const errors = [];
  // query: appended to the Playground address. format: the output panel's {ratio, size}.
  async function visit(query, format) {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}, permissions});
    if (!LIVE) await context.route(RAW + '**', route => route.abort('blockedbyclient'));
    await context.addInitScript(instrument);
    if (format) await context.addInitScript(value => { if (window === top) localStorage.setItem('vrch-playground-output-format', value); }, JSON.stringify(format));
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|blockedbyclient|ERR_BLOCKED/i.test(m.text())) errors.push(m.text()); });
    const prompts = []; page.on('dialog', d => { prompts.push(d.message()); void d.dismiss(); });
    await page.goto(origin + '/playground?view=2d&app=' + SLUG + (query || ''));
    const find = async role => {
      // The Shell loads a candidate and then shows it: take the frame once it has stayed for half a second.
      let seen = null, since = 0;
      for (let i = 0; i < 400; i++) {
        let now = null;
        for (const f of page.frames()) { try { if (await f.evaluate(r => !!window.__attractor && __attractor.role === r && __attractor.firstFrameAt !== null, role)) now = f; } catch {} }
        if (now && now === seen && Date.now() - since > 500) return now;
        if (now !== seen) { seen = now; since = Date.now(); }
        await page.waitForTimeout(100);
      }
      await page.screenshot({path: path.join(OUT, 'stuck.png')});
      throw new Error('no ' + role + ' frame: ' + JSON.stringify({errors, frames: page.frames().map(f => f.url().slice(0, 60)), preview: await page.evaluate(() => document.getElementById('previewProgressText')?.textContent)}));
    };
    const control = (group, index) => page.locator('[data-hardware="' + group + '"] button').nth(index);
    const settled = () => page.waitForFunction(() => !document.getAnimations().some(a => a.effect?.pseudoElement?.startsWith('::view-transition')), null, {timeout: 20000}).catch(() => {});
    // The pointer goes to a control once it has stopped moving and can be hit: while the layout slides (the output
    // opening is a view transition) a press lands on the page instead.
    const over = async (group, index) => {
      let box = await control(group, index).boundingBox();
      for (let i = 0; i < 300; i++) {
        await page.waitForTimeout(70);
        const now = await control(group, index).boundingBox(), still = box && now && Math.abs(now.x - box.x) < 0.5 && Math.abs(now.y - box.y) < 0.5;
        box = now;
        if (still && await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-hardware]'), [box.x + box.width / 2, box.y + box.height / 2])) break;
      }
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    };
    // Turn an encoder by its wheel, one detent an event with "gap" ms between (positive is clockwise).
    const turn = async (index, detents, gap = 90) => { await over('encoders', index); for (let i = 0; i < Math.abs(detents); i++) { await page.mouse.wheel(0, detents > 0 ? -100 : 100); await page.waitForTimeout(gap); } };
    // A simulated knob is pressed once the pointer has rested on it.
    const press = async index => { await over('encoders', index); await page.waitForTimeout(450); await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up(); await page.waitForTimeout(120); };
    const key = async (index, holdMs = 70) => { await over('keys', index); await page.mouse.down(); await page.waitForTimeout(holdMs); await page.mouse.up(); await page.waitForTimeout(120); };
    const tap = async () => { const box = await page.locator('#stageDevice').boundingBox(); await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6); await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up(); await page.waitForTimeout(150); };
    // Drag across the picture by a share of the device screen; "flick" lets go while still moving.
    const drag = async (dx, dy, flick = false) => {
      const box = await page.locator('#stageDevice').boundingBox(), x = box.x + box.width * 0.5, y = box.y + box.height * 0.55;
      await page.mouse.move(x, y); await page.waitForTimeout(200); await page.mouse.down(); await page.waitForTimeout(60);   // a press right on arrival can be lost
      for (let i = 1; i <= 12; i++) { await page.mouse.move(x + dx * box.width * i / 12, y + dy * box.height * i / 12); await page.waitForTimeout(flick ? 12 : 30); }
      if (!flick) await page.waitForTimeout(250);
      await page.mouse.up(); await page.waitForTimeout(150);
    };
    const output = async () => { await page.keyboard.press('Shift'); await page.waitForFunction(() => document.body.dataset.output === 'panel', null, {timeout: 30000}); await settled(); return find('output'); };
    // A real click on something inside the App: the simulated device scales its screen, so the place is worked out
    // frame by frame up to the page.
    const click = async (frame, selector) => {
      let at = await frame.evaluate(sel => { const node = document.querySelector(sel); node.scrollIntoView({block: 'nearest'}); const r = node.getBoundingClientRect(); return {x: (r.x + r.width / 2) / innerWidth, y: (r.y + r.height / 2) / innerHeight}; }, selector);
      for (let f = frame; f.parentFrame(); f = f.parentFrame()) {
        const holder = await f.frameElement();
        at = await holder.evaluate((node, p) => { const r = node.getBoundingClientRect(), top = window === window.top; return {x: (r.x + p.x * r.width) / (top ? 1 : innerWidth), y: (r.y + p.y * r.height) / (top ? 1 : innerHeight)}; }, at);
      }
      await page.mouse.click(at.x, at.y); await page.waitForTimeout(150);
    };
    return {context, page, find, control, settled, turn, press, key, tap, drag, click, output, prompts};
  }
  const state = frame => frame.evaluate(() => __attractor.state()), stats = frame => frame.evaluate(() => __attractor.stats());
  const stopped = (frame, timeout = 60000) => frame.waitForFunction(() => __attractor.stats().stopped, null, {timeout});
  // What the host sent to the audio device in the last "ms": the loudest sample left and right, how far the two were
  // apart, and the largest jump between neighbouring samples.
  const heard = (page, ms) => page.evaluate(span => { const now = performance.now(), blocks = (window.__host?.recent || []).filter(b => now - b.at < span), most = key => blocks.reduce((m, b) => Math.max(m, b[key]), 0); return {blocks: blocks.length, left: most('left'), right: most('right'), apart: most('apart'), step: most('step')}; }, ms);
  // The picture as the browser holds it: its exact bytes, and the centred square as a 64 x 64 grid of light
  // ("part": only that share of the square, about its middle).
  const bytes = frame => frame.evaluate(() => document.getElementById('picture').toDataURL('image/png'));
  const grid = (frame, part = 1) => frame.evaluate(share => {
    const source = document.getElementById('picture'), side = Math.min(source.width, source.height) * share, copy = document.createElement('canvas'); copy.width = copy.height = 64;
    const g = copy.getContext('2d', {willReadFrequently: true}); g.drawImage(source, (source.width - side) / 2, (source.height - side) / 2, side, side, 0, 0, 64, 64);
    const d = g.getImageData(0, 0, 64, 64).data, light = []; for (let i = 0; i < d.length; i += 4) light.push(d[i] + d[i + 1] + d[i + 2]);
    return light;
  }, part);
  const alike = (a, b) => { const mean = l => l.reduce((s, v) => s + v, 0) / l.length, ma = mean(a), mb = mean(b); let ab = 0, aa = 0, bb = 0; for (let i = 0; i < a.length; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; } return ab / Math.sqrt(aa * bb || 1); };
  // Watch the picture frame by frame: its light, how much it moved since the frame before, and the letter a.
  const watch = frame => frame.evaluate(() => {
    const source = document.getElementById('picture'), copy = document.createElement('canvas'); copy.width = copy.height = 48;
    const g = copy.getContext('2d', {willReadFrequently: true}), log = window.__watch = {frames: [], on: true};
    let before = null, last = -1;
    const tick = now => {
      if (!log.on) return;
      requestAnimationFrame(tick);
      if (now === last) return; last = now;
      g.drawImage(source, 0, 0, 48, 48);
      const d = g.getImageData(0, 0, 48, 48).data, light = new Float32Array(2304); let sum = 0, moved = 0;
      for (let i = 0; i < 2304; i++) { light[i] = d[4 * i] + d[4 * i + 1] + d[4 * i + 2]; sum += light[i]; if (before) moved += Math.abs(light[i] - before[i]); }
      before = light; log.frames.push({at: now, light: sum / 2304 / 765, moved: moved / 2304 / 765, a: __attractor.state().a});
    };
    requestAnimationFrame(tick);
  });
  const watched = frame => frame.evaluate(() => { __watch.on = false; return __watch.frames; });
  return {fx, origin, browser, errors, visit, state, stats, stopped, heard, bytes, grid, alike, watch, watched, sha, close: async () => { await browser.close(); if (server) server.close(); }};
}
module.exports = {open, OUT, SLUG, APPS, GPU, LIVE};
