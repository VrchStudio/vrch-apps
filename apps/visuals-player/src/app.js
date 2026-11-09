/* Visuals Player: music-driven visuals from the shared Scene library, controlled the way Live Console controls a Visual.
   The picture is the product: nothing is drawn over it while it plays. K3 opens Visuals (hold: Visual Settings),
   K4 opens Player (sound, tracks, auto change, camera), K2 pages the encoders as in Live Console. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const contract = VrchSceneContract, controls = VrchSceneParameterControls;
  const KNOBS = ['E1', 'E2', 'E3', 'E4'], SPEEDS = [1, 2, 4], HOLD_MS = 650;
  // Auto change follows the music's sections; without sections (input) it waits this long.
  const AUTO_MIN_MS = 24000, AUTO_FALLBACK_MS = 40000, PLAYED_IDLE_MS = 60000, SAVE_MS = 800;
  const SLOW_FPS = 45, SLOW_SECONDS = 3, TRACK_RELAY_MS = 66, FRAME_RELAY_MS = 66, AUDIO_RELAY_MS = 33, TIMING_RELAY_MS = 4000;
  const COLLECTIONS = ['curated'];
  // Image visuals that read best with a particular picture; the others take the next one in turn.
  const PICTURE_FOR = {'vrch.matrix': 'portrait', 'user.vp-rain-glass': 'rain-street', 'user.vp-print-echo': 'keys'};
  const DATA_KEY = 'player';
  const isOutput = VrchApp.context?.role === 'output';
  const relay = VrchApp.output || null;
  document.body.dataset.role = isOutput ? 'output' : 'control';

  let catalog = null, selection = null, labels = new Map(), playlistKeys = [];
  // Image visuals show the built-in pictures (as Image Viewer shows its images) until the camera is on.
  let pictures = [], pictureIndex = 0;
  let active = null, instances = {}, mirror = null, music = null, picker = null, popover = null;
  let page = 0, speeds = {E1: 1, E2: 1, E3: 1, E4: 1}, auto = true, open = null, presented = 0;
  let lastChangeAt = 0, playedAt = -Infinity, interacted = false, followed = null, pickerStore = {};
  let monitorDirty = true, monitorBusy = false, saveTimer = 0, saved = {version: 0}, holdTimers = {};
  let degradeLevel = 0, slowSeconds = 0, baselineFps = 0, lastTrackRelay = 0, lastFrameRelay = 0, lastAudioRelay = 0, lastTimingRelay = 0;
  let cameraWanted = false, cameraState = 'off', cameraError = '';
  const camera = !isOutput && VrchApp.camera ? new VisualsCamera.Camera({sdk: VrchApp, onFrame: cameraFrame, onEnded: cameraEnded}) : null;
  const picture = isOutput ? new VisualsCamera.RelayPicture() : null, pictureJoin = isOutput ? new VisualsCamera.PictureJoin() : null;
  let pictureId = 0;

  // Read-only diagnostics for tests and measurements.
  const stats = window.__visualsPlayer = {role: isOutput ? 'output' : 'control', startedAt: performance.now(), firstFrameAt: null,
    firstInteraction: null, changes: [], controls: [], received: [], camera: null, analysis: null, fps: null, degrades: [], simd: VisualsCamera.simd,
    state: () => ({scene_id: active?.definition.scene_id || null, key: active?.key || null, title: active ? title(active) : null, open, page, speeds: {...speeds}, auto,
      picture: active && needsPicture(active.definition) && !camera?.on ? pictures[pictureIndex]?.id || null : null,
      camera: cameraState, music: music?.state() || null, playlist: playlistKeys.map(key => catalog.get(key)?.definition.scene_id),
      params: clone(active?.instance.params || {}), audio: clone(active?.instance.modulation_master?.audio || null),
      performance: mirror?.getPerformanceState() || null, analysis: mirror?.getAnalysisStatus?.() || null,
      drawing_buffer: mirror?.renderer ? {width: mirror.renderer.domElement.width, height: mirror.renderer.domElement.height} : null}),
    signal: id => mirror?.effect?.signalBus?.values[id] ?? null};

  function fatal(text) { $('message').textContent = text; $('message').hidden = !text; }
  function title(visual) { return labels.get(visual.definition.scene_id) || visual.entry.display_name || visual.definition.title; }
  function send(data) { if (!isOutput && relay) try { relay.send(data); } catch (_) {} }

  // ---- Visuals -------------------------------------------------------------------------------------------------
  function needsPicture(definition) { return (definition.runtime?.min_sources || 0) > 0; }
  function playable(key) { const item = catalog.get(key); return !!item && (!needsPicture(item.definition) || pictures.length > 0 || !!camera?.on); }
  function pictureImage(index) {
    const entry = pictures.length ? pictures[((index % pictures.length) + pictures.length) % pictures.length] : null;
    if (!entry) return null;
    // Read through fetch into a canvas: the App's sandboxed origin makes a plain <img> unreadable to WebGL.
    if (!entry.image) {
      entry.image = document.createElement('canvas');
      entry.loading = fetch('pictures/' + entry.file).then(response => {
        if (!response.ok) throw Error('Picture HTTP ' + response.status);
        return response.blob();
      }).then(blob => createImageBitmap(blob)).then(bitmap => {
        entry.image.width = bitmap.width; entry.image.height = bitmap.height;
        entry.image.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close?.();
        entry.ready = true; applySources();
      }).catch(() => {});
    }
    return entry.ready ? entry.image : null;
  }
  function nextPicture() {
    if (!pictures.length) return;
    pictureIndex = (pictureIndex + 1) % pictures.length;
    applySources(); publish(); keepPictures();
  }
  // Only the shown pictures and the next one stay decoded (each 1280x720 picture is about 3.7 MB).
  function keepPictures() {
    const keep = new Set([0, 1, 2].map(step => ((pictureIndex + step) % pictures.length + pictures.length) % pictures.length));
    pictures.forEach((entry, index) => {
      if (keep.has(index) || !entry.ready) return;
      entry.image.width = entry.image.height = 0; entry.image = null; entry.ready = false; entry.loading = null;
    });
  }
  function instanceFor(key, item) {
    const base = catalog.makeInstance(key), kept = instances[item.definition.scene_id];
    if (!kept) return base;
    try { return contract.normalizeInstance(item.definition, {...base, params: {...base.params, ...kept.params}, modulation_master: kept.modulation_master || base.modulation_master}, {trusted: item.entry.trusted === true}); }
    catch (_) { return base; }
  }
  function present(key, source) {
    const item = catalog.get(key);
    if (!item || !mirror) return false;
    const previous = active;
    if (source && source !== 'follow' && needsPicture(item.definition) && pictures.length) {
      const preferred = pictures.findIndex(entry => entry.id === PICTURE_FOR[item.definition.scene_id]);
      pictureIndex = preferred >= 0 ? preferred : (pictureIndex + 1) % pictures.length;
      pictureImage(pictureIndex + 1);
    }
    active = {key, definition: item.definition, entry: item.entry, instance: instanceFor(key, item)};
    applySources();
    if (!mirror.show(active.definition, active.instance, item.entry.trusted === true)) {
      active = previous;
      if (previous) mirror.show(previous.definition, previous.instance, previous.entry.trusted === true);
      return false;
    }
    presented++; lastChangeAt = performance.now(); page = Math.min(page, 2);
    pictureImage(pictureIndex + 2); keepPictures();
    if (source) stats.changes.push({source, scene_id: item.definition.scene_id, at: lastChangeAt});
    monitorDirty = true; syncSettings(); publish(); remember();
    return true;
  }
  function nextVisual(source) {
    const keys = playlistKeys.filter(playable);
    if (!keys.length) return;
    const at = keys.indexOf(active?.key);
    for (let step = 1; step <= keys.length; step++) {
      if (present(keys[(at + step + keys.length) % keys.length], source)) return;
    }
  }
  function applySources() {
    const live = isOutput ? (followed?.camera ? picture.canvas : null) : camera?.on ? camera.canvas : null;
    if (live) { mirror?.setSources(live, live); return; }
    if (!active || !needsPicture(active.definition)) { mirror?.setSources(null, null); return; }
    const a = pictureImage(pictureIndex), b = pictureImage(pictureIndex + 1);
    // Until a picture is decoded the visual sees black, never the runtime's sample pattern.
    mirror?.setSources(a || blank(), b || a || blank());
  }
  let blankCanvas = null;
  function blank() {
    if (!blankCanvas) { blankCanvas = document.createElement('canvas'); blankCanvas.width = blankCanvas.height = 2; blankCanvas.getContext('2d').fillRect(0, 0, 2, 2); }
    return blankCanvas;
  }
  function edit(change) {
    if (!active) return false;
    const next = clone(active.instance);
    if (change.params) next.params = {...next.params, ...change.params};
    if (change.audio) {
      next.modulation_master = {...next.modulation_master, audio: {contract_version: 2, enabled: change.audio.enabled !== false,
        strength: Number(change.audio.strength) || 0, band_gains: clone(change.audio.band_gains)}};
    }
    try { active.instance = contract.normalizeInstance(active.definition, next, {trusted: active.entry.trusted === true}); }
    catch (_) { return false; }
    mirror.patchInstance(active.instance);
    instances[active.definition.scene_id] = {params: clone(active.instance.params), modulation_master: clone(active.instance.modulation_master)};
    monitorDirty = true; publish(); remember();
    return true;
  }

  // ---- Encoders, as Live Console K4E4: pages 1-2 parameters, page 3 audio response; press cycles 1x/2x/4x -------
  function encoders() { return active ? controls.encoderParameters(active.definition, active.instance) : {parameters: [], audio: []}; }
  function turn(index, delta) {
    const parameter = controls.encoderTarget(encoders(), page, index);
    if (!parameter) return;
    const value = controls.encoderValue(parameter, delta * speeds[KNOBS[index]]);
    if (page === 2) edit({audio: controls.encoderAudioChange(active.instance, parameter.key, value)});
    else edit({params: {[parameter.key]: value}});
    syncSettings();
  }
  function knobValue(parameter) {
    if (!parameter) return '';
    const value = Number(parameter.value);
    return parameter.type === 'float' || !Number.isInteger(value) ? value.toFixed(2) : String(value);
  }
  function monitorLabel(text) { return String(text || '').slice(0, 16); }

  function updateMonitor() {
    if (!monitorDirty || monitorBusy || isOutput) return;
    monitorDirty = false; monitorBusy = true;
    const values = {};
    if (open === 'visuals' || open === 'player') {
      values.E1 = {label: 'Select', value: ''};
      for (const knob of KNOBS.slice(1)) values[knob] = {label: '', value: ''};
      if (open === 'visuals') values.E2 = {label: 'Collection', value: ''};
      Object.assign(values, {K2: {label: '', value: ''}, K3: {label: open === 'visuals' ? 'Close' : 'Visuals', value: ''}, K4: {label: open === 'player' ? 'Close' : 'Player', value: ''}});
    } else {
      const snapshot = encoders();
      KNOBS.forEach((knob, index) => {
        const parameter = controls.encoderTarget(snapshot, page, index), speed = speeds[knob];
        values[knob] = parameter ? {label: monitorLabel(parameter.label), value: knobValue(parameter) + (speed > 1 ? ' ' + speed + 'x' : '')} : {label: '—', value: ''};
      });
      Object.assign(values, {K2: {label: 'Page', value: (page + 1) + '/3'}, K3: {label: open === 'settings' ? 'Close' : 'Visuals', value: ''}, K4: {label: 'Player', value: ''}});
    }
    // A refused update (for example before the host is ready) is sent again on the next tick.
    VrchApp.monitor.set(values).catch(() => { monitorDirty = true; }).finally(() => { monitorBusy = false; });
  }

  // ---- Panels: Visuals (shared picker), Visual Settings (shared view), Player --------------------------------------
  function setOpen(name) {
    open = name; monitorDirty = true;
    document.body.dataset.open = name || '';
  }
  function openVisuals() {
    if (!picker) return;
    closeAll();
    picker.open();
  }
  function closeAll() {
    if (open === 'visuals') picker.close('closed');
    if (open === 'settings') VrchVisualSettings.close();
    if (open === 'player') closePlayer();
    setOpen(null);
  }
  function openSettings() {
    if (!active || !window.VrchVisualSettings) return;
    closeAll(); setOpen('settings');
    VrchVisualSettings.open();
  }
  function closeSettings() { if (open === 'settings') { VrchVisualSettings.close(); setOpen(null); } }
  function syncSettings() { if (open === 'settings') VrchVisualSettings.sync(); }
  function settingsHost() {
    return {
      getState: () => ({revision: active ? active.key + ':' + presented : 'none', editable: !!active, loading: false,
        definition: clone(active?.definition || null), instance: clone(active?.instance || null), visual: active ? {label: title(active)} : null,
        sourceCount: 0, sources: {}, channelOptions: [], imageSettings: null, message: ''}),
      change: ({revision, kind, key, value}) => {
        if (!active || revision !== active.key + ':' + presented) return false;
        if (kind === 'parameter') {
          if (!active.definition.parameters.some(parameter => parameter.key === key)) return false;
          return edit({params: {[key]: clone(value)}});
        }
        if (kind === 'audio') {
          if (!['strength', 'low', 'mid', 'high'].includes(key) || !Number.isFinite(value) || value < 0 || value > 4) return false;
          return edit({audio: controls.encoderAudioChange(active.instance, key, value)});
        }
        return false;
      },
      onClose: closeSettings,
      onChoose: openVisuals,
    };
  }

  // Player panel: rows of shared grid buttons, built from the current state each time it changes.
  function row(label, value, options, onPick) {
    const wrap = document.createElement('div'); wrap.className = 'scene-param-row player-row';
    const head = document.createElement('div'); head.className = 'scene-param-row__heading';
    const name = document.createElement('span'); name.className = 'scene-param-row__label'; name.textContent = label;
    const note = document.createElement('span'); note.className = 'scene-param-row__value'; note.textContent = value || '';
    head.append(name, note);
    const group = document.createElement('div'); group.className = 'ui-grid-btn-group ui-grid-btn-group--settings'; group.setAttribute('role', 'group');
    for (const option of options) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'ui-grid-btn';
      button.textContent = option.label; button.dataset.value = option.id;
      button.classList.toggle('is-active', !!option.current); button.setAttribute('aria-pressed', String(!!option.current));
      button.disabled = !!option.disabled;
      button.addEventListener('click', () => { onPick(option.id); });
      group.append(button);
    }
    wrap.append(head, group);
    return wrap;
  }
  let inputs = {devices: [], selected: null};
  function soundNote(state) {
    if (state.source === 'music') return state.error === 'interaction_required' || !interacted && !state.audible ? 'Starts when you play' : state.error ? 'Sound unavailable' : '';
    if (state.source === 'input') return state.error === 'permission_required' ? 'Allow the input on this device' : state.error === 'audio_device_unavailable' ? 'Input unavailable' : state.error ? 'Input unavailable' : music.listening ? '' : 'Connecting';
    return '';
  }
  function renderPlayer() {
    renderCamera();
    const body = $('playerBody');
    if (!body || open !== 'player') return;
    if (document.activeElement?.closest?.('#playerBody')) playerCursor = cursorOf(document.activeElement);
    const state = music.state();
    const rows = [];
    const sound = row('Sound', soundNote(state), [
      {id: 'music', label: 'Music', current: state.source === 'music'},
      {id: 'input', label: 'Mic / Line in', current: state.source === 'input'},
      {id: 'silent', label: 'Silent', current: state.source === 'silent'},
    ], id => { interact('panel'); void music.setSource(id).then(renderPlayer); if (id === 'input') void refreshInputs(); remember(); renderPlayer(); });
    sound.dataset.row = 'sound'; rows.push(sound);
    if (state.source === 'input' && inputs.devices.length > 1) {
      const input = row('Input', '', inputs.devices.filter(device => device.available !== false).map(device => ({id: device.id, label: device.label, current: device.id === inputs.selected})),
        id => { void music.selectInput(id).then(refreshInputs).catch(() => {}); });
      input.dataset.row = 'input'; rows.push(input);
    }
    if (state.source !== 'input') {
      const tracks = row('Track', '', music.tracks.map((track, index) => ({id: String(index), label: track.title, current: index === state.index})),
        id => { interact('panel'); music.choose(Number(id)); remember(); renderPlayer(); });
      tracks.dataset.row = 'track'; rows.push(tracks);
    }
    const change = row('Auto Change', '', [{id: 'on', label: 'With Music', current: auto}, {id: 'off', label: 'Hold', current: !auto}], id => {
      auto = id === 'on'; lastChangeAt = performance.now(); remember(); renderPlayer();
    });
    change.dataset.row = 'auto'; rows.push(change);
    if (camera) {
      const note = cameraState === 'starting' ? 'Starting' : cameraState === 'error' ? cameraError : '';
      const cam = row('Camera', note, [{id: 'off', label: 'Off', current: !cameraWanted}, {id: 'on', label: 'On', current: cameraWanted, disabled: cameraState === 'starting'}],
        id => { if (id === 'on') void startCamera(); else stopCamera(); });
      cam.dataset.row = 'camera'; rows.push(cam);
    }
    body.replaceChildren(...rows);
    showCursor();
  }
  // The knob cursor in Player is a row and a choice, so it survives the panel being rebuilt.
  let playerCursor = null;
  function cursorOf(button) { const row = button?.closest?.('.player-row')?.dataset.row; return row ? {row, value: button.dataset.value} : null; }
  function playerButton(cursor) { return cursor ? $('playerBody').querySelector('[data-row="' + cursor.row + '"] [data-value="' + CSS.escape(cursor.value || '') + '"]') : null; }
  // The device keeps input focus on the host, so the cursor is drawn with a class as well as focused.
  function showCursor(scroll = false) {
    const current = playerButton(playerCursor);
    for (const button of $('playerBody').querySelectorAll('.is-cursor')) if (button !== current) button.classList.remove('is-cursor');
    if (!current) return;
    current.classList.add('is-cursor'); current.focus({preventScroll: true});
    if (scroll) current.scrollIntoView({block: 'nearest'});
  }
  async function refreshInputs() { inputs = await music.inputDevices(); renderPlayer(); }
  function openPlayer() {
    closeAll(); setOpen('player');
    const dialog = $('player');
    dialog.hidden = false; dialog.classList.add('is-visible');
    renderPlayer();
    void refreshInputs();
    playerCursor = cursorOf($('playerBody').querySelector('.is-active'));
    showCursor();
  }
  function closePlayer() {
    const dialog = $('player');
    dialog.classList.remove('is-visible'); dialog.hidden = true;
    if (open === 'player') setOpen(null);
  }
  // E1 moves through the open panel's choices (in Visuals: the cards, E2 the collections); E1 press takes the choice.
  function focusables(container) { return [...container.querySelectorAll('button:not(:disabled),[data-scene-picker-select]')].filter(item => item.offsetParent !== null); }
  function panelStep(delta, knob = 0) {
    const container = open === 'player' ? $('player') : open === 'visuals' ? picker?.overlay : null;
    if (!container) return;
    if (open === 'visuals') {
      if (knob === 1) {
        const tabs = [...picker.elements.collections.querySelectorAll('button')].filter(tab => !tab.disabled && tab.offsetParent !== null);
        const at = tabs.findIndex(tab => tab.getAttribute('aria-pressed') === 'true');
        tabs[((at < 0 ? 0 : at) + Math.sign(delta) + tabs.length) % tabs.length]?.click();
        return;
      }
      const cards = [...container.querySelectorAll('[data-scene-picker-select]')].filter(item => !item.disabled && item.offsetParent !== null);
      if (!cards.length) return;
      const at = cards.findIndex(card => card.closest('.is-pending'));
      const next = cards[((at < 0 ? -1 : at) + Math.sign(delta) + cards.length) % cards.length];
      next.focus(); next.scrollIntoView({block: 'nearest'}); next.click();
      return;
    }
    if (knob !== 0) return;
    const items = focusables($('playerBody'));
    if (!items.length) return;
    const current = playerButton(playerCursor), at = items.indexOf(current);
    const next = items[((at < 0 ? 0 : at + Math.sign(delta)) + items.length) % items.length];
    playerCursor = cursorOf(next);
    showCursor(true);
  }
  function panelPress() {
    if (open === 'visuals') { picker?.elements?.confirm?.click(); return; }
    playerButton(playerCursor)?.click();
  }

  // ---- Camera ---------------------------------------------------------------------------------------------------
  function cameraMessage(error) {
    const code = error?.code || error?.name;
    if (['permission_required', 'NotAllowedError', 'SecurityError', 'capability_not_granted'].includes(code)) return 'Allow the camera on this device';
    if (['camera_unavailable', 'camera_disconnected', 'NotFoundError', 'NotReadableError'].includes(code)) return 'No camera';
    if (['unsupported_environment', 'preview_io_disabled', 'unsupported_capability'].includes(code)) return 'Not available here';
    return 'Camera did not start';
  }
  async function startCamera() {
    if (!camera || cameraState === 'starting' || camera.on) return;
    interact('panel');
    cameraWanted = true; cameraState = 'starting'; cameraError = ''; renderPlayer();
    stats.camera = {clickedAt: performance.now(), openedAt: null, firstFrameAt: null, trackingReadyAt: null, followAt: null, error: null};
    try { await camera.open(); }
    catch (error) {
      stats.camera.error = error?.code || error?.name || 'camera_failed';
      cameraWanted = false; cameraState = 'error'; cameraError = cameraMessage(error); renderPlayer();
      return false;
    }
    stats.camera.openedAt = performance.now();
    cameraState = 'on';
    if (VisualsCamera.simd) { mirror.setAnalysisEnabled(true); tuneTracking(); }
    applySources(); remember(); renderPlayer(); publish();
    return true;
  }
  function stopCamera(error) {
    camera?.close();
    mirror?.setAnalysisEnabled(false); resetDegrade();
    cameraWanted = false; cameraState = error ? 'error' : 'off'; cameraError = error ? cameraMessage(error) : '';
    applySources();
    remember(); renderPlayer(); publish();
  }
  function cameraFrame(canvas) {
    if (stats.camera && !stats.camera.firstFrameAt) stats.camera.firstFrameAt = performance.now();
    mirror?.setSources(canvas, canvas);
  }
  function cameraEnded(error) { stopCamera(error || {code: 'camera_disconnected'}); }
  function analysisState(status) {
    stats.analysis = {state: status.state, tracks: status.tracks, error: status.error?.code || null, at: performance.now()};
    if (!stats.camera || !camera?.on) return;
    if (status.state === 'ready' && !stats.camera.trackingReadyAt) stats.camera.trackingReadyAt = performance.now();
    if (status.tracks > 0 && !stats.camera.followAt) stats.camera.followAt = performance.now();
  }
  // With tracking and a visual both running, 3 s under 45 fps steps down: tracking rate, then render scale.
  // On a small host (the edge render profile) body tracking runs at 10 Hz and leaves half of a core idle.
  function tuneTracking() {
    const analysis = mirror.frameAnalysis;
    if (analysis && mirror.getPerformanceState()?.profile === 'edge') Object.assign(analysis.config, {targetHz: 10, maxDutyCycle: 0.5});
  }
  function resetDegrade() { if (degradeLevel) mirror?.setRenderBudget(null); degradeLevel = 0; slowSeconds = 0; }
  function degrade(fps) {
    degradeLevel++;
    const analysis = mirror.frameAnalysis;
    if (degradeLevel === 1 && analysis) Object.assign(analysis.config, {targetHz: Math.min(analysis.config.targetHz, 12), maxDutyCycle: Math.min(analysis.config.maxDutyCycle, 0.35)});
    else if (degradeLevel === 2) mirror.setRenderBudget({maxScale: 0.75});
    stats.degrades.push({level: degradeLevel, fps: Math.round(fps), scene_id: active?.definition.scene_id, at: performance.now()});
  }
  let meterFrames = 0, meterSince = 0;
  function meter(now) {
    if (!mirror || mirror.disposed) return;
    requestAnimationFrame(meter);
    if (!meterSince) { meterSince = now; return; }
    meterFrames++;
    if (now - meterSince < 1000) return;
    // The picture's own frame time: the renderer may draw at 30 or 20 frames per second while the page runs at 60.
    const drawn = mirror.getPerformanceState()?.frame_time_p50_ms;
    const fps = drawn > 0 ? 1000 / drawn : meterFrames * 1000 / (now - meterSince);
    meterFrames = 0; meterSince = now; stats.fps = Math.round(fps * 10) / 10;
    if (!camera?.on) { baselineFps = Math.max(baselineFps * 0.9, fps); return; }
    // Without a reading from before the camera started, compare with the 30 frames a second a small host draws.
    slowSeconds = fps < Math.min(SLOW_FPS, (baselineFps || 30) * 0.9) ? slowSeconds + 1 : 0;
    if (slowSeconds >= SLOW_SECONDS && degradeLevel < 2) { slowSeconds = 0; degrade(fps); }
  }

  // ---- Input ----------------------------------------------------------------------------------------------------
  function interact(kind) {
    const now = performance.now();
    if (!interacted) { interacted = true; stats.firstInteraction = {kind, at: now}; }
    if (kind === 'rotate' || kind === 'settings') playedAt = now;
    music?.wake();
  }
  function pressKey(control) {
    if (control === 'K2') { if (!open || open === 'settings') { page = (page + 1) % 3; monitorDirty = true; } return; }
    if (control === 'K3') { if (open === 'visuals' || open === 'settings') closeAll(); else openVisuals(); return; }
    if (control === 'K4') { if (open === 'player') closeAll(); else openPlayer(); }
  }
  function holdKey(control) {
    if (control === 'K3') { if (open === 'settings') closeAll(); else openSettings(); }
  }
  VrchApp.controls.onEvent(event => {
    if (!active || isOutput) return;
    if (stats.controls.length < 200) stats.controls.push({type: event.type, control: event.control, delta: event.delta, at: performance.timeOrigin + performance.now()});
    const knob = KNOBS.indexOf(event.control), delta = Math.trunc(Number(event.delta) || 0);
    if (event.type === 'rotate' && knob >= 0) {
      interact('rotate');
      if (open === 'visuals' || open === 'player') { if (delta) panelStep(delta, knob); }
      else if (delta) turn(knob, delta);
      return;
    }
    if (knob >= 0) {
      if (event.type !== 'down') return;
      interact('press');
      if (open === 'visuals' || open === 'player') { if (knob === 0) panelPress(); return; }
      const knobId = KNOBS[knob];
      speeds[knobId] = SPEEDS[(SPEEDS.indexOf(speeds[knobId]) + 1) % SPEEDS.length]; monitorDirty = true;
      return;
    }
    if (!['K2', 'K3', 'K4'].includes(event.control)) return;
    // K3 has a hold action, so its press acts on release; K2 and K4 act at once.
    if (event.type === 'down') {
      interact('key');
      if (event.control !== 'K3') { pressKey(event.control); return; }
      clearTimeout(holdTimers.K3);
      holdTimers.K3 = setTimeout(() => { holdTimers.K3 = 'held'; holdKey('K3'); }, HOLD_MS);
    } else if (event.control === 'K3' && (event.type === 'up' || event.type === 'cancel')) {
      const held = holdTimers.K3 === 'held';
      clearTimeout(holdTimers.K3); holdTimers.K3 = 0;
      if (!held && event.type === 'up') pressKey('K3');
    }
  });
  // The camera button beside mute does what Player's Camera row does: pressed while the camera is on, pulsing while it
  // starts, and in the warning colour (with the reason as its label) when the camera was refused or is missing.
  function renderCamera() {
    const button = $('camera-toggle');
    if (!button) return;
    button.hidden = isOutput || !camera;
    const on = cameraState === 'on' || cameraState === 'starting';
    button.dataset.state = cameraState; button.dataset.on = String(on); button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', cameraState === 'error' ? cameraError : on ? 'Turn camera off' : 'Turn camera on');
    button.title = button.getAttribute('aria-label');
  }
  $('camera-toggle').addEventListener('click', event => {
    event.stopPropagation();
    if (isOutput || !camera || cameraState === 'starting') return;
    if (camera.on) stopCamera(); else void startCamera();
  });
  // The speaker is always there. With Music it mutes and unmutes with a fade; with Silent or Mic / Line in (nothing is
  // played back) it shows as muted, and a tap brings the music back.
  function renderMute() {
    const button = $('mute');
    if (!button || !music) return;
    const playing = music.source === 'music', muted = !playing || music.muted;
    button.hidden = isOutput; button.dataset.on = String(!muted);
    button.setAttribute('aria-pressed', String(muted)); button.setAttribute('aria-label', !playing ? 'Play music' : muted ? 'Unmute' : 'Mute');
    button.title = button.getAttribute('aria-label');
    button.firstElementChild.className = 'fas ' + (muted ? 'fa-volume-xmark' : 'fa-volume-high');
  }
  $('mute').addEventListener('click', event => {
    event.stopPropagation();
    if (isOutput || !music) return;
    if (music.source !== 'music') { music.setMuted(false); void music.setSource('music').then(renderPlayer); }
    else music.setMuted(!music.muted);
    interact('tap'); remember(); renderMute();
  });
  // A tap on the picture opens Player; the panels close with their own close buttons or the same key.
  $('stage').addEventListener('click', () => { if (!isOutput && !open && active) { interact('tap'); openPlayer(); } });
  $('playerClose').addEventListener('click', () => closeAll());
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && open === 'player') { event.preventDefault(); closeAll(); } });

  // ---- Persistence ------------------------------------------------------------------------------------------------
  function remember() {
    if (isOutput || !catalog) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_MS);
  }
  async function save() {
    const value = {schema_version: 1, scene: active?.definition.scene_id || null, source: music?.source || 'music', track: music?.index || 0, muted: !!music?.muted, auto,
      camera: cameraWanted, picture: pictureIndex, instances, picker: pickerStore};
    try {
      const result = await VrchApp.data.set(DATA_KEY, value, {expectedVersion: saved.version});
      saved.version = result?.version ?? saved.version + 1;
    } catch (error) {
      if (error?.code === 'version_conflict') { try { saved = await VrchApp.data.get(DATA_KEY); remember(); } catch (_) {} }
    }
  }
  async function restore() {
    try {
      saved = await VrchApp.data.get(DATA_KEY);
      const value = saved.exists && saved.value && typeof saved.value === 'object' ? saved.value : {};
      if (value.instances && typeof value.instances === 'object') instances = value.instances;
      if (value.picker && typeof value.picker === 'object') pickerStore = value.picker;
      if (typeof value.auto === 'boolean') auto = value.auto;
      if (Number.isInteger(value.picture) && value.picture >= 0) pictureIndex = value.picture;
      return value;
    } catch (_) { saved = {version: 0}; return {}; }
  }

  // ---- Output surface ---------------------------------------------------------------------------------------------
  function publish() {
    if (isOutput || !relay || !active) return;
    lastTimingRelay = performance.now();
    try { relay.publish({scene_id: active.definition.scene_id, params: active.instance.params, modulation_master: active.instance.modulation_master,
      shown_at: performance.timeOrigin + lastChangeAt, camera: !!camera?.on, picture: pictureIndex, music: music?.timing() || null}); } catch (_) {}
  }
  function follow(state) {
    followed = state;
    if (!catalog || !state || typeof state.scene_id !== 'string') return;
    if (state.music) music.follow(state.music);
    if (Number.isInteger(state.picture) && state.picture >= 0 && state.picture < pictures.length) pictureIndex = state.picture;
    const item = catalog.getBySceneId(state.scene_id);
    if (!item) return;
    const key = catalog.itemKey(item);
    instances[state.scene_id] = {params: state.params || {}, modulation_master: state.modulation_master};
    if (active?.key !== key) {
      present(key, 'follow');
      if (Number.isFinite(state.shown_at)) mirror.setSceneTime((performance.timeOrigin + performance.now() - state.shown_at) / 1000);
    } else {
      active.instance = instanceFor(key, item);
      applySources(); mirror.patchInstance(active.instance);
    }
  }
  if (isOutput && relay) relay.onMessage(({kind, data} = {}) => {
    if (!data || typeof data !== 'object') return;
    if (stats.received.length < 400 && !['frame', 'track', 'audio'].includes(data.type)) stats.received.push({kind, type: data.type || null, scene_id: data.scene_id || null, at: performance.timeOrigin + performance.now()});
    if (kind === 'state') follow(data);
    else if (data.type === 'audio') music?.relay(data.features);
    else if (data.type === 'track' && data.values && typeof data.values === 'object') mirror?.effect?.signalBus?.setExternalValues(data.values);
    else if (data.type === 'frame') { const url = pictureJoin.take(data); if (url) void picture.show(url, canvas => { stats.relayedPicture = [canvas.width, canvas.height]; mirror?.setSources(canvas, canvas); }); }
  });
  function relayLive(now) {
    if (isOutput || !relay || !active) return;
    if (now - lastTimingRelay >= TIMING_RELAY_MS) publish();
    if (music?.source === 'input' && now - lastAudioRelay >= AUDIO_RELAY_MS) {
      lastAudioRelay = now;
      const features = music.lastFeatures;
      if (features) {
        const compact = {};
        for (const [key, value] of Object.entries(features)) compact[key] = typeof value === 'number' ? Math.round(value * 1e4) / 1e4 : value && value.length ? Array.from(value, v => Math.round(v * 10) / 10) : value;
        send({type: 'audio', features: compact});
      }
    }
    if (!camera?.on) return;
    if (active.definition.analysis_requirements?.length && now - lastTrackRelay >= TRACK_RELAY_MS) {
      lastTrackRelay = now;
      const values = mirror.effect?.signalBus?.values || {}, tracking = {};
      for (const [key, value] of Object.entries(values)) if (key.startsWith('tracking.')) tracking[key] = Math.round(value * 1e4) / 1e4;
      send({type: 'track', values: tracking});
    }
    if (needsPicture(active.definition) && now - lastFrameRelay >= FRAME_RELAY_MS) {
      lastFrameRelay = now;
      void camera.relayFrame().then(url => { if (!url || !camera.on) return; const id = ++pictureId; for (const part of VisualsCamera.pictureParts(url)) send({type: 'frame', id, ...part}); });
    }
  }

  // ---- Clock ------------------------------------------------------------------------------------------------------
  function sectionChanged() {
    if (isOutput || !auto || open) return;
    const now = performance.now();
    if (now - playedAt < PLAYED_IDLE_MS) return;
    if (now - lastChangeAt >= AUTO_MIN_MS) nextVisual('auto');
    // Between visual changes an image visual takes the next picture on the music's section.
    else if (active && needsPicture(active.definition) && !camera?.on && now - lastChangeAt >= AUTO_MIN_MS / 2) { nextPicture(); lastChangeAt = now - AUTO_MIN_MS / 2; }
  }
  setInterval(() => {
    if (!active || document.hidden || isOutput) return;
    const now = performance.now();
    // Input has no sections; Silent and Music without section data fall back to a steady interval.
    if (auto && !open && now - lastChangeAt >= AUTO_FALLBACK_MS && now - playedAt >= PLAYED_IDLE_MS && (music.source === 'input' || !(music.tracks[music.index]?.sections || []).length)) nextVisual('auto');
    updateMonitor();
  }, 250);
  setInterval(() => { if (!document.hidden) relayLive(performance.now()); }, 33);
  document.addEventListener('visibilitychange', () => music?.pause(document.hidden));
  window.addEventListener('pagehide', () => { music?.dispose(); camera?.close(); picker?.destroy?.(); mirror?.dispose(); });

  // ---- Start ------------------------------------------------------------------------------------------------------
  async function loadTracks() {
    const response = await fetch('music/index.json');
    if (!response.ok) throw Error('Music index HTTP ' + response.status);
    const index = await response.json();
    return index.tracks.map(track => ({...track, file: 'music/' + track.file, features: 'music/' + track.features}));
  }
  async function loadPictures() {
    try {
      const response = await fetch('pictures/index.json');
      if (!response.ok) return [];
      const index = await response.json();
      return index.pictures.filter(item => item && typeof item.file === 'string').map(item => ({id: item.id, file: item.file, image: null, ready: false}));
    } catch (_) { return []; }
  }
  function makePicker() {
    const storage = {
      getItem: key => Object.hasOwn(pickerStore, key) ? pickerStore[key] : null,
      setItem: (key, value) => { pickerStore[key] = String(value); remember(); },
    };
    picker = VrchScenePresetPicker.createPicker({
      id: 'visualsPlayerPicker', catalog, selection, storage, hosted: false, mirrorOptions: {analysis: false},
      source: 'visuals-player', title: 'Visuals', primaryLabel: 'Play', progressLabel: 'Opening...', currentLabel: 'PLAYING',
      emptyTitle: 'Choose a visual', emptyMeta: '', getCurrentHash: () => active?.key,
      onOpen: () => { setOpen('visuals'); mirror.hide(); },
      onClose: () => { if (open === 'visuals') setOpen(null); if (active && !mirror.effect) { applySources(); mirror.show(active.definition, active.instance, active.entry.trusted === true); } },
      onConfirm: async item => {
        auto = false;
        return present(catalog.itemKey(item), 'picker');
      },
    });
  }
  async function start() {
    try {
      // An output renders up to 1080p and steps its render scale down after about 3 s of slow frames.
      mirror = new VrchSceneMirror.SceneMirror({container: $('visual'), maxPixels: isOutput ? 1920 * 1080 : 0, analysis: false,
        sourceBindings: {0: 'A', 1: 'B'}, analysisOptions: VisualsCamera.analysisOptions, onAnalysisState: analysisState,
        performance: isOutput ? {config: {performanceWindowFrames: 60, performanceOverrunWindows: 3, performanceRecoveryWindows: 6}} : true});
    } catch (_) { fatal('Visuals need WebGL 2, which this device does not provide.'); return; }
    let restored = {};
    try {
      const [tracks, value, list] = await Promise.all([loadTracks(), isOutput ? {} : restore(), loadPictures()]);
      restored = value;
      pictures = list;
      if (pictureIndex >= pictures.length) pictureIndex = 0;
      pictureImage(pictureIndex); pictureImage(pictureIndex + 1);
      music = new VisualsMusic({sdk: VrchApp, tracks, external: isOutput,
        onChange: () => { renderPlayer(); renderMute(); publish(); }, onSection: sectionChanged});
      if (!isOutput && restored.muted === true) music.muted = true;
      if (Number.isInteger(restored.track) && tracks[restored.track]) music.setTrack(restored.track, 0, performance.now(), false);
      mirror.setAudioProvider(() => music.features(performance.now()));
      catalog = new VrchSceneCatalog.PresetCatalog();
      await catalog.load();
    } catch (_) { fatal('The visuals could not load.'); return; }
    // The shared Curated collection (and the visitor's own favourites and recents), limited to this package.
    const shared = clone(VrchSceneSelection), present_ = new Set(catalog.list().map(item => item.definition.scene_id));
    shared.collections = shared.collections.filter(collection => COLLECTIONS.includes(collection.id) || collection.id === 'library');
    shared.items = shared.items.filter(item => COLLECTIONS.includes(item.collection) && present_.has(item.scene_id));
    selection = shared;
    for (const item of shared.items) if (item.label) labels.set(item.scene_id, item.label);
    // Auto change spreads the image visuals evenly among the drawn ones, each in Curated order.
    const curated = shared.items.filter(item => item.collection === 'curated').map(item => catalog.getBySceneId(item.scene_id));
    const spread = list => list.map((item, index) => ({item, at: (index + 0.5) / list.length}));
    const drawn = curated.filter(item => !needsPicture(item.definition)), imaged = curated.filter(item => needsPicture(item.definition));
    playlistKeys = [...spread(drawn), ...spread(imaged).map(entry => ({...entry, at: entry.at + 1e-6}))].sort((a, b) => a.at - b.at).map(entry => catalog.itemKey(entry.item));
    if (!isOutput) makePicker();
    if (window.VrchVisualSettings) VrchVisualSettings.connect(settingsHost());
    const first = restored.scene && catalog.getBySceneId(restored.scene);
    const firstKey = first && playable(catalog.itemKey(first)) ? catalog.itemKey(first) : playlistKeys.find(playable);
    if (!isOutput) {
      if (needsPicture(catalog.get(firstKey).definition)) await pictures[pictureIndex]?.loading;
      present(firstKey, null);
    }
    if (followed) follow(followed);
    renderMute(); renderCamera();
    if (typeof restored.source === 'string' && restored.source !== 'music') void music.setSource(restored.source);
    VrchApp.ready().then(() => { monitorDirty = true; publish(); if (restored.camera) void startCamera(); }, () => {});
    requestAnimationFrame(() => requestAnimationFrame(() => { stats.firstFrameAt = performance.now(); }));
    if (!isOutput) requestAnimationFrame(meter);
  }
  start();
})();
