// Camera Apps in a browser Preview, through the real Playground page, SDK, opaque runner and browser media. Chromium's
// synthetic camera replaces the physical one only. Where the host hands the App this browser's camera (the Playground),
// Body Vibes, PalmNotes Duo and Hardware Check open it as on the device; where the browser cannot capture frames
// (no MediaStreamTrackProcessor, as in Safari or Firefox) they keep their preview screens and open nothing.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const STATIC = path.join(process.env.VRCH_PAGES_ROOT || path.resolve(ROOT, '../vrch-web-viewer-pages'), 'static');
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2'};
const APPS = (process.env.APPS||'body-vibes,palmnotes-duo,hardware-check').split(',');
const OUT = fs.mkdtempSync('/tmp/vrch-camera-preview-');
function build(app) {
  const output = path.join(OUT, app);
  execFileSync('python3', [path.join(ROOT, 'tools/apps.py'), 'build', app], {cwd: ROOT, stdio: 'ignore'});
  const dist = path.join(ROOT, 'dist', app), name = fs.readdirSync(dist).filter(f => f.endsWith('.vrchapp')).sort().pop();
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
  const browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', args: ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  const results = {};
  try {
    for (const capture of [true, false]) for (const app of APPS) {
      const context = await browser.newContext({permissions: ['camera', 'microphone'], viewport: {width: 1440, height: 1100}});
      await context.addInitScript(capture => {
        if (window !== top) return;
        if (!capture) delete window.MediaStreamTrackProcessor;
        window.videoTracks = []; const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async c => {const s = await gum(c); videoTracks.push(...s.getVideoTracks()); return s;};
      }, capture);
      const page = await context.newPage(), errors = [], routine = {loud: [], quiet: 0}; page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(30000);
      // MediaPipe's routine stderr ("INFO: ...", "W0000 ...") must reach the console at debug level, never as an error or warning.
      page.on('console', m => {if (/^(INFO: |[IW]\d{4} )/.test(m.text())) {if (m.type() === 'error' || m.type() === 'warning') routine.loud.push(m.type() + ': ' + m.text().slice(0, 80)); else routine.quiet++;}});
      await page.goto(origin + '/vrch_playground.html?mode=make&view=2d');
      await page.waitForFunction(() => globalThis.vrchSimulator && document.querySelector('#storageState').textContent === '');
      await page.setInputFiles('#importFile', packages[app]);
      await page.getByRole('button', {name: 'Open', exact: true}).first().click();
      await page.waitForFunction(() => vrchSimulator.state().shell?.active && !vrchSimulator.state().shell.candidate, null, {timeout: 60000});
      if (await page.locator('#previewMenu').isVisible()) await page.locator('#previewMenu').getByRole('button', {name: 'Start', exact: true}).click();
      const start = page.locator('#modal').getByRole('button', {name: 'Start', exact: true});
      const frame = await (await page.locator('#previewMount iframe').elementHandle()).contentFrame();
      await page.waitForTimeout(1500); if (await start.isVisible()) await start.click();
      // PalmNotes asks for sound on K2; an imported App confirms it in the host's Start audio dialog.
      if (app === 'palmnotes-duo' && capture) {await page.waitForTimeout(1500); await page.click('[data-input="K2"]'); await start.waitFor({state: 'visible', timeout: 10000}); await start.click();}
      // BODY VIBES waits for K2 before it asks for the camera.
      if (app === 'body-vibes' && capture) {await frame.waitForFunction(() => BodyVibesDiagnostics.snapshot().phase === 'ready', null, {timeout: 30000}); assert.equal(await page.evaluate(() => videoTracks.length), 0); await page.click('[data-input="K2"]'); if (await start.isVisible().catch(() => false)) await start.click();}
      // 1440x1100 shows the 2D screen 1:1, where Playwright's clicks inside the App frame land where they aim.
      if (app === 'hardware-check') await frame.click('#cameraTab');
      const live = () => page.waitForFunction(() => videoTracks.some(t => t.readyState === 'live'), null, {timeout: 45000});
      if (capture) {
        try{await live();}catch(e){console.error('camera did not open:',app,JSON.stringify(await frame.evaluate(()=>document.body.innerText.slice(0,400))),JSON.stringify(await page.evaluate(()=>({tracks:videoTracks.length,modal:document.querySelector('#modal')?.open,fb:document.getElementById('stageFeedback')?.textContent}))),errors);await page.screenshot({path:'/tmp/cam-debug.png'});throw e;}
        if (app === 'hardware-check') {
          await frame.waitForFunction(() => cameraCheck.state === 'live' && cameraCheck.frames > 0);
          // E1 press starts Face tracking; the tracker must load its Worker and return inferences, not only show the camera.
          await page.click('[data-input="E1"]');
          await frame.waitForFunction(() => trackingCheck.mode === 'face' && (trackingCheck.state === 'error' || trackingCheck.inferences > 2), null, {timeout: 60000});
          assert.deepEqual(await frame.evaluate(() => ({state: trackingCheck.state, error: trackingCheck.error})), {state: 'ready', error: null}, 'hardware-check tracking runs');
        }
        if (app === 'body-vibes') await frame.waitForFunction(() => BodyVibesDiagnostics.snapshot().phase === 'live' && BodyVibesDiagnostics.snapshot().metrics.frames > 0, null, {timeout: 60000});
        if (app === 'palmnotes-duo') {assert.equal(await frame.evaluate(() => document.body.classList.contains('is-preview')), false); await frame.waitForFunction(() => PalmNotesDuo.state.phase === 'live' && PalmNotesDuo.state.frames > 0, null, {timeout: 60000});}
      } else {
        await page.waitForTimeout(4000);
        assert.equal(await page.evaluate(() => videoTracks.length), 0, app + ' opens no camera');
        const text = await frame.evaluate(() => document.body.innerText);
        if (app === 'body-vibes') assert.match(text, /Press K2 to begin/);
        if (app === 'palmnotes-duo') assert.equal(await frame.evaluate(() => document.body.classList.contains('is-preview')), true);
        if (app === 'hardware-check') assert.match(text, /Launch on the device to test its camera/);
      }
      await page.screenshot({path: path.join(OUT, app + (capture ? '-camera' : '-preview') + '.png')});
      assert.deepEqual(errors, [], app + ' ' + JSON.stringify(errors));
      assert.deepEqual(routine.loud, [], app + ' routine tracking logs stay at debug level');
      if (capture) assert.ok(routine.quiet > 0, app + ' tracking logs are observed');
      results[app + (capture ? ' camera' : ' preview')] = 'pass';
      await context.close();
    }
  } finally {await browser.close(); server.close();}
  console.log(JSON.stringify({pass: true, results, screenshots: OUT}));
})().catch(error => {console.error(error); process.exitCode = 1;});
