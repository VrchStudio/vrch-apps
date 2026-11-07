// Microphone Apps in a browser Preview, through the real Playground page, SDK, opaque runner and browser media.
// Chromium's synthetic microphone replaces the physical one only. Where the host hands the App this browser's
// microphone (the Playground), Pitch Shift and Vocal Chain open it and process it as on the device; where the host
// hands a silent preview input (remote My Apps Preview), they release it and keep their preview message.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const STATIC = path.join(process.env.VRCH_PAGES_ROOT || path.resolve(ROOT, '../vrch-web-viewer-pages'), 'static');
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2'};
const APPS = (process.env.APPS || 'pitch-shift,vocal-chain').split(',');
const OUT = fs.mkdtempSync('/tmp/vrch-mic-preview-');
function build(app) {
  const output = path.join(OUT, app), dist = path.join(ROOT, 'dist', app);
  fs.rmSync(dist, {recursive: true, force: true});
  execFileSync('python3', [path.join(ROOT, 'tools/apps.py'), 'build', app], {cwd: ROOT, stdio: 'ignore'});
  const name = fs.readdirSync(dist).filter(f => f.endsWith('.vrchapp')).sort().pop();
  fs.mkdirSync(output, {recursive: true}); fs.copyFileSync(path.join(dist, name), path.join(output, name)); return path.join(output, name);
}
(async () => {
  const packages = Object.fromEntries(APPS.map(app => [app, build(app)]));
  const server = http.createServer((req, res) => {
    const route = decodeURIComponent(req.url.split('?')[0]);
    if (route.startsWith('/playground/github/')) {res.writeHead(200, {'X-Vrch-Playground-Route': '1', 'Content-Type': 'application/json'}); return res.end(JSON.stringify({schemaVersion: 1, categories: [], apps: []}));}
    const file = path.join(STATIC, route);
    if (!file.startsWith(STATIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {res.writeHead(404); return res.end();}
    res.writeHead(200, {'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store'}); res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', args: ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']});
  const results = {};
  try {
    for (const silent of [false, true]) for (const app of APPS) {
      const context = await browser.newContext({permissions: ['microphone'], viewport: {width: 1440, height: 1100}});
      await context.addInitScript(silent => {
        if (window === top) {
          window.audioTracks = []; const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getUserMedia = async c => {const s = await gum(c); audioTracks.push(...s.getAudioTracks()); return s;};
          return;
        }
        // Stand in for the remote Preview host: the App's input arrives marked silent, as the host sends it there.
        if (!silent) return;
        const define = Object.defineProperty;
        Object.defineProperty = function (target, key, descriptor) {
          if (target !== window || key !== 'VrchApp') return define(target, key, descriptor);
          const sdk = descriptor.value, open = sdk.audio.openInput;
          const audio = {...sdk.audio, openInput: async options => ({...await open(options), silent: true})};
          return define(target, key, {...descriptor, value: Object.freeze({...sdk, audio: Object.freeze(audio)})});
        };
      }, silent);
      const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(30000);
      await page.goto(origin + '/vrch_playground.html?mode=make&view=2d');
      await page.waitForFunction(() => globalThis.vrchSimulator && document.querySelector('#storageState').textContent === '');
      await page.setInputFiles('#importFile', packages[app]);
      await page.getByRole('button', {name: 'Open', exact: true}).first().click();
      await page.waitForFunction(() => vrchSimulator.state().shell?.active && !vrchSimulator.state().shell.candidate, null, {timeout: 60000});
      const start = page.locator('#modal').getByRole('button', {name: 'Start', exact: true});
      const frame = await (await page.locator('#previewMount iframe').elementHandle()).contentFrame();
      await page.waitForTimeout(1500); if (await start.isVisible()) await start.click();
      const gateHidden = () => frame.waitForFunction(() => document.getElementById('gate').hidden, null, {timeout: 30000});
      if (!silent) {
        try {await page.waitForFunction(() => audioTracks.some(t => t.readyState === 'live'), null, {timeout: 30000}); await gateHidden();}
        catch (e) {console.error('microphone did not open:', app, JSON.stringify(await frame.evaluate(() => document.body.innerText.slice(0, 400))), errors); await page.screenshot({path: '/tmp/mic-debug.png'}); throw e;}
        // The synthetic microphone's tone reaches the App's DSP: Vocal Chain's tuner reads its pitch.
        if (app === 'vocal-chain') await frame.waitForFunction(() => / Hz$/.test(document.getElementById('hz').textContent), null, {timeout: 20000});
      } else {
        await gateHidden(); await page.waitForTimeout(1500);
        assert.equal(await page.evaluate(() => audioTracks.filter(t => t.readyState === 'live').length), 0, app + ' keeps no microphone open');
        if (app === 'vocal-chain') assert.equal(await frame.evaluate(() => document.getElementById('hz').textContent), 'No input in preview');
      }
      await page.screenshot({path: path.join(OUT, app + (silent ? '-preview' : '-microphone') + '.png')});
      assert.deepEqual(errors, [], app + ' ' + JSON.stringify(errors));
      results[app + (silent ? ' preview' : ' microphone')] = 'pass';
      await context.close();
    }
  } finally {await browser.close(); server.close();}
  console.log(JSON.stringify({pass: true, results, screenshots: OUT}));
})().catch(error => {console.error(error); process.exitCode = 1;});

