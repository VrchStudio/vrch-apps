/* Apps host adapter for the shared Scene editor, catalog and control primitives. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const SESSION = 'shader-app-workspace';
  const contract = VrchSceneContract;
  const backend = new VrchSceneAppsStore.AppsBackend(VrchApp);
  const store = new VrchSceneStore.SceneStore({backendFactory: () => backend.open()});
  const catalog = new VrchSceneCatalog.PresetCatalog();
  const isOutput = VrchApp.context?.role === 'output', relay = VrchApp.output || null;
  document.documentElement.dataset.role = isOutput ? 'output' : 'control';
  let active = null, preferences = {}, residue = {}, picker = null, parameters = null, mirror = null;
  let loaded = false, disposed = false, librarySaving = false, saving = null, timer = 0, retrying = false;
  let editVersion = 0, savedVersion = 0, lastError = null, mode = 'simple';
  let deleting = null;
  let media = null, mediaChoices = {};
  const preferenceStorage = {
    getItem(key) { return Object.hasOwn(preferences, key) ? preferences[key] : null; },
    setItem(key, value) {
      if (preferences[key] === String(value)) return;
      preferences[key] = String(value); changed();
    },
  };
  const comparable = instance => JSON.stringify(instance && {
    scene_ref: instance.scene_ref, params: instance.params, bindings: instance.bindings,
    modulation_master: instance.modulation_master, quality_mode: instance.quality_mode,
  });

  function feedback(message = '') {
    $('saveFeedback').textContent = message;
    $('saveFeedback').hidden = !message;
  }

  function render() {
    if (disposed) return;
    $('chooseVisual').disabled = !loaded || librarySaving;
    $('modeButton').disabled = !loaded;
    $('editorPreviewPanel').classList.toggle('is-empty', !active);
    $('candidateTitle').textContent = active?.name || active?.definition.title || 'No visual yet';
    $('presetSaveActions').hidden = !active;
    $('mediaSources').hidden = !active;
    $('saveState').textContent = lastError?.code === 'persistence_unknown' ? (deleting ? 'Delete unknown' : 'Save unknown') : lastError ? (deleting ? 'Not deleted' : 'Not saved') : saving || savedVersion !== editVersion ? 'Saving draft' : 'Draft saved';
    $('saveState').classList.toggle('is-warn', !!lastError);
    $('saveVisual').textContent = active?.presetId ? 'Update Visual' : 'Save Visual';
    $('saveVisual').disabled = !loaded || !active || librarySaving || !!deleting || !!lastError || (active.presetId && comparable(active.instance) === comparable(active.savedInstance));
    $('recoveryActions').hidden = !lastError;
    $('retrySave').textContent = !loaded ? 'Retry' : lastError?.code === 'version_conflict' ? 'Reload Saved' : lastError?.code === 'persistence_unknown' ? (deleting ? 'Check Delete' : 'Check Save') : deleting ? 'Retry Delete' : 'Retry Save';
    $('retrySave').disabled = retrying;
    $('modeText').textContent = mode === 'expert' ? 'ADVANCED' : 'SIMPLE';
    document.body.dataset.sceneMode = mode;
    $('sourcePanel').hidden = mode !== 'expert' || !active;
    $('sourceCode').textContent = active?.definition.fragment?.source || '';
    if (parameters) parameters.render(active?.definition || null, active?.instance || null, {
      disabled: !loaded || librarySaving, canReset: !!active && !librarySaving,
    });
    if (picker) picker.setCurrent(active?.presetId ? 'preset:' + active.presetId : active?.selectedKey);
  }

  function failed(error) {
    if (disposed) return;
    lastError = error;
    feedback(!loaded ? 'Your saved workspace could not be opened. Retry to load it.'
      : error.code === 'persistence_unknown' ? (deleting ? 'Deletion not confirmed. Check the result before trying again.' : 'Save not confirmed. Keep this edit open and check the save.')
      : error.code === 'version_conflict' ? 'This workspace changed elsewhere. Your edit is still open.'
      : error.code === 'data_quota_exceeded' ? (deleting ? 'Could not delete: storage is full. Your visual is unchanged.' : 'Storage is full. Your edit is still open.')
      : deleting ? 'Could not delete this visual. Try again.' : 'Could not save. Your edit is still open; try again.');
    render();
  }

  function changed() {
    editVersion++;
    if (!loaded || disposed || lastError) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; persist().catch(failed); }, 180);
    render();
  }

  async function persist() {
    if (!loaded || disposed) return;
    clearTimeout(timer); timer = 0;
    if (lastError) throw lastError;
    if (saving) {
      await saving;
      if (savedVersion !== editVersion) return persist();
      return;
    }
    if (savedVersion === editVersion) return;
    const version = editVersion;
    const value = {...clone(residue), schema_version: 1, editor: clone(active), preferences: clone(preferences), media: clone(mediaChoices), mode};
    saving = store.setMeta(SESSION, value);
    render();
    try {
      await saving;
      savedVersion = version;
    } catch (error) {
      failed(error);
      throw error;
    } finally {
      saving = null;
      if (!disposed && !lastError && savedVersion !== editVersion) {
        clearTimeout(timer); timer = setTimeout(() => { timer = 0; persist().catch(failed); }, 180);
      }
      render();
    }
  }

  function showPreview() {
    if (disposed || document.hidden) return;
    if (!active) { mirror?.hide(); return; }
    if (!mirror) mirror = new VrchSceneMirror.SceneMirror({
      container: $('preview'), sourceBindings: {0: 'A', 1: 'B'}, analysisOptions: ShaderAnalysis.options,
      onAnalysisState: state => {
        $('trackingFeedback').hidden = state.state !== 'error';
        $('trackingMessage').textContent = state.state === 'error' ? 'Tracking unavailable' : '';
        $('trackingMessage').title = state.error?.message || '';
      },
    });
    if (mirror && relay) watchAudio(mirror);
    if (!mirror.show(active.definition, active.instance, true)) feedback('This visual could not be previewed on this device.');
    else { shownAt = performance.timeOrigin + performance.now(); media?.resume(mirror, active.definition); }
  }

  function patch(change) {
    if (!active || librarySaving) return;
    const next = clone(active.instance);
    if (change.params) Object.assign(next.params, clone(change.params));
    if (change.audio) next.modulation_master = {audio: clone(change.audio)};
    if (change.binding) {
      const index = next.bindings.findIndex(binding => binding.binding_id === change.binding.binding_id);
      if (index === -1) next.bindings.push(clone(change.binding));
      else next.bindings[index] = clone(change.binding);
    }
    active.instance = contract.normalizeInstance(active.definition, next, {trusted: false});
    mirror?.patchInstance(active.instance);
    changed();
  }

  async function choose(item) {
    const instance = catalog.makeInstance(catalog.itemKey(item));
    contract.validateDefinition(item.definition, {trusted: item.entry.trusted === true});
    active = {
      definition: clone(item.definition), instance, baseInstance: clone(instance),
      selectedKey: catalog.itemKey(item), presetId: item.entry.user_preset_id || null,
      name: item.entry.user_preset_id ? item.entry.display_name : '',
      savedInstance: item.entry.user_preset_id ? clone(instance) : null,
      pendingPresetId: null,
    };
    changed();
    return true;
  }

  async function clearVisual() {
    active = null;
    media?.stop(); mirror?.hide();
    changed();
    return true;
  }

  async function deleteVisual(item) {
    if (deleting) throw lastError || Error('A deletion is still in progress.');
    deleting = item.entry.user_preset_id;
    try {
      await persist();
      await store.deleteUserPreset(deleting);
      await finishDelete(deleting);
      deleting = null;
      changed();
      return true;
    } catch (error) { failed(error); throw error; }
  }

  async function finishDelete(id) {
    await catalog.hydrateUserPresets(store);
    for (const key of [picker.options.favoritesStorageKey, picker.options.recentsStorageKey]) {
      try {
        const values = JSON.parse(preferenceStorage.getItem(key) || '[]');
        if (Array.isArray(values)) preferenceStorage.setItem(key, JSON.stringify(values.filter(value => value !== 'preset:' + id)));
      } catch (_) {}
    }
    if (active?.presetId === id) {
      active.presetId = null; active.name = ''; active.savedInstance = null;
      active.selectedKey = catalog.findMatchingKey(active.instance.scene_ref.content_hash, active.instance);
    }
  }

  async function saveVisual() {
    if (!active || librarySaving || deleting || lastError) return;
    librarySaving = true;
    render();
    const editing = active;
    try {
      if (!editing.presetId && !editing.pendingPresetId) {
        editing.pendingPresetId = 'app-' + Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join('');
        changed();
      }
      await persist();
      const exact = clone(editing.instance);
      let name = editing.name || editing.definition.title;
      if (!editing.presetId) {
        const existing = await store.listUserPresets();
        const used = new Set(existing.map(item => item.record.name));
        let suffix = 2;
        while (used.has(name)) name = editing.definition.title + ' ' + suffix++;
      }
      const saved = await store.saveUserPreset(editing.definition, exact, {
        presetId: editing.presetId || editing.pendingPresetId, name,
        thumbnailDataUrl: mirror?.captureThumbnail() || '', basePresetId: editing.definition.scene_id,
      });
      if (!saved.durable) throw Object.assign(Error('Storage is not durable'), {code: 'persistence_failed'});
      editing.presetId = saved.preset_id; editing.pendingPresetId = null;
      editing.name = saved.name; editing.savedInstance = clone(saved.instance_snapshot);
      editing.baseInstance = clone(saved.instance_snapshot); editing.selectedKey = 'preset:' + saved.preset_id;
      await catalog.hydrateUserPresets(store);
      changed();
      await persist();
    } catch (error) { failed(error); }
    finally { librarySaving = false; render(); }
  }

  async function restore(value) {
    if (value && value.schema_version !== 1) throw Object.assign(Error('Unknown workspace version'), {code: 'persistence_invalid'});
    residue = clone(value || {});
    preferences = clone(value?.preferences || {});
    mediaChoices = clone(value?.media || {});
    media?.restore(mediaChoices);
    mode = value?.mode === 'expert' ? 'expert' : 'simple';
    active = clone(value?.editor || null);
    if (active) {
      contract.validateDefinition(active.definition, {trusted: false});
      if (await contract.sha256Ref(active.definition) !== active.instance?.scene_ref?.content_hash) throw Error('Workspace definition changed');
      active.instance = contract.normalizeInstance(active.definition, active.instance);
      const id = active.presetId || active.pendingPresetId;
      const preset = id && await store.getUserPreset(id);
      if (preset) {
        active.presetId = id; active.pendingPresetId = null;
        active.name = preset.record.name; active.savedInstance = clone(preset.record.instance_snapshot);
      } else if (active.presetId) {
        active.presetId = null; active.name = ''; active.savedInstance = null;
      }
    }
  }

  async function retry() {
    if (retrying) return;
    retrying = true; render();
    try { await retryOnce(); }
    finally { retrying = false; render(); }
  }

  async function retryOnce() {
    if (!loaded) { await start(); return; }
    if (lastError?.code === 'version_conflict') {
      const confirmed = await VrchDialogs.confirm('Reload Saved Workspace', 'Replace this open edit with the saved workspace?', {primaryLabel: 'Reload', secondaryLabel: 'Keep Editing', focus: 'secondaryBtn', dismissResult: false});
      if (!confirmed) return;
      try {
        await backend.refresh();
        await catalog.hydrateUserPresets(store);
        await restore(await store.getMeta(SESSION));
        deleting = null; lastError = null; feedback(''); savedVersion = ++editVersion;
        parameters.setMode(mode, {force: true}); showPreview(); render();
      } catch (error) { failed(error); }
      return;
    }
    try {
      await backend.check();
      if (deleting) {
        if (await store.getUserPreset(deleting)) await store.deleteUserPreset(deleting);
        await finishDelete(deleting);
        deleting = null;
      }
      if (active?.pendingPresetId) {
        const preset = await store.getUserPreset(active.pendingPresetId);
        if (preset) {
          active.presetId = active.pendingPresetId; active.pendingPresetId = null;
          active.name = preset.record.name; active.savedInstance = clone(preset.record.instance_snapshot);
        }
      }
      await catalog.hydrateUserPresets(store);
      lastError = null; feedback('');
      editVersion++;
      await persist();
    } catch (error) { failed(error); }
  }

  function makeControls() {
    if (parameters) return;
    media = new ShaderMedia({sdk: VrchApp, mount: $('mediaSources'), onChange: choices => { mediaChoices = clone(choices); changed(); }});
    media.restore(mediaChoices);
    parameters = new VrchSceneParameterControls.VisualParameterPanel({
      mount: $('parameters'), primaryLimit: 4, storage: preferenceStorage,
      collapseStorageKey: 'parameters',
      onParameterChange: ({key, value}) => patch({params: {[key]: value}}),
      onAudioChange: change => patch({audio: change.contract_version === 2 ? {
        contract_version: 2, enabled: change.enabled !== false, strength: Number(change.strength) || 0,
        band_gains: clone(change.band_gains),
      } : {enabled: change.enabled !== false, gain: Number(change.gain) || 0}}),
      onBindingChange: change => { if (change.binding) patch({binding: change.binding}); },
      onReset: () => {
        if (!active || librarySaving) return;
        active.instance = contract.normalizeInstance(active.definition, clone(active.baseInstance));
        mirror?.patchInstance(active.instance); parameters.render(active.definition, active.instance, {force: true}); changed();
      },
    });
    const selection = clone(VrchSceneSelection);
    const listed = new Set(selection.items.map(item => item.scene_id));
    for (const item of catalog.list({includeUser: false, includeEphemeral: false})) {
      if (listed.has(item.definition.scene_id)) continue;
      const kind = item.definition.analysis_requirements?.[0]?.kind;
      selection.items.push({scene_id: item.definition.scene_id, collection: 'demos', group: ({hand: 'hand', face: 'face', pose: 'body'})[kind] || 'image'});
    }
    picker = VrchScenePresetPicker.createPicker({
      id: 'shaderAppPicker', catalog, selection, storage: preferenceStorage, hosted: false,
      mirrorOptions: {analysisOptions: ShaderAnalysis.options},
      triggerId: 'chooseVisual', displayId: 'pickerSummary', source: 'shader-app',
      title: 'Choose a Visual', primaryLabel: 'Edit This', progressLabel: 'Opening...',
      emptyTitle: 'Choose a visual', emptyMeta: '', currentLabel: 'EDITING',
      getCurrentHash: () => active?.presetId ? 'preset:' + active.presetId : active?.selectedKey,
      onOpen: () => { media?.stop(); mirror?.hide(); }, onClose: showPreview, onConfirm: choose,
      onClear: clearVisual, onDelete: deleteVisual,
    });
    const popover = VrchPagesLiveConsoleActionPopover.createActionPopoverController({document, window});
    $('modeButton').addEventListener('click', () => {
      popover.open($('modeButton'), [
        {id: 'simple', label: 'Simple', current: mode === 'simple'},
        {id: 'expert', label: 'Advanced', current: mode === 'expert'},
      ], {className: 'scene-v2-choice-popover', minWidth: 96, matchWidth: true, align: 'right', onSelect: item => selectMode(item.id)});
    });
  }

  function selectMode(value) {
    mode = value; parameters.setMode(mode, {force: true}); changed();
  }

  async function start() {
    lastError = null; feedback(''); render();
    try {
      // Candidate reads are snapshots. Do not enable any write until ready has
      // transferred ownership and the backend has read the live pointer again.
      await VrchApp.data.get(VrchSceneAppsStore.POINTER);
      await VrchApp.ready();
      await store.open();
      await catalog.load();
      await catalog.hydrateUserPresets(store);
      await restore(await store.getMeta(SESSION));
      makeControls();
      loaded = true;
      parameters.setMode(mode, {force: true});
      showPreview(); render();
    } catch (error) { failed(error); }
  }


  // ---- Output role ------------------------------------------------------------------------------------------------
  // A picture-only instance (Playground's output, a second screen) shows the visual being edited and nothing else.
  // The editor publishes the visual, its parameters and scene time; audio, tracking values and live image sources follow
  // as events. The output reads only the packaged catalog: no workspace, media, controls or text.
  // Live pictures reach the output at their own size (up to FRAME_MAX_WIDTH) as JPEG data URLs in parts: output
  // messages are limited to 16 KiB. A picture larger than the parts allow drops to a lower quality.
  const FRAME_MAX_WIDTH = 960, FRAME_PART = 15000, FRAME_PARTS = 16, AUDIO_MS = 33, TRACK_MS = 66, FRAME_MS = 100;
  let shownAt = 0, published = '', lastAudio = null, sentAudio = null, lastTrack = 0, lastFrame = 0, frameKey = 'A', frameBusy = false, frameId = 0, frameCanvas = null;
  function compact(sample) {
    if (!sample || typeof sample !== 'object') return null;
    const out = {};
    for (const [key, value] of Object.entries(sample)) out[key] = typeof value === 'number' ? Math.round(value * 1e4) / 1e4 : value && value.length ? Array.from(value, v => Math.round(v * 10) / 10) : value;
    return out;
  }
  function liveSource(key) { return media?.enabled && media.sources[key] ? media.sources[key] : null; }
  function publish() {
    if (isOutput || !relay || !loaded) return;
    const state = active ? {scene_id: active.definition.scene_id, params: active.instance.params, bindings: active.instance.bindings,
      modulation_master: active.instance.modulation_master, quality_mode: active.instance.quality_mode, shown_at: shownAt,
      live: {A: !!liveSource('A'), B: !!liveSource('B')}} : {scene_id: null};
    const text = JSON.stringify(state);
    if (text === published) return;
    published = text;
    try { relay.publish(state); } catch (_) {}
  }
  function send(data) { try { relay.send(data); } catch (_) {} }
  function sendFrame(key, url) {
    const id = ++frameId, n = Math.ceil(url.length / FRAME_PART);
    for (let i = 0; i < n; i++) send({type: 'frame', key, id, i, n, d: url.slice(i * FRAME_PART, (i + 1) * FRAME_PART)});
  }
  async function frameData(canvas) {
    const scale = Math.min(1, FRAME_MAX_WIDTH / Math.max(1, canvas.width));
    const width = Math.max(1, Math.round(canvas.width * scale)), height = Math.max(1, Math.round(canvas.height * scale));
    const small = frameCanvas ||= document.createElement('canvas');
    if (small.width !== width || small.height !== height) { small.width = width; small.height = height; }
    small.getContext('2d').drawImage(canvas, 0, 0, width, height);
    for (const quality of [0.82, 0.68, 0.5]) {
      const blob = await new Promise(resolve => small.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) return null;
      const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
      if (url.length <= FRAME_PART * FRAME_PARTS) return url;
    }
    return null;
  }
  function relayLive(now) {
    if (isOutput || !relay || !loaded || document.hidden) return;
    publish();
    if (!active || !mirror) return;
    if (lastAudio !== sentAudio) { sentAudio = lastAudio; send({type: 'audio', sample: compact(lastAudio)}); }
    if (active.definition.analysis_requirements?.length && now - lastTrack >= TRACK_MS) {
      lastTrack = now;
      const values = mirror.effect?.signalBus?.values || {}, tracking = {};
      for (const [key, value] of Object.entries(values)) if (key.startsWith('tracking.') && Number.isFinite(value)) tracking[key] = Math.round(value * 1e4) / 1e4;
      send({type: 'track', values: tracking});
    }
    if (!frameBusy && now - lastFrame >= FRAME_MS / 2) {
      // Live sources (camera, image channels) take turns; built-in samples need no frames.
      const keys = ['A', 'B'].filter(liveSource);
      if (!keys.length) return;
      frameKey = keys.includes(frameKey === 'A' ? 'B' : 'A') ? (frameKey === 'A' ? 'B' : 'A') : keys[0];
      lastFrame = now; frameBusy = true;
      const key = frameKey;
      void frameData(liveSource(key)).then(data => { if (data && liveSource(key)) sendFrame(key, data); }, () => {}).finally(() => { frameBusy = false; });
    }
  }
  function watchAudio(target) {
    // The editor's audio provider also feeds the output: each sample the preview reads is relayed.
    const set = target.setAudioProvider.bind(target);
    target.setAudioProvider = provider => set(provider ? () => { const sample = provider(); lastAudio = sample; return sample; } : (lastAudio = null, null));
  }
  class OutputPicture {
    constructor() { this.canvas = document.createElement('canvas'); this.busy = false; this.pending = null; this.live = false; this.id = null; this.parts = []; this.got = 0; }
    // Joins the parts of the newest picture; a part of a newer picture drops an unfinished one.
    take(data) {
      if (!Number.isInteger(data.id) || !Number.isInteger(data.n) || data.n < 1 || data.n > FRAME_PARTS
        || !Number.isInteger(data.i) || data.i < 0 || data.i >= data.n || typeof data.d !== 'string') return null;
      if (data.id !== this.id || this.parts.length !== data.n) { this.id = data.id; this.parts = new Array(data.n); this.got = 0; }
      if (this.parts[data.i] === undefined) { this.parts[data.i] = data.d; this.got++; }
      if (this.got < data.n) return null;
      const url = this.parts.join(''); this.id = null; this.parts = []; this.got = 0;
      return url;
    }
    async show(url, onDrawn) {
      if (typeof url !== 'string' || !url.startsWith('data:image/jpeg;base64,')) return;
      this.pending = url;
      if (this.busy) return;
      this.busy = true;
      try {
        while (this.pending) {
          const next = this.pending; this.pending = null;
          const image = new Image(); image.src = next;
          try { await image.decode(); } catch (_) { continue; }
          if (this.canvas.width !== image.naturalWidth || this.canvas.height !== image.naturalHeight) { this.canvas.width = image.naturalWidth; this.canvas.height = image.naturalHeight; }
          this.canvas.getContext('2d').drawImage(image, 0, 0);
          this.live = true; window.__shaderOutput.picture = [this.canvas.width, this.canvas.height]; onDrawn();
        }
      } finally { this.busy = false; }
    }
  }
  async function startOutput() {
    const host = document.createElement('div'); host.className = 'shader-output';
    document.body.replaceChildren(host);
    window.__shaderOutput = {frames: 0, followed: 0, scene: null};
    try {
      mirror = new VrchSceneMirror.SceneMirror({container: host, maxPixels: 1920 * 1080, analysis: false, sourceBindings: {0: 'A', 1: 'B'},
        analysisOptions: ShaderAnalysis.options, performance: {config: {performanceWindowFrames: 60, performanceOverrunWindows: 3, performanceRecoveryWindows: 6}}});
      await Promise.all([catalog.load(), VrchApp.ready()]);
    } catch (_) { return; }
    const pictures = {A: new OutputPicture(), B: new OutputPicture()};
    let relayed = null, shown = null, state = null, count = 1;
    mirror.setAudioProvider(() => relayed);
    const sources = () => {
      const a = state?.live?.A && pictures.A.live ? pictures.A.canvas : undefined, b = state?.live?.B && pictures.B.live ? pictures.B.canvas : undefined;
      mirror.setSources(a, count > 1 ? b : a);
    };
    const follow = next => {
      state = next; window.__shaderOutput.followed++; window.__shaderOutput.params = next?.params || null;
      if (!next || typeof next.scene_id !== 'string') { shown = null; window.__shaderOutput.scene = null; mirror.hide(); return; }
      const item = catalog.getBySceneId(next.scene_id);
      if (!item) return;
      const instance = contract.normalizeInstance(item.definition, {...catalog.makeInstance(catalog.itemKey(item)),
        ...(next.params ? {params: next.params} : {}), ...(next.bindings ? {bindings: next.bindings} : {}),
        ...(next.modulation_master ? {modulation_master: next.modulation_master} : {}), ...(next.quality_mode ? {quality_mode: next.quality_mode} : {})}, {trusted: false});
      count = item.definition.runtime?.max_sources ?? 1;
      for (const key of ['A', 'B']) if (!next.live?.[key]) pictures[key].live = false;
      if (shown?.scene_id !== next.scene_id || shown?.shown_at !== next.shown_at) {
        if (!mirror.show(item.definition, instance, true)) return;
        if (Number.isFinite(next.shown_at) && next.shown_at > 0) mirror.setSceneTime(Math.max(0, (performance.timeOrigin + performance.now() - next.shown_at) / 1000));
      } else mirror.patchInstance(instance);
      shown = {scene_id: next.scene_id, shown_at: next.shown_at}; window.__shaderOutput.scene = next.scene_id;
      sources();
    };
    relay?.onMessage(({kind, data} = {}) => {
      if (!data || typeof data !== 'object') return;
      if (kind === 'state') follow(data);
      else if (data.type === 'audio') relayed = data.sample && typeof data.sample === 'object' ? data.sample : null;
      else if (data.type === 'track' && data.values && typeof data.values === 'object') mirror.effect?.signalBus?.setExternalValues(data.values);
      else if (data.type === 'frame' && pictures[data.key]) { const url = pictures[data.key].take(data); if (url) void pictures[data.key].show(url, sources); }
    });
    const count_ = () => { window.__shaderOutput.frames++; requestAnimationFrame(count_); };
    requestAnimationFrame(count_);
    document.addEventListener('visibilitychange', () => { if (document.hidden) mirror.hide(); else if (state) { shown = null; follow(state); } });
    window.addEventListener('pagehide', () => { disposed = true; mirror?.dispose(); });
  }


  if (isOutput) { void startOutput(); return; }
  setInterval(() => relayLive(performance.now()), AUDIO_MS);
  $('retryTracking').addEventListener('click', () => { media?.stop(); mirror?.hide(); showPreview(); });
  $('saveVisual').addEventListener('click', saveVisual);
  $('retrySave').addEventListener('click', retry);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { media?.stop(); mirror?.hide(); } else if (!picker?.isOpen()) showPreview();
  });
  window.addEventListener('pagehide', () => {
    disposed = true; clearTimeout(timer); media?.dispose(); mirror?.dispose(); picker?.destroy?.(); store.close();
  });
  start();
})();
