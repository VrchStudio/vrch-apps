/* Visual Settings view. The retained Settings pane owns every read and write. */
(() => {
  let host;
  const controls=VrchSceneParameterControls;
  const dialog=document.querySelector('[role=dialog]');
  const pages=Object.fromEntries([...document.querySelectorAll('[data-page]')].map(page=>[page.dataset.page,page]));
  const mounts=Object.fromEntries([...document.querySelectorAll('[data-parameters]')].map(mount=>[mount.dataset.parameters,mount]));
  const tabs=[...document.querySelectorAll('[data-tab]')];
  let page='quick',scrolls={quick:0,advanced:0};
  const popover=VrchPagesLiveConsoleActionPopover.createActionPopoverController({document,window});
  let revision=null, lists=[], snapshot=null, dragging=false;
  const audioParameters=['strength','low','mid','high'].map(key=>({key,label:key==='strength'?'Strength':key[0].toUpperCase()+key.slice(1),type:'float',min:0,max:4,step:.05}));
  function addGroup(label,parameters,state,kind='parameter',destination='advanced') {
    if(!parameters.length)return;
    const section=document.createElement('section'),heading=document.createElement('h2'),rows=document.createElement('div');
    heading.textContent=label;rows.className='scene-parameter-grid';if(label)section.append(heading);section.append(rows);mounts[destination].append(section);
    const target=state.revision;
    const list=new controls.ParameterList({mount:rows,onChange:({key,value,phase})=>{host.change({revision:target,kind,key,value,phase});sync()}});
    const instance=kind==='audio'?audioInstance(state):state.instance;
    list.render(state.definition,instance,parameters);
    for(const parameter of parameters){
      const control=rows.querySelector(`[data-param-key="${parameter.key}"]`);
      control.setAttribute('aria-label',parameter.label||parameter.key);
      if(control.matches('input[type=range]')){
        const row=control.closest('.scene-param-row');row.classList.add('scene-param-row--inline');
        const label=row.querySelector('[data-scene-parameter-label]');label.title=parameter.label||parameter.key;
      }
      control.querySelectorAll('[data-axis]').forEach(axis=>{
        const name=axis.dataset.axis==='0'?'X':'Y',row=document.createElement('span'),label=document.createElement('span');
        axis.setAttribute('aria-label',(parameter.label||parameter.key)+' '+name);
        row.className='scene-vec2-axis';label.textContent=name;control.append(row);row.append(label,axis);
      });
    }
    lists.push({list,kind});
  }
  function audioInstance(state){const audio=state.instance.modulation_master.audio;return {params:{strength:audio.strength??audio.gain??1,low:audio.band_gains?.low??1,mid:audio.band_gains?.mid??1,high:audio.band_gains?.high??1}}}
  function sync(){
    if(dialog.hidden)return;
    const state=host.getState();snapshot=state;
    // Hosts without image sources or fullscreen swipe (Apps) omit imageSettings and swipeFavoritesEnabled.
    document.querySelector('[data-gestures]').hidden=typeof state.swipeFavoritesEnabled!=='boolean';
    document.getElementById('swipe-favorites').checked=state.swipeFavoritesEnabled===true;
    const image=state.imageSettings;
    document.querySelector('[data-image-settings]').hidden=!image;
    if(image){
    for(const [id,kind,options] of [['display-mode','displayMode',image.displayModeOptions],['blend-mode','blendMode',[{id:'normal',label:'Normal'},{id:'difference',label:'Difference'}]]]){
      const group=document.getElementById(id);
      if(!group.childElementCount)for(const option of options){
        const button=document.createElement('button');button.type='button';button.className='ui-grid-btn';
        button.dataset.value=option.id;button.textContent=option.label;
        button.addEventListener('click',()=>{host.change({revision:snapshot.imageSettings.revision,kind,value:option.id});sync()});group.append(button);
      }
      for(const button of group.children){
        const active=button.dataset.value===image[kind];button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',String(active));button.disabled=!image.editable;
      }
    }
    document.getElementById('background-reset').disabled=!image.editable;
    const band=document.getElementById('background-band'),indicator=document.getElementById('background-indicator');
    band.setAttribute('aria-disabled',String(!image.editable));band.tabIndex=image.editable?0:-1;
    band.setAttribute('aria-valuenow',String(Math.round(image.backgroundHueRatio*360)));
    band.setAttribute('aria-valuetext',image.backgroundColour.toUpperCase());
    document.getElementById('background-value').textContent=image.backgroundColour.toUpperCase();
    indicator.style.left=(image.backgroundHueRatio*100)+'%';indicator.style.top=(image.backgroundLightRatio*100)+'%';indicator.style.backgroundColor=image.backgroundColour;
    }
    document.getElementById('visual-name').textContent=state.visual?.label||'';
    document.getElementById('visual-name').hidden=!state.visual;
    document.getElementById('visual-name').title=state.visual?.label||'';
    document.querySelector('[data-empty]').hidden=!!state.visual || state.loading;
    const sourceCount=state.sourceCount;
    const status=document.getElementById('visual-status');
    status.textContent=state.message||'';status.hidden=!state.message;
    document.querySelector('[data-sources]').hidden=!sourceCount;
    for(const slot of ['A','B']){
      const row=document.querySelector(`[data-source=${slot}]`);row.hidden=sourceCount<(slot==='A'?1:2);
      const button=row.querySelector('button');button.textContent='CH '+(state.sources?.[slot]||'');button.title=state.channelOptions?.find(item=>item.id===state.sources?.[slot])?.label||'';button.disabled=!state.editable;
    }
    if(state.revision!==revision){
      revision=state.revision;dragging=false;popover.close();lists=[];for(const mount of Object.values(mounts))mount.replaceChildren();scrolls={quick:0,advanced:0};
      if(state.visual){
        const parameters=state.definition.parameters,primary=controls.primaryParameters(parameters,3,state.definition.ui?.simple_parameters);
        addGroup('',primary,state,'parameter','quick');
        const groups=new Map();
        for(const parameter of parameters){if(primary.includes(parameter))continue;const name=parameter.group||'Parameters';if(!groups.has(name))groups.set(name,[]);groups.get(name).push(parameter)}
        for(const [name,items] of groups)addGroup(name,items,state);
        if(controls.supportsAudio(state.definition))addGroup('Audio response',audioParameters,state,'audio');
      }
      selectPage('quick',false);
    }
    for(const {list,kind} of lists){list.setDisabled(!state.editable);list.sync(kind==='audio'?audioInstance(state):state.instance,{force:!dragging})}
  }
  function selectPage(next,remember=true,focus=false){
    if(!pages[next]||tabs.find(tab=>tab.dataset.tab===next).disabled)return;
    if(remember)scrolls[page]=pages[page].scrollTop;
    popover.close();dragging=false;page=next;
    for(const tab of tabs){const active=tab.dataset.tab===page;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;pages[tab.dataset.tab].hidden=!active}
    pages[page].scrollTop=scrolls[page];
    if(focus)tabs.find(tab=>tab.dataset.tab===page).focus();
  }
  for(const tab of tabs)tab.addEventListener('click',()=>selectPage(tab.dataset.tab));
  document.querySelector('[role=tablist]').addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const enabled=tabs.filter(tab=>!tab.disabled),index=enabled.findIndex(tab=>tab.dataset.tab===page);
    const next=event.key==='Home'?0:event.key==='End'?enabled.length-1:(index+(event.key==='ArrowRight'?1:-1)+enabled.length)%enabled.length;
    event.preventDefault();selectPage(enabled[next].dataset.tab,true,true);
  });
  // Page changes never rebuild controls. Native range dragging owns horizontal
  // edits; vertical gestures stay with the active page's own scroll container.
  for(const mount of Object.values(mounts)){
    mount.addEventListener('pointerdown',()=>{dragging=true});
    const finish=()=>{dragging=false;sync()};
    mount.addEventListener('pointerup',finish);mount.addEventListener('pointercancel',finish);
  }
  for(const row of document.querySelectorAll('[data-source]'))row.querySelector('button').addEventListener('click',()=>{
    const target=snapshot.revision,slot=row.dataset.source;
    popover.open(row.querySelector('button'),snapshot.channelOptions.map(item=>({...item,current:item.id===snapshot.sources[slot]})),{minWidth:96,matchWidth:true,align:'right',onSelect:item=>{host.change({revision:target,kind:'source',key:slot,value:item.id});sync()}});
  });
  const band=document.getElementById('background-band');
  let colourRevision=null;
  function colourPoint(event){
    const rect=band.getBoundingClientRect();
    host.change({revision:colourRevision,kind:'backgroundPoint',value:{hueRatio:(event.clientX-rect.left)/Math.max(1,rect.width),lightRatio:(event.clientY-rect.top)/Math.max(1,rect.height)}});sync();
  }
  band.addEventListener('pointerdown',event=>{
    if(!snapshot.imageSettings.editable || event.button!==0)return;
    colourRevision=snapshot.imageSettings.revision;band.setPointerCapture(event.pointerId);colourPoint(event);
  });
  band.addEventListener('pointermove',event=>{if(band.hasPointerCapture(event.pointerId))colourPoint(event)});
  for(const type of ['pointerup','pointercancel'])band.addEventListener(type,event=>{if(band.hasPointerCapture(event.pointerId))band.releasePointerCapture(event.pointerId)});
  band.addEventListener('keydown',event=>{
    if(!snapshot.imageSettings.editable || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
    event.preventDefault();
    const image=snapshot.imageSettings,step=event.shiftKey?.08:.03;
    const hueRatio=image.backgroundHueRatio+(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0);
    const lightRatio=image.backgroundLightRatio+(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0);
    host.change({revision:image.revision,kind:'backgroundPoint',value:{hueRatio,lightRatio}});sync();
  });
  document.getElementById('background-reset').onclick=()=>{host.change({revision:snapshot.imageSettings.revision,kind:'backgroundReset'});sync()};
  document.getElementById('swipe-favorites').onchange=event=>{host.change({kind:'swipeFavorites',value:event.target.checked});sync()};
  document.querySelector('.ui-dialog__close').onclick=()=>host.onClose();
  document.querySelector('[data-choose]').onclick=()=>host.onChoose();
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!event.defaultPrevented&&!popover.isOpen()){event.preventDefault();host.onClose()}
    if(event.key==='Tab'){
      const items=[...dialog.querySelectorAll('button,input,select,[tabindex="0"]')].filter(e=>!e.disabled&&e.getClientRects().length);
      const first=items[0],last=items.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
    }
  });
  window.VrchVisualSettings={
    connect(callbacks){host=callbacks},
    open(){dialog.hidden=false;dialog.classList.add('is-visible');sync();selectPage(page,false);document.querySelector('.ui-dialog__close').focus({preventScroll:true})},
    close(){scrolls[page]=pages[page].scrollTop;popover.close();dragging=false;dialog.classList.remove('is-visible');dialog.hidden=true},sync
  };

})();
