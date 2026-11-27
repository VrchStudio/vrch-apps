const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');

(async () => {
  const browser = await chromium.launch({channel:'chrome'});
  try {
    const page = await browser.newPage({viewport:{width:480,height:432}});
    await page.addInitScript(() => {
      window.sent = [];
      window.VrchApp = {
        ready:async () => {}, context:{mode:'device'},
        controls:{onEvent(fn) { window.control = fn; }},
        monitor:{async set(labels) { window.labels = labels; }},
        audio:{async openOutput() {
          return {createNode:async ctx=>ctx.createGain(), onError() {}, close:async()=>{}};
        }},
        midi:{async requestPort() {
          return window.port = {state:'open', name:'USB to computer / tablet',
            onStateChange(fn) { this.change = state => { this.state = state; fn({state}); }; },
            async send(bytes) { window.sent.push(Array.from(bytes)); }};
        }}
      };
    });
    await page.goto(pathToFileURL(path.resolve(__dirname,'../apps/note-deck/src/index.html')).href);
    const button = name => page.getByRole('button',{name,exact:true});
    const status = page.locator('#event');
    const pad = page.locator('[data-note="48"]');
    await pad.click();
    assert.equal(await status.textContent(),'Not sent · Connect USB');
    await page.evaluate(() => window.control({type:'down',control:'K2'}));
    assert.deepEqual(await page.evaluate(() => window.sent),[]);
    await button('Connect USB').click();
    assert(await button('USB · Ch 1').isVisible());
    const box = await pad.boundingBox();
    for (const height of [.98,.65,.5,.35,.02]) {
      await page.mouse.click(box.x+box.width/2,box.y+box.height*height);
    }
    const velocities = await page.evaluate(() => window.sent.filter(b=>b[0]===144).map(b=>b[2]));
    assert(velocities[0]>=24 && velocities[0]<35 && velocities[4]>=120);
    assert(velocities[1]>=70 && velocities[2]>=79 && velocities[3]<=90);
    assert.equal(new Set(velocities).size,5);
    await button('Macros 1–4').click();
    await button('C Major').click();
    assert(await page.locator('#velocity-tip').isVisible());
    assert(await status.evaluate(e => document.elementFromPoint(e.getBoundingClientRect().right-4,e.getBoundingClientRect().top+4)===e));
    await page.evaluate(() => {
      window.sent.length=0;
      window.control({type:'rotate',control:'E1',delta:4});
      window.control({type:'down',control:'K2'});
    });
    // Changing root while a performance key is held must preserve its release.
    await page.locator('#roots button').nth(2).click();
    assert.deepEqual(await page.evaluate(() => window.sent),[[176,24,68],[176,100,127]]);
    await page.evaluate(() => {
      window.control({type:'up',control:'K2'});
      window.control({type:'down',control:'K3'});
      window.control({type:'up',control:'K3'});
      window.control({type:'down',control:'K4'});
      window.control({type:'up',control:'K4'});
    });
    assert.deepEqual(await page.evaluate(() => window.sent.slice(2)),[[176,100,0],[176,101,127],[176,101,0],[176,102,127],[176,102,0]]);
    await button('Done').click();
    assert(await button('Macros 5–8').isVisible());
    await button('Drums').click();
    assert.equal(await page.locator('#pads button').count(),16);
    assert.equal(await page.locator('#drum-range').evaluate(e=>e.tagName),'SPAN');
    assert(await page.locator('#drum-range').isVisible());
    const drum = page.locator('[data-note="36"]');
    await page.evaluate(() => window.port.change('suspended'));
    await drum.click();
    assert.match(await status.textContent(),/Not sent.*Wake/);
    await page.evaluate(() => window.port.change('open'));
    await drum.click();
    assert.deepEqual(await page.evaluate(() => window.sent.at(-1)),[128,36,0]);
    await page.evaluate(() => window.port.change('closed'));
    assert(await button('Connect USB').isVisible());
    await drum.click();
    assert.equal(await status.textContent(),'Not sent · Connect USB');
    await button('Connect USB').click();
    await drum.click();
    assert.match(await status.textContent(),/C1.*Off/);
    const sound=page.getByRole('switch',{name:'Local sound'});
    assert.equal(await sound.getAttribute('aria-checked'),'false');
    await sound.click();
    await page.waitForSelector('#sound[aria-checked=true]');
    const pos=await drum.boundingBox();
    await page.mouse.move(pos.x+pos.width/2,pos.y+pos.height/2);
    await page.mouse.down();
    await page.evaluate(() => window.port.change('closed'));
    assert(await drum.evaluate(el=>el.classList.contains('down')));
    await page.mouse.up();
    assert.match(await status.textContent(),/C1.*Off/);
    const soloCount=await page.evaluate(()=>window.sent.length);
    await drum.click();
    assert.equal(await page.evaluate(()=>window.sent.length),soloCount);
    await button('Connect USB').click();
    await page.mouse.move(pos.x+pos.width/2,pos.y+pos.height/2);
    await page.mouse.down();
    // Toggle with a second input while the pad stays held.
    await sound.evaluate(el=>el.click());
    await page.waitForSelector('#sound[aria-checked=false]:enabled');
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(()=>window.sent.slice(-2).map(b=>b.slice(0,2))),[[144,36],[128,36]]);
    console.log('PASS standalone pads, MIDI disconnect during a local voice, MIDI release after muting local sound');
    console.log('PASS offline feedback, velocity, controls during key changes, macro names, drum range and reconnect');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
