const assert=require('node:assert/strict'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process'),readline=require('node:readline'),{chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'..'),pages=process.env.VRCH_PAGES_ROOT||path.resolve(ROOT,'../vrch-web-viewer-pages');
(async()=>{
  execFileSync('python3',[path.join(ROOT,'tools/apps.py'),'build','palm-notes'],{cwd:ROOT,stdio:'ignore'});
  const driver=spawn('python3',[path.join(pages,'tests/vrch_apps_maker_browser_driver.py')]);driver.stderr.on('data',data=>process.stderr.write(data));
  const lines=readline.createInterface({input:driver.stdout});
  const info=await new Promise((resolve,reject)=>{lines.once('line',line=>resolve(JSON.parse(line)));driver.once('exit',code=>reject(Error('Driver '+code)));});
  const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome'});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(()=>{
      if(window!==top)return;window.captureCalls=0;
      localStorage.setItem('vrch-apps-preview-view','2d');
      const capture=navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
      if(capture)navigator.mediaDevices.getUserMedia=(...args)=>{captureCalls++;return capture(...args);};
    });
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
    await page.goto(new URL('/apps',info.url.replace('apps-usb.test','localhost')).href);
    await page.getByRole('button',{name:'Connect device',exact:true}).click();
    await page.locator('#importFile').setInputFiles(path.join(ROOT,'dist/palm-notes/palm-notes-0.1.0.vrchapp'));
    await page.locator('#appList .ui-card-row').filter({hasText:'PalmNotes'}).getByRole('button',{name:'Edit',exact:true}).click();
    await page.locator('#previewMount iframe').waitFor();
    await page.getByRole('button',{name:'Start',exact:true}).click();
    let app;
    for(let i=0;i<100;i++) {
      app=page.frames().find(f=>f.url().includes('/r/'));
      if(app&&await app.locator('#notes button').count()===7)break;
      await page.waitForTimeout(100);
    }
    const guide=page.getByRole('button',{name:'Start',exact:true});if(await guide.isVisible())await guide.click();
    await app.waitForFunction(()=>!document.getElementById('start').disabled);
    assert.equal(await app.evaluate(()=>PalmNotes.state.preview),true);
    assert.equal(await page.evaluate(()=>captureCalls),0);
    await app.locator('body').screenshot({path:'/tmp/palm-notes/evidence/preview-idle.png'});
    const first=app.locator('#notes button').first();
    await first.click();await app.waitForFunction(()=>PalmNotes.state.phase==='error');
    assert.match(await app.locator('#message').innerText(),/Listen/);
    await page.getByRole('button',{name:'More options',exact:true}).click();
    await page.getByRole('menuitem',{name:'Listen to preview',exact:true}).click();
    await first.click();
    await app.waitForFunction(()=>PalmNotes.state.phase==='live'&&PalmNotes.state.count===1);
    await app.locator('body').screenshot({path:'/tmp/palm-notes/evidence/preview-note.png'});
    await app.waitForFunction(()=>PalmNotes.state.count===null);
    await first.focus();await page.keyboard.down('Space');await app.waitForFunction(()=>PalmNotes.state.count===1);
    await page.keyboard.up('Space');await app.waitForFunction(()=>PalmNotes.state.count===null);
    for(const voice of ['Soft','Bell','Pluck','Retro']) {
      await app.locator('#voice').click();await app.getByRole('menuitem',{name:new RegExp('^'+voice)}).click();
      await app.getByRole('button',{name:'Preview Si',exact:true}).click();await app.waitForFunction(()=>PalmNotes.state.count===7);
      assert.equal(await app.locator('#count').innerText(),'OK');await app.waitForFunction(()=>PalmNotes.state.count===null);
    }
    await app.waitForFunction(async()=> (await VrchApp.data.get('settings')).value.voice==='retro');
    await page.getByRole('button',{name:'More options',exact:true}).click();
    await page.getByRole('menuitem',{name:'Stop listening',exact:true}).click();
    await page.getByRole('button',{name:'More options',exact:true}).click();
    await page.getByRole('menuitem',{name:'Listen to preview',exact:true}).click();
    await app.waitForFunction(()=>['idle','error'].includes(PalmNotes.state.phase));
    await first.click();await app.waitForFunction(()=>PalmNotes.state.count===1);await app.waitForFunction(()=>PalmNotes.state.count===null);
    assert.equal(await page.evaluate(()=>captureCalls),0);assert.deepEqual(errors,[]);
    console.log('PASS normal package import + Maker/Relay/SDK Preview: no camera, Listen gate, bounded pointer/keyboard notes, Stop/Listen retry');
  } catch(error) {
    for(const page of contextPages(browser)) {await page.screenshot({path:'/tmp/palm-notes/evidence/preview-failure.png'});console.log(await page.locator('body').innerText());}
    throw error;
  } finally {await browser.close();driver.stdin.end();await new Promise(resolve=>driver.once('exit',resolve));lines.close();}
})().catch(error=>{console.error(error);process.exit(1);});
function contextPages(browser){return browser.contexts().flatMap(c=>c.pages());}
