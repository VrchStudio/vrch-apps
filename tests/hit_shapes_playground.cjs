// Runs Hit Shapes from this working tree in the real vrch.io Playground page (Pages checkout beside this repository, or
// VRCH_PAGES_ROOT): the Playground's Shell, SDK, PCM audio bridge and output screen, with the App listed in a fixture
// of the catalog exactly as tools/apps.py would publish it. Used by hit_shapes_browser.cjs.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const APPS = path.resolve(__dirname, '..'), PAGES = process.env.VRCH_PAGES_ROOT || path.resolve(APPS, '../vrch-web-viewer-pages'), STATIC = path.join(PAGES, 'static');
const RAW = 'https://raw.githubusercontent.com/VrchStudio/vrch-apps/', RELEASE = 'https://github.com/VrchStudio/vrch-apps/releases/download/', ZERO = '0'.repeat(40);
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json', '.glb': 'model/gltf-binary'};
const SLUG = 'hit-shapes';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const PACK = ['import base64,hashlib,io,json,pathlib,stat,sys,zipfile', 'root=pathlib.Path(sys.argv[1]);sys.path.insert(0,str(root/"tools"))', 'import apps',
  'manifest,records,revision=apps.source(sys.argv[2],root)', 'out=io.BytesIO()',
  'with zipfile.ZipFile(out,"w",compression=zipfile.ZIP_STORED) as archive:',
  ' for name,data in records:',
  '  info=zipfile.ZipInfo(name,(1980,1,1,0,0,0));info.create_system=3;info.external_attr=(stat.S_IFREG|0o644)<<16;info.compress_type=zipfile.ZIP_STORED;info.file_size=len(data)',
  '  with archive.open(info,"w") as entry: entry.write(data)',
  'sys.stdout.write(json.dumps({"manifest":manifest,"revision":revision,"zip":base64.b64encode(out.getvalue()).decode(),"files":[{"path":n,"size":len(d),"sha256":hashlib.sha256(d).hexdigest()} for n,d in records]}))'].join('\n');

function fixture() {
  const catalog = JSON.parse(fs.readFileSync(path.join(APPS, 'catalog/playground.json'), 'utf8')), served = new Map(), packages = new Map();
  const meta = JSON.parse(execFileSync('python3', ['-c', PACK, APPS, SLUG], {maxBuffer: 64 << 20}).toString());
  const bytes = Buffer.from(meta.zip, 'base64'), digest = sha(bytes), {manifest} = meta, version = manifest.version;
  const listing = Buffer.from(JSON.stringify({schemaVersion: 1, appId: manifest.id, version, revision: meta.revision, packageDigest: digest, base: RAW + ZERO + '/apps/' + SLUG + '/src/', files: meta.files}));
  const icon = fs.readFileSync(path.join(APPS, 'apps', SLUG, 'src', manifest.icon));
  served.set('catalog/assets/' + sha(listing) + '.json', listing);
  served.set('catalog/assets/' + sha(icon) + '.svg', icon);
  catalog.apps = catalog.apps.filter(app => app.slug !== SLUG);
  catalog.apps.push({
    appId: manifest.id, slug: SLUG, name: manifest.name, version, summary: manifest.guide.description, category: 'audiovisual', featured: null, tags: [],
    capabilities: Object.keys(manifest.capabilities).filter(key => manifest.capabilities[key] === true).sort(), size: bytes.length, revision: meta.revision, packageDigest: digest, roles: manifest.roles,
    assets: {
      files: {url: RAW + 'main/catalog/assets/' + sha(listing) + '.json', sha256: sha(listing), size: listing.length},
      package: {url: RELEASE + SLUG + '-v' + version + '/' + SLUG + '-' + version + '.vrchapp', size: bytes.length, sha256: digest},
      icon: {url: RAW + 'main/catalog/assets/' + sha(icon) + '.svg', sha256: sha(icon), size: icon.length, mediaType: 'image/svg+xml'},
    },
  });
  packages.set(SLUG + '-v' + version + '/' + SLUG + '-' + version, bytes);
  return {catalog: Buffer.from(JSON.stringify(catalog)), served, packages, manifest, size: bytes.length, files: meta.files};
}

// HIT_SHAPES_ORIGIN=https://host runs against a deployed Playground and the published App instead of this working tree.
const LIVE = (process.env.HIT_SHAPES_ORIGIN || '').replace(/\/$/, '');

async function start({gpu = !!process.env.HIT_SHAPES_GPU, viewport = {width: 1440, height: 900}, headless = true} = {}) {
  const fx = fixture();
  const server = LIVE ? null : http.createServer((req, res) => {
    const route = decodeURIComponent(req.url.split('?')[0]), marked = {'X-Vrch-Playground-Route': '1', 'Content-Type': 'application/octet-stream'};
    if (route === '/playground/events') { req.resume(); res.writeHead(204); return res.end(); }
    if (route.startsWith('/playground/github/') || route.startsWith('/playground/packages/')) {
      let body = null;
      const pkg = /^\/playground\/packages\/(.+)\.zip$/.exec(route);
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
  if (server) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = LIVE || 'http://127.0.0.1:' + server.address().port;
  const {chromium} = require(process.env.PLAYWRIGHT || path.join(path.dirname(process.execPath), '../lib/node_modules/playwright'));
  // Software GL by default; HIT_SHAPES_GPU=1 uses the machine's GPU for frame-rate measurements.
  const options = {executablePath: '/usr/bin/google-chrome', headless,
    args: [...(gpu ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']), '--autoplay-policy=no-user-gesture-required']};
  const browser = LIVE ? await chromium.launch(options) : await require(path.join(PAGES, 'tests/vrch_playground_test_github.cjs')).launch(chromium, options);
  const context = await browser.newContext({viewport});
  if (!LIVE) await context.route(RAW + '**', route => route.abort('blockedbyclient'));
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(origin) && !/^(data|blob|about):/.test(request.url())) requests.push(request.url()); });
  const settled = () => page.waitForFunction(() => !document.getAnimations().some(a => a.effect?.pseudoElement?.startsWith('::view-transition')) && !document.querySelector(':active-view-transition'), null, {timeout: 15000});
  // The App's two copies: the device's (control) and the big screen's (output).
  const frames = async () => {
    for (let i = 0; i < 300; i++) {
      const found = {};
      for (const frame of page.frames()) { try { const role = await frame.evaluate(() => window.__hitShapes?.role); if (role) found[role] = frame; } catch {} }
      if (found.control && found.output) return found;
      await page.waitForTimeout(100);
    }
    throw new Error('the control and output copies did not start');
  };
  const open = async (query = '') => {
    await page.goto(origin + '/playground?view=2d&app=' + SLUG + query);
    await page.keyboard.press('Shift'); // a visitor's first key
    await page.waitForFunction(() => document.body.dataset.output === 'panel', null, {timeout: 30000});
    await settled();
    return frames();
  };
  const control = (group, index) => page.locator('[data-hardware="' + group + '"] button').nth(index);
  const turn = async (index, dy) => {
    const box = await control('encoders', index).boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(x, y + dy * i / 8);
    await page.mouse.up(); await page.waitForTimeout(200);
  };
  return {fx, origin, browser, context, page, errors, requests, open, frames, settled, control, turn, key: index => control('keys', index), encoder: index => control('encoders', index),
    live: !!LIVE, close: async () => { await browser.close(); server?.close(); }};
}

module.exports = {start, fixture, APPS, PAGES, SLUG, assert};
