/* Durable local store for VRCH Scene v1 definitions, instances, drafts, and revisions. */
(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VrchSceneStore = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root) {
  'use strict';

  const Contract = root.VrchSceneContract;
  const STORE_NAMES = Object.freeze(['definitions', 'instances', 'drafts', 'revisions', 'user_presets', 'meta']);
  const DATABASE_VERSION = 2;
  const DEFAULT_OPEN_TIMEOUT_MS = 2000;
  const USER_PRESET_CHANNEL = 'vrch-scene-user-presets-v1';

  function clone(value) {
    if (value == null) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function storageError(error, code) {
    const wrapped = new Error(error && error.message ? error.message : 'Scene storage operation failed.');
    wrapped.code = code || (error && error.code) || (error && error.name === 'QuotaExceededError' ? 'storage_evicted' : 'persistence_failed');
    wrapped.stage = 'persistence';
    wrapped.cause = error;
    return wrapped;
  }

  class MemoryBackend {
    constructor() {
      this.stores = Object.fromEntries(STORE_NAMES.map((name) => [name, new Map()]));
    }
    async get(store, key) { return clone(this.stores[store].get(key) || null); }
    async getAll(store) { return Array.from(this.stores[store].values()).map(clone); }
    async applyBatch(records, deletes = []) {
      records.forEach(({ store, key, value }) => this.stores[store].set(key, clone(value)));
      deletes.forEach(({ store, key }) => this.stores[store].delete(key));
    }
    async putMany(records) { return this.applyBatch(records); }
    async delete(store, key) { this.stores[store].delete(key); }
    async clear(store) { this.stores[store].clear(); }
    close() {}
  }

  class IndexedDbBackend {
    constructor(db) { this.db = db; }
    _request(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(clone(request.result == null ? null : request.result));
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
      });
    }
    async get(store, key) {
      const tx = this.db.transaction(store, 'readonly');
      return this._request(tx.objectStore(store).get(key));
    }
    async getAll(store) {
      const tx = this.db.transaction(store, 'readonly');
      return this._request(tx.objectStore(store).getAll());
    }
    applyBatch(records, deletes = []) {
      const stores = Array.from(new Set(records.concat(deletes).map((record) => record.store)));
      if (!stores.length) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(stores, 'readwrite', { durability: 'strict' });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
        records.forEach(({ store, value }) => tx.objectStore(store).put(clone(value)));
        deletes.forEach(({ store, key }) => tx.objectStore(store).delete(key));
      });
    }
    putMany(records) { return this.applyBatch(records); }
    delete(store, key) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(store, 'readwrite', { durability: 'strict' });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed.'));
        tx.objectStore(store).delete(key);
      });
    }
    clear(store) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction(store, 'readwrite', { durability: 'strict' });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB clear failed.'));
        tx.objectStore(store).clear();
      });
    }
    close() { this.db.close(); }
  }

  function openDatabase(name, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = 0;
      let request;
      const clearOpenTimeout = () => {
        if (!timeoutId || !root || typeof root.clearTimeout !== 'function') return;
        root.clearTimeout(timeoutId);
        timeoutId = 0;
      };
      const resolveOnce = (backend) => {
        if (settled) {
          backend.close();
          return;
        }
        settled = true;
        clearOpenTimeout();
        resolve(backend);
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        clearOpenTimeout();
        reject(error);
      };
      try {
        request = root.indexedDB.open(name, DATABASE_VERSION);
      } catch (error) {
        rejectOnce(error);
        return;
      }
      if (timeoutMs > 0 && root && typeof root.setTimeout === 'function') {
        timeoutId = root.setTimeout(() => {
          const error = new Error('IndexedDB open timed out after ' + timeoutMs + 'ms.');
          error.code = 'storage_open_timeout';
          rejectOnce(error);
        }, timeoutMs);
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('definitions')) db.createObjectStore('definitions', { keyPath: 'content_hash' });
        if (!db.objectStoreNames.contains('instances')) db.createObjectStore('instances', { keyPath: 'instance_id' });
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'transaction_id' });
        if (!db.objectStoreNames.contains('revisions')) {
          const store = db.createObjectStore('revisions', { keyPath: 'revision_id' });
          store.createIndex('committed_at', 'committed_at');
        }
        if (!db.objectStoreNames.contains('user_presets')) {
          const store = db.createObjectStore('user_presets', { keyPath: 'preset_id' });
          store.createIndex('updated_at', 'updated_at');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      request.onsuccess = () => resolveOnce(new IndexedDbBackend(request.result));
      request.onerror = () => rejectOnce(request.error || new Error('IndexedDB open failed.'));
      request.onblocked = () => rejectOnce(new Error('IndexedDB upgrade is blocked by another page.'));
    });
  }

  class SceneStore {
    constructor(options = {}) {
      this.name = options.name || 'vrch-scene-store-v1';
      this.allowMemoryFallback = options.allowMemoryFallback !== false;
      this.backendFactory = typeof options.backendFactory === 'function' ? options.backendFactory : null;
      this.openTimeoutMs = Number.isFinite(Number(options.openTimeoutMs)) && Number(options.openTimeoutMs) > 0
        ? Number(options.openTimeoutMs)
        : DEFAULT_OPEN_TIMEOUT_MS;
      this.backend = null;
      this.mode = 'opening';
      this.lastError = null;
      this.userPresetListeners = new Set();
      this.userPresetChannel = null;
    }

    async open() {
      if (this.backend) return this;
      try {
        if (this.backendFactory) this.backend = await this.backendFactory();
        else {
          if (!root.indexedDB) throw new Error('IndexedDB is unavailable.');
          this.backend = await openDatabase(this.name, this.openTimeoutMs);
        }
        this.mode = 'durable';
      } catch (error) {
        this.lastError = storageError(error);
        if (this.backendFactory || !this.allowMemoryFallback) throw this.lastError;
        this.backend = new MemoryBackend();
        this.mode = 'memory';
      }
      return this;
    }

    async _ready() { if (!this.backend) await this.open(); return this.backend; }

    _ensureUserPresetChannel() {
      if (this.backendFactory || this.userPresetChannel || !root.document || typeof root.BroadcastChannel !== 'function') return this.userPresetChannel;
      try {
        this.userPresetChannel = new root.BroadcastChannel(USER_PRESET_CHANNEL);
        this.userPresetChannel.addEventListener('message', () => this._emitUserPresetsChanged('remote'));
      } catch (_) {
        this.userPresetChannel = null;
      }
      return this.userPresetChannel;
    }

    _emitUserPresetsChanged(source) {
      this.userPresetListeners.forEach((listener) => {
        try { listener({ source: source || 'local' }); } catch (_) {}
      });
    }

    _notifyUserPresetsChanged() {
      this._emitUserPresetsChanged('local');
      const channel = this._ensureUserPresetChannel();
      if (channel) {
        try { channel.postMessage({ type: 'user-presets-changed', at: Date.now() }); } catch (_) {}
      }
    }

    watchUserPresets(listener) {
      if (typeof listener !== 'function') return () => {};
      this.userPresetListeners.add(listener);
      this._ensureUserPresetChannel();
      return () => this.userPresetListeners.delete(listener);
    }

    async putDefinition(definition, contentHash) {
      const backend = await this._ready();
      try {
        if (!Contract) throw new Error('Scene contract is unavailable.');
        Contract.validateDefinition(definition, { trusted: false });
        const hash = contentHash || await Contract.sha256Ref(definition);
        await backend.putMany([{ store: 'definitions', key: hash, value: { content_hash: hash, scene_id: definition.scene_id, definition: clone(definition), saved_at: new Date().toISOString() } }]);
        return hash;
      } catch (error) { throw storageError(error); }
    }

    async getDefinition(contentHash) {
      const record = await (await this._ready()).get('definitions', contentHash);
      return record ? clone(record.definition) : null;
    }

    async saveDraft(draft) {
      if (!draft || !draft.transaction_id) throw storageError(new Error('Draft transaction_id is required.'));
      try {
        await (await this._ready()).putMany([{ store: 'drafts', key: draft.transaction_id, value: Object.assign(clone(draft), { saved_at: new Date().toISOString() }) }]);
      } catch (error) { throw storageError(error); }
    }

    async deleteDraft(transactionId) {
      try { await (await this._ready()).delete('drafts', transactionId); }
      catch (error) { throw storageError(error); }
    }

    async saveCommit(definition, instance, revision) {
      if (!revision || !revision.revision_id) throw storageError(new Error('Revision is required.'));
      const backend = await this._ready();
      try {
        const hash = await Contract.sha256Ref(definition);
        if (!instance || !instance.instance_id || !instance.scene_ref || instance.scene_ref.content_hash !== hash) throw new Error('Commit instance does not reference the exact definition hash.');
        const records = [
          { store: 'definitions', key: hash, value: { content_hash: hash, scene_id: definition.scene_id, definition: clone(definition), saved_at: new Date().toISOString() } },
          { store: 'instances', key: instance.instance_id, value: clone(instance) },
          { store: 'revisions', key: revision.revision_id, value: clone(revision) },
          { store: 'meta', key: 'active', value: { key: 'active', revision_id: revision.revision_id, instance_id: instance.instance_id, content_hash: hash, saved_at: new Date().toISOString() } }
        ];
        await backend.putMany(records);
        if (revision.transaction_id) await backend.delete('drafts', revision.transaction_id);
        return { durable: this.mode === 'durable', content_hash: hash, revision_id: revision.revision_id };
      } catch (error) { throw storageError(error); }
    }

    async requestPersistence() {
      let granted = false;
      let supported = false;
      try {
        supported = !!(root.navigator && root.navigator.storage && root.navigator.storage.persist);
        if (supported) granted = await root.navigator.storage.persist();
        await this.setMeta('persistence-status', { supported, granted, mode: this.mode });
      } catch (error) {
        this.lastError = storageError(error);
      }
      return { supported, granted, mode: this.mode };
    }

    async beginRuntimeCommit(definition, instance, revision) {
      if (!revision || !revision.revision_id) throw storageError(new Error('Revision is required.'));
      const backend = await this._ready();
      try {
        const hash = await Contract.sha256Ref(definition);
        if (!instance || !instance.instance_id || !instance.scene_ref || instance.scene_ref.content_hash !== hash) throw new Error('Runtime commit instance does not reference the exact definition hash.');
        await backend.applyBatch([
          { store: 'definitions', key: hash, value: { content_hash: hash, scene_id: definition.scene_id, definition: clone(definition), saved_at: new Date().toISOString() } },
          { store: 'instances', key: instance.instance_id, value: clone(instance) },
          { store: 'revisions', key: revision.revision_id, value: clone(revision) },
          { store: 'meta', key: 'pending-runtime-commit', value: { key: 'pending-runtime-commit', revision_id: revision.revision_id, instance_id: instance.instance_id, content_hash: hash, transaction_id: revision.transaction_id || null, started_at: new Date().toISOString() } }
        ]);
        return { durable: this.mode === 'durable', content_hash: hash, revision_id: revision.revision_id };
      } catch (error) { throw storageError(error); }
    }

    async finalizeRuntimeCommit(definition, instance, revision) {
      const backend = await this._ready();
      try {
        const hash = await Contract.sha256Ref(definition);
        const active = {
          key: 'active', revision_id: revision.revision_id, instance_id: instance.instance_id,
          content_hash: hash, runtime_owner: 'scene', saved_at: new Date().toISOString()
        };
        const deletes = [{ store: 'meta', key: 'pending-runtime-commit' }];
        if (revision.transaction_id) deletes.push({ store: 'drafts', key: revision.transaction_id });
        await backend.applyBatch([{ store: 'meta', key: 'active', value: active }], deletes);
        return { durable: this.mode === 'durable', content_hash: hash, revision_id: revision.revision_id };
      } catch (error) { throw storageError(error); }
    }

    async setRuntimeOwner(owner) {
      const runtimeOwner = owner === 'scene' ? 'scene' : 'legacy';
      const backend = await this._ready();
      try {
        const active = await backend.get('meta', 'active');
        if (!active) return { durable: this.mode === 'durable', runtime_owner: runtimeOwner };
        await backend.applyBatch([{
          store: 'meta',
          key: 'active',
          value: Object.assign({}, active, { runtime_owner: runtimeOwner, saved_at: new Date().toISOString() })
        }]);
        return { durable: this.mode === 'durable', runtime_owner: runtimeOwner };
      } catch (error) { throw storageError(error); }
    }

    async rollbackRuntimeCommit(revision, error) {
      const backend = await this._ready();
      const revisionId = revision && revision.revision_id;
      const failure = {
        key: 'last-runtime-commit-failure', revision_id: revisionId || null,
        code: error && error.code || 'persistence_failed', stage: error && error.stage || 'persistence',
        at: new Date().toISOString()
      };
      const deletes = [{ store: 'meta', key: 'pending-runtime-commit' }];
      if (revisionId) deletes.push({ store: 'revisions', key: revisionId });
      try { await backend.applyBatch([{ store: 'meta', key: failure.key, value: failure }], deletes); }
      catch (rollbackError) { this.lastError = storageError(rollbackError); }
      return failure;
    }

    async loadRuntimeState() {
      const backend = await this._ready();
      try {
        const active = await backend.get('meta', 'active');
        const pending = await backend.get('meta', 'pending-runtime-commit');
        if (pending) {
          await backend.applyBatch([
            { store: 'meta', key: 'last-runtime-commit-failure', value: { key: 'last-runtime-commit-failure', revision_id: pending.revision_id || null, code: 'interrupted_commit', stage: 'recovery', at: new Date().toISOString() } }
          ], [
            { store: 'meta', key: 'pending-runtime-commit' },
            ...(pending.revision_id && (!active || active.revision_id !== pending.revision_id) ? [{ store: 'revisions', key: pending.revision_id }] : [])
          ]);
        }
        if (!active) return { active: null, history: await this.listHistory(50), recovered_interrupted_commit: !!pending };
        const [revision, definitionRecord, instance] = await Promise.all([
          backend.get('revisions', active.revision_id),
          backend.get('definitions', active.content_hash),
          backend.get('instances', active.instance_id)
        ]);
        if (!revision || !definitionRecord || !instance) throw storageError(new Error('Durable active pointer references missing scene data.'), 'storage_evicted');
        Contract.validateDefinition(definitionRecord.definition, { trusted: false });
        const hash = await Contract.sha256Ref(definitionRecord.definition);
        if (hash !== active.content_hash || !instance.scene_ref || instance.scene_ref.content_hash !== hash || !revision.scene_ref || revision.scene_ref.content_hash !== hash) {
          throw storageError(new Error('Durable active scene failed content-address validation.'), 'storage_evicted');
        }
        return {
          active: { definition: clone(definitionRecord.definition), instance: clone(instance), revision: clone(revision), runtime_owner: active.runtime_owner || 'scene' },
          history: await this.listHistory(50),
          recovered_interrupted_commit: !!pending
        };
      } catch (error) { throw storageError(error, error && error.code); }
    }

    async listHistory(limit = 50) {
      try {
        const rows = await (await this._ready()).getAll('revisions');
        return rows.sort((a, b) => String(b.committed_at || '').localeCompare(String(a.committed_at || ''))).slice(0, Math.max(1, Math.min(200, limit)));
      } catch (error) { throw storageError(error); }
    }

    async restoreAsNew(revisionId) {
      const backend = await this._ready();
      const revision = await backend.get('revisions', revisionId);
      if (!revision) throw storageError(new Error('Revision was not found.'));
      const definitionRecord = await backend.get('definitions', revision.scene_ref.content_hash);
      if (!definitionRecord) throw storageError(new Error('Revision definition was not found.'));
      const instance = clone(revision.instance_snapshot);
      instance.instance_id = 'restore-' + (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : Date.now().toString(36));
      return { definition: clone(definitionRecord.definition), instance: instance, source_revision: clone(revision) };
    }

    async saveUserPreset(definition, instance, options = {}) {
      const backend = await this._ready();
      try {
        Contract.validateDefinition(definition, { trusted: false });
        const hash = await Contract.sha256Ref(definition);
        if (!instance || !instance.scene_ref || instance.scene_ref.content_hash !== hash) throw new Error('User preset instance does not reference the exact definition hash.');
        const normalized = Contract.normalizeInstance(definition, instance, { trusted: false });
        const requestedId = String(options.presetId || '').trim();
        const randomId = root.crypto && typeof root.crypto.randomUUID === 'function' ? root.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        const presetId = (requestedId || 'user-' + randomId).slice(0, 120);
        const existing = await backend.get('user_presets', presetId);
        const now = new Date().toISOString();
        const name = String(options.name || existing && existing.name || definition.title || 'Untitled visual').trim().slice(0, 80) || 'Untitled visual';
        const thumbnail = String(options.thumbnailDataUrl || existing && existing.thumbnail_data_url || '');
        const record = {
          schema_version: 1,
          preset_id: presetId,
          name: name,
          scene_ref: { scene_id: definition.scene_id, content_hash: hash },
          instance_snapshot: clone(normalized),
          thumbnail_data_url: /^data:image\/(?:png|jpeg|webp);base64,/.test(thumbnail) ? thumbnail : '',
          created_at: existing && existing.created_at || now,
          updated_at: now,
          base_preset_id: options.basePresetId || existing && existing.base_preset_id || null,
          package_residue: clone(options.packageResidue || existing && existing.package_residue || {})
        };
        await backend.applyBatch([
          { store: 'definitions', key: hash, value: { content_hash: hash, scene_id: definition.scene_id, definition: clone(definition), saved_at: now } },
          { store: 'user_presets', key: presetId, value: record }
        ]);
        this._notifyUserPresetsChanged();
        return Object.assign(clone(record), { durable: this.mode === 'durable' });
      } catch (error) { throw storageError(error); }
    }

    async listUserPresets() {
      const backend = await this._ready();
      try {
        const records = await backend.getAll('user_presets');
        const items = [];
        for (const record of records.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))) {
          if (!record || !record.preset_id || !record.scene_ref || !record.instance_snapshot) continue;
          const definitionRecord = await backend.get('definitions', record.scene_ref.content_hash);
          if (!definitionRecord || !definitionRecord.definition) continue;
          const definition = definitionRecord.definition;
          Contract.validateDefinition(definition, { trusted: false });
          const hash = await Contract.sha256Ref(definition);
          if (hash !== record.scene_ref.content_hash) continue;
          const instance = Contract.normalizeInstance(definition, record.instance_snapshot, { trusted: false });
          items.push({ record: Object.assign(clone(record), { instance_snapshot: instance }), definition: clone(definition) });
        }
        return items;
      } catch (error) { throw storageError(error); }
    }

    async getUserPreset(presetId) {
      const record = await (await this._ready()).get('user_presets', String(presetId || ''));
      if (!record) return null;
      const definitionRecord = await (await this._ready()).get('definitions', record.scene_ref && record.scene_ref.content_hash);
      return definitionRecord && definitionRecord.definition ? { record: clone(record), definition: clone(definitionRecord.definition) } : null;
    }

    async deleteUserPreset(presetId) {
      try {
        await (await this._ready()).delete('user_presets', String(presetId || ''));
        this._notifyUserPresetsChanged();
      } catch (error) { throw storageError(error); }
    }

    async exportPresets() {
      const items = await this.listUserPresets();
      return {
        vibe_section: 'visuals.presets',
        schema_version: 1,
        presets: items.map(({ record, definition }) => Object.assign({}, clone(record.package_residue || {}), {
          preset_id: record.preset_id,
          name: record.name,
          kind: 'vrch-scene-v1',
          scene_ref: clone(record.scene_ref),
          definition: clone(definition),
          instance: clone(record.instance_snapshot)
        }))
      };
    }

    async importPresets(section) {
      if (!section || section.vibe_section !== 'visuals.presets' || section.schema_version !== 1 || !Array.isArray(section.presets)) throw storageError(new Error('Invalid visuals.presets section.'));
      const imported = [];
      for (const preset of section.presets) {
        if (!preset || preset.kind !== 'vrch-scene-v1') continue;
        Contract.validateDefinition(preset.definition, { trusted: false });
        const hash = await Contract.sha256Ref(preset.definition);
        if (!preset.scene_ref || preset.scene_ref.content_hash !== hash) throw storageError(new Error('Imported SceneDefinition hash mismatch.'));
        const knownKeys = new Set(['preset_id', 'name', 'kind', 'scene_ref', 'definition', 'instance']);
        const packageResidue = Object.fromEntries(Object.entries(preset).filter(([key]) => !knownKeys.has(key)).map(([key, value]) => [key, clone(value)]));
        const instance = preset.instance || {
          schema_version: 1,
          instance_id: 'imported:' + (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : Date.now().toString(36)),
          scene_ref: { scene_id: preset.definition.scene_id, content_hash: hash },
          params: {}, bindings: clone(preset.definition.default_bindings || []),
          modulation_master: { audio: { enabled: true, gain: 1 } }, quality_mode: 'auto'
        };
        await this.saveUserPreset(preset.definition, instance, {
          presetId: preset.preset_id,
          name: preset.name,
          packageResidue: packageResidue
        });
        imported.push(hash);
      }
      return { imported: imported.length, ignored: section.presets.length - imported.length, hashes: imported };
    }

    async estimate() {
      if (root.navigator && root.navigator.storage && root.navigator.storage.estimate) {
        try { return await root.navigator.storage.estimate(); } catch (_) {}
      }
      return { usage: null, quota: null };
    }

    async setMeta(key, value) {
      try { await (await this._ready()).putMany([{ store: 'meta', key: key, value: { key: key, value: clone(value), saved_at: new Date().toISOString() } }]); }
      catch (error) { throw storageError(error); }
    }

    async getMeta(key) {
      try { const record = await (await this._ready()).get('meta', key); return record ? clone(record.value) : null; }
      catch (error) { throw storageError(error); }
    }

    close() {
      if (this.backend) this.backend.close();
      if (this.userPresetChannel) this.userPresetChannel.close();
      this.userPresetChannel = null;
      this.userPresetListeners.clear();
      this.backend = null;
      this.mode = 'closed';
    }
  }

  return Object.freeze({ SceneStore: SceneStore, MemoryBackend: MemoryBackend, storageError: storageError, DATABASE_VERSION: DATABASE_VERSION, DEFAULT_OPEN_TIMEOUT_MS: DEFAULT_OPEN_TIMEOUT_MS });
});
