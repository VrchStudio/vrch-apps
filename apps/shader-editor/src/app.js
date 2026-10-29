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
    if (!mirror.show(active.definition, active.instance, true)) feedback('This visual could not be previewed on this device.');
    else media?.resume(mirror, active.definition);
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
