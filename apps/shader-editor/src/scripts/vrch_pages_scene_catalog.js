/* Shared deterministic Scene catalog used by Settings V2 and Shader Editor V2. */
(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VrchSceneCatalog = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root) {
  'use strict';

  const Contract = root.VrchSceneContract;
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function entryKey(entry) {
    if (!entry) return '';
    const hash = entry.scene_ref && entry.scene_ref.content_hash || '';
    if (entry.user_preset_id) return 'preset:' + entry.user_preset_id;
    if (entry.ephemeral) return 'candidate:' + hash;
    const sceneId = entry.scene_ref && entry.scene_ref.scene_id || '';
    return sceneId ? 'builtin:' + sceneId : entry.item_key ? String(entry.item_key) : 'builtin:' + hash;
  }
  function comparableInstance(instance) {
    if (!instance) return '';
    return JSON.stringify({
      scene_ref: instance.scene_ref,
      params: instance.params,
      bindings: instance.bindings,
      modulation_master: instance.modulation_master,
      quality_mode: instance.quality_mode
    });
  }

  class PresetCatalog {
    constructor(options = {}) {
      this.baseUrl = options.baseUrl || 'scenes/v1/';
      this.cacheToken = options.cacheToken || '20261004-perf-r13';
      this.catalog = null;
      this.definitions = new Map();
      this.selectedKey = null;
      this.listeners = new Map();
      this.mounts = new Set();
    }

    on(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
      return () => this.listeners.get(type).delete(listener);
    }
    _emit(type, value) { (this.listeners.get(type) || []).forEach((listener) => listener(clone(value))); }

    async load() {
      const response = await fetch(this.baseUrl + 'catalog.json?v=' + encodeURIComponent(this.cacheToken), { cache: 'no-store' });
      if (!response.ok) throw new Error('Scene catalog HTTP ' + response.status);
      const catalog = await response.json();
      const definitions = await Promise.all((catalog.entries || []).map(async (entry) => {
        const item = await fetch(this.baseUrl + entry.definition_path + '?v=' + encodeURIComponent(this.cacheToken), { cache: 'no-store' });
        if (!item.ok) throw new Error('Scene definition HTTP ' + item.status);
        return item.json();
      }));
      for (let index = 0; index < definitions.length; index += 1) {
        const definition = definitions[index];
        const entry = catalog.entries[index];
        Contract.validateDefinition(definition, { trusted: entry.trusted === true });
        const hash = await Contract.sha256Ref(definition);
        if (hash !== entry.scene_ref.content_hash) throw new Error('Catalog hash mismatch: ' + definition.scene_id);
        this.definitions.set(hash, definition);
      }
      this.catalog = catalog;
      this.catalog.entries.forEach((entry) => { entry.item_key = entryKey(entry); });
      this.renderAll();
      this._emit('loaded', this.list());
      return this.list();
    }

    list(options = {}) {
      const category = options.category || null;
      const betaOnly = options.betaOnly === true;
      const entries = (this.catalog && this.catalog.entries || []).filter((entry) => {
        const definition = this.definitions.get(entry.scene_ref.content_hash);
        return definition &&
          (!category || definition.catalog.category === category) &&
          (!betaOnly || entry.beta_gate === true || entry.local === true) &&
          (options.includeUser !== false || entry.user_saved !== true) &&
          (options.includeEphemeral !== false || entry.ephemeral !== true) &&
          (options.pickerOnly !== true || entry.picker_visible !== false);
      });
      return entries.map((entry) => ({ entry: clone(entry), definition: clone(this.definitions.get(entry.scene_ref.content_hash)) }));
    }

    itemKey(itemOrEntry) { return entryKey(itemOrEntry && itemOrEntry.entry || itemOrEntry); }

    get(keyOrHash) {
      const value = String(keyOrHash || '');
      const entries = this.catalog && this.catalog.entries || [];
      const entry = entries.find((item) => entryKey(item) === value) || entries.find((item) => item.scene_ref.content_hash === value);
      const definition = entry && this.definitions.get(entry.scene_ref.content_hash);
      return definition && entry ? { entry: clone(entry), definition: clone(definition) } : null;
    }

    getByHash(contentHash) {
      const value = String(contentHash || '');
      const entries = this.catalog && this.catalog.entries || [];
      const entry = entries.find((item) => item.scene_ref.content_hash === value && item.user_saved !== true && item.ephemeral !== true) ||
        entries.find((item) => item.scene_ref.content_hash === value);
      const definition = entry && this.definitions.get(value);
      return definition && entry ? { entry: clone(entry), definition: clone(definition) } : null;
    }

    getBySceneId(sceneId) {
      const value = String(sceneId || '').replace(/^builtin:/, '');
      const entries = this.catalog && this.catalog.entries || [];
      const entry = entries.find((item) => item.scene_ref && item.scene_ref.scene_id === value && item.user_saved !== true && item.ephemeral !== true) ||
        entries.find((item) => item.scene_ref && item.scene_ref.scene_id === value);
      const definition = entry && this.definitions.get(entry.scene_ref.content_hash);
      return definition && entry ? { entry: clone(entry), definition: clone(definition) } : null;
    }

    async addLocal(definition, instance) {
      Contract.validateDefinition(definition, { trusted: false });
      const hash = await Contract.sha256Ref(definition);
      const fallbackInstance = {
        schema_version: 1,
        instance_id: 'local:' + (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : Date.now().toString(36)),
        scene_ref: { scene_id: definition.scene_id, content_hash: hash },
        params: {},
        bindings: clone(definition.default_bindings || []),
        modulation_master: { audio: { enabled: true, gain: 1 } },
        quality_mode: 'auto'
      };
      const normalized = Contract.normalizeInstance(definition, instance || fallbackInstance, { trusted: false });
      if (!this.catalog) this.catalog = { catalog_version: 'local', schema_version: 1, entries: [] };
      const key = 'candidate:' + hash;
      const existing = this.catalog.entries.find((entry) => entryKey(entry) === key);
      const candidateEntry = {
          scene_ref: { scene_id: definition.scene_id, content_hash: hash },
          definition_path: null,
          default_instance: normalized,
          trusted: false,
          beta_gate: false,
          local: true,
          ephemeral: true,
          picker_visible: false,
          item_key: key
        };
      if (existing) Object.assign(existing, candidateEntry);
      else this.catalog.entries.push(candidateEntry);
      this.definitions.set(hash, clone(definition));
      this.renderAll();
      this._emit('loaded', this.list());
      return hash;
    }

    setUserPresets(items) {
      if (!this.catalog) this.catalog = { catalog_version: 'local', schema_version: 1, entries: [] };
      this.catalog.entries = this.catalog.entries.filter((entry) => entry.user_saved !== true);
      (Array.isArray(items) ? items : []).forEach((item) => {
        const record = item && item.record;
        const definition = item && item.definition;
        if (!record || !definition || !record.preset_id || !record.scene_ref || !record.instance_snapshot) return;
        const hash = record.scene_ref.content_hash;
        const trusted = this.catalog.entries.some((entry) => entry.scene_ref.content_hash === hash && entry.trusted === true && entry.user_saved !== true);
        this.definitions.set(hash, clone(definition));
        this.catalog.entries.push({
          item_key: 'preset:' + record.preset_id,
          user_preset_id: record.preset_id,
          display_name: record.name,
          scene_ref: clone(record.scene_ref),
          definition_path: null,
          default_instance: clone(record.instance_snapshot),
          thumbnail_ref: record.thumbnail_data_url || '',
          trusted: trusted,
          beta_gate: false,
          local: true,
          user_saved: true,
          updated_at: record.updated_at || '',
          picker_visible: true
        });
      });
      this.renderAll();
      this._emit('loaded', this.list());
      return this.list({ pickerOnly: true });
    }

    async hydrateUserPresets(store) {
      if (!store || typeof store.listUserPresets !== 'function') return [];
      return this.setUserPresets(await store.listUserPresets());
    }

    findMatchingKey(contentHash, instance) {
      const hash = String(contentHash || '');
      const signature = comparableInstance(instance);
      const entries = this.catalog && this.catalog.entries || [];
      const exact = signature && entries.find((entry) => entry.scene_ref.content_hash === hash && comparableInstance(entry.default_instance) === signature);
      return entryKey(exact || entries.find((entry) => entry.scene_ref.content_hash === hash && entry.user_saved !== true && entry.ephemeral !== true) || entries.find((entry) => entry.scene_ref.content_hash === hash)) || null;
    }

    select(keyOrHash, source) {
      const item = this.get(keyOrHash);
      if (!item) return null;
      this.selectedKey = entryKey(item.entry);
      this.renderAll();
      this._emit('select', Object.assign(item, { source: source || 'catalog' }));
      return item;
    }

    mount(element, options = {}) {
      if (!element) throw new Error('PresetCatalog.mount requires an element.');
      this.mounts.add({ element: element, options: clone(options) });
      this._render(element, options);
      return () => {
        for (const mount of this.mounts) if (mount.element === element) this.mounts.delete(mount);
      };
    }

    renderAll() { this.mounts.forEach((mount) => this._render(mount.element, mount.options)); }

    _render(element, options) {
      const items = this.list({ category: options.category || null, betaOnly: options.betaOnly === true });
      element.replaceChildren();
      element.classList.add('scene-preset-list');
      items.forEach(({ entry, definition }) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ui-grid-btn scene-preset-item';
        const key = entryKey(entry);
        button.dataset.sceneKey = key;
        button.classList.toggle('is-active', this.selectedKey === key);
        button.setAttribute('aria-pressed', String(this.selectedKey === key));
        const thumbnailRef = String(entry.thumbnail_ref || definition.catalog.thumbnail_ref || '');
        if (/^(?:scenes\/|data:image\/)/.test(thumbnailRef)) {
          const thumbnail = document.createElement('img');
          thumbnail.className = 'scene-preset-item__thumbnail';
          thumbnail.alt = '';
          thumbnail.loading = 'lazy';
          thumbnail.decoding = 'async';
          thumbnail.src = thumbnailRef + (thumbnailRef.startsWith('data:') ? '' : '?v=' + encodeURIComponent(this.cacheToken));
          button.classList.add('has-thumbnail');
          thumbnail.addEventListener('error', () => { button.classList.remove('has-thumbnail'); thumbnail.remove(); }, { once: true });
          button.append(thumbnail);
        }
        const copy = document.createElement('span');
        copy.className = 'scene-preset-item__copy';
        const name = document.createElement('span');
        name.className = 'scene-preset-item__name';
        name.textContent = entry.display_name || definition.title;
        const meta = document.createElement('span');
        meta.className = 'scene-preset-item__meta';
        meta.textContent = definition.catalog.category + ' · ' + definition.runtime.max_sources + ' source' + (definition.runtime.max_sources === 1 ? '' : 's');
        copy.append(name, meta);
        button.append(copy);
        button.addEventListener('click', () => this.select(key, options.source || 'catalog'));
        element.append(button);
      });
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'scene-empty-state';
        empty.textContent = this.catalog ? 'No scenes in this view.' : 'Loading scenes…';
        element.append(empty);
      }
    }

    rebaseInstance(keyOrHash, previousInstance) {
      const item = this.get(keyOrHash);
      if (!item) throw new Error('Scene preset is unavailable.');
      const previousParams = previousInstance && previousInstance.params || {};
      const compatibleParams = {};
      (item.definition.parameters || []).forEach((parameter) => {
        if (Object.prototype.hasOwnProperty.call(previousParams, parameter.key)) compatibleParams[parameter.key] = clone(previousParams[parameter.key]);
      });
      const instance = this.makeInstance(this.itemKey(item), {
        instance_id: previousInstance && previousInstance.instance_id,
        params: compatibleParams
      });
      const candidate = clone(instance);
      if (previousInstance && previousInstance.modulation_master) candidate.modulation_master = clone(previousInstance.modulation_master);
      if (previousInstance && previousInstance.quality_mode) candidate.quality_mode = previousInstance.quality_mode;
      if (previousInstance && Array.isArray(previousInstance.bindings)) candidate.bindings = clone(previousInstance.bindings);
      try { return Contract.normalizeInstance(item.definition, candidate, { trusted: item.entry.trusted === true }); }
      catch (_) { return instance; }
    }

    makeInstance(keyOrHash, overrides = {}) {
      const item = this.get(keyOrHash);
      if (!item) throw new Error('Scene preset is unavailable.');
      const instance = clone(item.entry.default_instance);
      instance.instance_id = overrides.instance_id || 'scene-' + (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : Date.now().toString(36));
      instance.params = Object.assign({}, instance.params, clone(overrides.params || {}));
      if (overrides.bindings) instance.bindings = clone(overrides.bindings);
      return Contract.normalizeInstance(item.definition, instance, { trusted: item.entry.trusted === true });
    }
  }

  return Object.freeze({ PresetCatalog: PresetCatalog });
});
