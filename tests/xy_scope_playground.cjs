// What the XY Scope browser tests share: the real Pages Playground (Shell, SDK, local runtime, PCM bridge, virtual
// E/K hardware and the output panel) serving this working tree's package as tools/apps.py publishes it. The catalog
// entry is a fixture: the App is listed before its first release. Chrome's audio device is a fixture; the host output
// is tapped with the SDK's own PCM processor, so "heard" means the exact samples the host hands to the device.
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
  window.__asked = []; window.__tracks = [];
  if (navigator.mediaDevices?.getUserMedia) { const ask = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = constraints => { __asked.push(JSON.stringify(constraints)); return ask(constraints).then(stream => { __tracks.push(...stream.getTracks()); return stream; }); }; }
  if (!Native) return;
  if (window === top) {
    const tap = window.__host = {base: null, blocks: 0, peak: 0, step: 0, armed: false, onset: null, last: null, recent: [], nodes: 0, stepAt: null};
    tap.reset = () => { tap.peak = 0; tap.step = 0; };
    tap.when = frame => tap.base + frame / 48;
    window.AudioWorkletNode = class extends Native {
      constructor(ctx, name, options) {
        super(ctx, name, options);
        if (options?.processorOptions?.mode !== 'playback') return;
        tap.nodes++;
        const listen = new Native(ctx, 'vrch-apps-pcm-v1', {numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit', processorOptions: {mode: 'capture', channels: 2, generation: -7}});
        const pair = new MessageChannel();
        pair.port2.onmessage = ({data}) => {
          if (data?.type !== 'pcm') return;
          const now = wall(), samples = data.samples; pair.port2.postMessage({type: 'ack', sequence: data.sequence, generation: -7});
          const made = now - data.sequence * 20; tap.base = tap.base === null ? made : Math.min(made, tap.base + 0.02); tap.blocks++;
          let peak = 0, square = 0;
          for (let i = 0; i < 960; i++) for (let c = 0; c < 2; c++) {
            const value = samples[2 * i + c]; peak = Math.max(peak, Math.abs(value)); square += value * value;
            if (tap.last && Math.abs(value - tap.last[c]) > tap.step) { tap.step = Math.abs(value - tap.last[c]); tap.stepAt = {block: data.sequence, i, c, from: tap.last[c], to: value, at: Math.round(performance.now())}; }
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
    const tap = window.__tap = {base: null, armed: false, onset: null, blocks: 0, step: 0, last: null, next: -1, breaks: 0};
    tap.reset = () => { tap.step = 0; tap.breaks = 0; };
    tap.when = frame => tap.base + frame / 48;
    window.AudioWorkletNode = class extends Native {
      constructor(ctx, name, options) {
        super(ctx, name, options);
        if (name !== 'scope-engine') return;
        this.port.addEventListener('message', ({data}) => {
          if (data?.type !== 'pcm') return;
          const now = wall(), frames = data.samples.length / 2, made = now - (data.frame + frames) / 48;
          tap.base = tap.base === null ? made : Math.min(made, tap.base + 0.02); tap.blocks++;
          // The engine's own stream, frame after frame: the largest move between two neighbouring samples.
          if (tap.next >= 0 && data.frame !== tap.next) { tap.breaks++; tap.last = null; }
          tap.next = data.frame + frames;
          for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) { const value = data.samples[2 * i + c]; if (tap.last) tap.step = Math.max(tap.step, Math.abs(value - tap.last[c])); (tap.last ||= [0, 0])[c] = value; }
          if (tap.armed && !tap.onset) for (let i = 0; i < frames; i++) if (Math.abs(data.samples[2 * i]) + Math.abs(data.samples[2 * i + 1]) > 1e-4) { tap.onset = {frame: data.frame + i, first: Array.from(data.samples.slice(2 * i, Math.min(frames * 2, 2 * i + 64)))}; break; }
        });
      }
    };
  }
}

// One Playground server and browser. args: extra Chrome switches; permissions: granted to every page (none: refused).
async function open({args = [], permissions = []} = {}) {
  fs.mkdirSync(OUT, {recursive: true});
  const fx = fixture();
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
  const browser = await require(path.join(PAGES, 'tests/vrch_playground_test_github.cjs')).launch(chromium, {executablePath: '/usr/bin/google-chrome', headless: true, args: [...gpu, '--autoplay-policy=no-user-gesture-required', ...args]});
  const errors = [];
  async function visit(query, format) {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}, permissions});
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
    const settled = () => page.waitForFunction(() => !document.getAnimations().some(a => a.effect?.pseudoElement?.startsWith('::view-transition')), null, {timeout: 20000}).catch(() => {});   // a busy test machine can hold the layout motion; the checks below do not depend on it
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
  return {fx, origin, browser, errors, visit, state, probe, fps, view, until, close: async () => { await browser.close(); server.close(); }};
}
module.exports = {open, OUT, SLUG, APPS};
