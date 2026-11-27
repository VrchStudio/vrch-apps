const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');

(async () => {
  const browser = await chromium.launch({channel:'chrome'});
  try {
    const page = await browser.newPage({viewport:{width:480, height:432}});
    await page.addInitScript(() => {
      function input(name) {
        return {name, state:'open', onMessage(fn) { this.emit = fn; }, onStateChange(fn) { this.change = fn; }};
      }
      const pad = input('STARRYPAD MIDI 1');
      const usb = input('USB from computer / tablet');
      const output = {name:'USB to computer / tablet', state:'open', sent:[],
        async send(bytes) { this.sent.push(Array.from(bytes)); },
        onStateChange(fn) { this.change = state => { this.state=state; fn({state}); }; }};
      const choices = [pad, null, usb];
      window.portsUnderTest = {pad, usb, output};
      window.VrchApp = {ready:async () => {}, context:{mode:'device'}, controls:{onEvent(fn) { window.control = fn; }},
        monitor:{async set(values) { window.panel = values; }},
        midi:{requestPort:async ({direction}) => direction==='input' ? choices.shift() : output}};
    });
    const url = pathToFileURL(path.resolve(__dirname,'../apps/midi-monitor/src/index.html'));
    await page.goto(url.href);
    const choose = () => page.locator('#input').click();
    const count = () => page.locator('#count').textContent();
    const raw = () => page.locator('#raw').textContent();
    await choose();
    await page.evaluate(() => portsUnderTest.pad.emit(Uint8Array.of(0x99,78,94)));
    await page.waitForFunction(() => document.querySelector('#count').textContent === '1 received');
    await choose(); // Cancel keeps the original port and its measurement.
    assert.equal(await raw(),'99 4E 5E');
    await choose();
    assert.match(await page.locator('#input').textContent(), /USB from/);
    assert.equal(await count(),'0 received');
    assert.equal(await raw(),'—');
    assert.equal(await page.locator('#note').textContent(),'—');
    assert.equal(await page.locator('#meter i').evaluate(el => el.offsetWidth),0);
    await page.evaluate(() => {
      portsUnderTest.pad.emit(Uint8Array.of(0x99,55,50));
      portsUnderTest.usb.emit(Uint8Array.of(0x9f,91,127));
    });
    await page.waitForFunction(() => document.querySelector('#raw').textContent === '9F 5B 7F');
    assert.equal(await count(),'1 received');
    await page.evaluate(() => {
      portsUnderTest.usb.emit(Uint8Array.of(0x8f,91,0));
      portsUnderTest.usb.change({state:'closed'});
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await count(),'0 received');
    assert.equal(await raw(),'—');
    assert.match(await page.locator('#input').textContent(), /Choose port/);
    await page.locator('#output').click();
    await page.evaluate(() => {
      for (const [control, delta] of [['E1',1],['E2',4],['E3',-15],['E4',-63]]) window.control({control,type:'rotate',delta});
      window.control({control:'K3',type:'down'});
      // Changing pitch/channel during a note must still release the original note.
      window.control({control:'E2',type:'rotate',delta:7});
      window.control({control:'E1',type:'rotate',delta:1});
      window.control({control:'K3',type:'down'});
      window.control({control:'K3',type:'up'});
      window.control({control:'K4',type:'down'});
      window.control({control:'K4',type:'up'});
    });
    await page.waitForFunction(() => portsUnderTest.output.sent.length === 3 && window.panel?.E2.value === 'B4');
    assert.deepEqual(await page.evaluate(() => portsUnderTest.output.sent),[[0x91,64,81],[0xb2,1,64],[0x81,64,0]]);
    assert.equal(await count(),'0 received');
    await page.locator('#send-E4').focus();
    await page.keyboard.press('Home');
    await page.locator('#testCC').click();
    assert.deepEqual(await page.evaluate(() => portsUnderTest.output.sent.at(-1)),[0xb2,1,0]);
    await page.evaluate(() => portsUnderTest.output.change('suspended'));
    assert(await page.locator('#testNote').isDisabled());
    await page.evaluate(() => portsUnderTest.output.change('open'));
    assert(await page.locator('#testNote').isEnabled());
    console.log('PASS encoders, key edges, release after parameter change, touch controls, monitor labels and suspend/resume');
    console.log('PASS MIDI Monitor input selection, cancellation, replacement and disconnect');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode=1; });
