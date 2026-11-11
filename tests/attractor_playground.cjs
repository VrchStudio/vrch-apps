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
  assert(bytes.length <= 0.3 * 1024 * 1024, 'the package is at most 0.3 MB: ' + bytes.length);
  const listing = Buffer.from(JSON.stringify({schemaVersion: 1, appId: meta.manifest.id, version, revision: meta.revision, packageDigest: digest, base: RAW + ZERO + '/apps/' + SLUG + '/src/', files: meta.files}));
  const icon = fs.readFileSync(path.join(APPS, 'apps', SLUG, 'src', meta.manifest.icon));
  served.set('catalog/assets/' + sha(listing) + '.json', listing); served.set('catalog/assets/' + sha(icon) + '.svg', icon);
  catalog.apps = catalog.apps.filter(app => app.slug !== SLUG);
  catalog.apps.push({appId: meta.manifest.id, slug: SLUG, name: meta.manifest.name, version, summary: meta.manifest.guide.description, category: 'visuals', featured: null, tags: [], capabilities: ['controls'],
    size: bytes.length, revision: meta.revision, packageDigest: digest, roles: ['output'], assets: {
      files: {url: RAW + 'main/catalog/assets/' + sha(listing) + '.json', sha256: sha(listing), size: listing.length},
      package: {url: RELEASE + SLUG + '-v' + version + '/' + SLUG + '-' + version + '.vrchapp', size: bytes.length, sha256: digest},
      icon: {url: RAW + 'main/catalog/assets/' + sha(icon) + '.svg', sha256: sha(icon), size: icon.length, mediaType: 'image/svg+xml'}}});
  return {catalog: Buffer.from(JSON.stringify(catalog)), served, packages: new Map([[SLUG + '-v' + version + '/' + SLUG + '-' + version, bytes]]), name: meta.manifest.name, size: bytes.length, files: meta.files};
}

// Runs in every frame before its scripts: notes any request for a microphone or camera and any sound being set up.
function instrument() {
  window.__asked = []; window.__sound = 0;
  if (navigator.mediaDevices?.getUserMedia) { const ask = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = constraints => { __asked.push(JSON.stringify(constraints)); return ask(constraints); }; }
  if (window !== top && window.AudioContext) { const Native = window.AudioContext; window.AudioContext = class extends Native { constructor(...args) { super(...args); window.__sound++; } }; }
}

async function open() {
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
  const options = {executablePath: '/usr/bin/google-chrome', headless: true, args: gpu};
  const browser = LIVE ? await chromium.launch(options) : await require(path.join(PAGES, 'tests/vrch_playground_test_github.cjs')).launch(chromium, options);
  const errors = [];
  // query: appended to the Playground address. format: the output panel's {ratio, size}.
  async function visit(query, format) {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}});
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
    const over = async (group, index) => { const box = await control(group, index).boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); };
    // Turn an encoder by its wheel, one detent an event with "gap" ms between (positive is clockwise).
    const turn = async (index, detents, gap = 90) => { await over('encoders', index); for (let i = 0; i < Math.abs(detents); i++) { await page.mouse.wheel(0, detents > 0 ? -100 : 100); await page.waitForTimeout(gap); } };
    // A simulated knob is pressed once the pointer has rested on it.
    const press = async index => { await over('encoders', index); await page.waitForTimeout(450); await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up(); await page.waitForTimeout(120); };
    const key = async (index, holdMs = 70) => { await over('keys', index); await page.mouse.down(); await page.waitForTimeout(holdMs); await page.mouse.up(); await page.waitForTimeout(120); };
    const tap = async () => { const box = await page.locator('#stageDevice').boundingBox(); await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6); await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up(); await page.waitForTimeout(150); };
    const output = async () => { await page.keyboard.press('Shift'); await page.waitForFunction(() => document.body.dataset.output === 'panel', null, {timeout: 30000}); await settled(); return find('output'); };
    return {context, page, find, control, settled, turn, press, key, tap, output, prompts};
  }
  const state = frame => frame.evaluate(() => __attractor.state()), stats = frame => frame.evaluate(() => __attractor.stats());
  const stopped = (frame, timeout = 60000) => frame.waitForFunction(() => __attractor.stats().stopped, null, {timeout});
  // The picture as the browser holds it: its exact bytes, and the centred square as a 64 x 64 grid of light.
  const bytes = frame => frame.evaluate(() => document.getElementById('picture').toDataURL('image/png'));
  const grid = frame => frame.evaluate(() => {
    const source = document.getElementById('picture'), side = Math.min(source.width, source.height), copy = document.createElement('canvas'); copy.width = copy.height = 64;
    const g = copy.getContext('2d', {willReadFrequently: true}); g.drawImage(source, (source.width - side) / 2, (source.height - side) / 2, side, side, 0, 0, 64, 64);
    const d = g.getImageData(0, 0, 64, 64).data, light = []; for (let i = 0; i < d.length; i += 4) light.push(d[i] + d[i + 1] + d[i + 2]);
    return light;
  });
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
  return {fx, origin, browser, errors, visit, state, stats, stopped, bytes, grid, alike, watch, watched, sha, close: async () => { await browser.close(); if (server) server.close(); }};
}
module.exports = {open, OUT, SLUG, APPS, GPU, LIVE};
