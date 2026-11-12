// Chladni 3D in the real Playground, with the Chladni harness (tests/chladni_playground.cjs, CHLADNI_SLUG=chladni-3d):
// it opens silent with the box and its sand and asks for nothing; E1, E2 and E4 change n, m and l, a press of E4 the
// weave; K2 plays the note through the host; a large output follows the device; the figure comes back after a reload.
//   node tests/chladni_3d_browser.cjs            (CHLADNI_GPU=1 and CHLADNI_ORIGIN work as for Chladni)
process.env.CHLADNI_SLUG = 'chladni-3d'; process.env.CHLADNI_OUT = process.env.CHLADNI_OUT || '/tmp/chladni-3d-test';
const assert = require('node:assert/strict'), path = require('node:path');
const {open, OUT, GPU} = require('./chladni_playground.cjs');

(async () => {
  const t = await open(), {state, stats} = t, result = {gpu: GPU, origin: t.origin, packageBytes: t.fx?.size};
  const everyFrame = async (page, read) => { const all = []; for (const frame of page.frames()) all.push(...await frame.evaluate(read).catch(() => [])); return all; };
  const figure = s => ({n: s.n, m: s.m, l: s.l, weave: s.weave, palette: s.palette});
  try {
    const v = await t.visit(''), app = await v.find('control');
    result.firstFrameMs = await app.evaluate(() => __chladni.firstFrameAt);
    const first = await state(app);
    await v.page.waitForTimeout(1500);
    result.first = {state: first, stats: await stats(app)};
    assert(result.first.stats.grains > 0, 'the box has its sand');
    assert.equal(first.sound, false); assert.equal((await t.heard(v.page, 1500)).left, 0, 'it opens silent');
    assert.deepEqual(await everyFrame(v.page, () => window.__asked || []), [], 'nothing is asked for');

    await v.turn(0, 2); await v.turn(1, 1); await v.turn(3, 1); await v.page.waitForTimeout(600);
    const turned = await state(app);
    assert(turned.n !== first.n && turned.m !== first.m && turned.l !== first.l, 'E1, E2 and E4 change n, m and l: ' + JSON.stringify({first, turned}));
    await v.press(3); await v.page.waitForTimeout(400);
    const woven = await state(app); assert.notEqual(woven.weave, turned.weave, 'a press of E4 changes the weave');

    await v.key(1); await v.page.waitForTimeout(1200);
    const sounding = await state(app), heard = await t.heard(v.page, 800);
    result.sound = {state: sounding.sound, note: sounding.note, heard};
    assert.equal(sounding.sound, true); assert(heard.left > 0.001, 'K2 plays the note through the host: ' + JSON.stringify(heard));
    assert.deepEqual(await everyFrame(v.page, () => window.__asked || []), [], 'sound asks for no input');
    await v.key(1); await v.key(1); await v.page.waitForTimeout(400);

    const out = await v.output(); await v.page.waitForTimeout(1500);
    const shown = await state(out);
    result.output = {state: shown, stats: await stats(out)};
    assert.deepEqual(figure(shown), figure(woven), 'the large output shows the same box');
    assert(result.output.stats.grains > 0, 'the output has sand of its own');
    await v.page.screenshot({path: path.join(OUT, 'chladni-3d-output.png')});

    await v.page.reload(); const again = await v.find('control'), back = await state(again);
    assert.deepEqual(figure(back), figure(woven), 'the figure is saved'); assert.equal(back.sound, false, 'sound starts off again');
    await v.page.screenshot({path: path.join(OUT, 'chladni-3d-reload.png')});
    assert.deepEqual(t.errors, [], 'no page errors');
    console.log(JSON.stringify({pass: true, ...result, screenshots: OUT}));
  } finally { await t.close(); }
})().catch(error => { console.error(error); process.exit(1); });
