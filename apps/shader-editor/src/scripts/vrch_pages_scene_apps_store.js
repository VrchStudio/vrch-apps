/* SceneStore backend: immutable App blobs and one atomic CAS snapshot pointer. */
(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VrchSceneAppsStore = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root) {
  'use strict';

  const STORES = ['definitions', 'instances', 'drafts', 'revisions', 'user_presets', 'meta'];
  const POINTER = 'shader-editor-store-v1';
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const error = (code, message) => Object.assign(new Error(message), {code, stage: 'persistence'});
  const empty = () => ({schema_version: 1, stores: Object.fromEntries(STORES.map(name => [name, []]))});
  const identity = () => Array.from(root.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

  class AppsBackend {
    constructor(sdk, options = {}) {
      this.sdk = sdk;
      this.contract = options.contract || root.VrchSceneContract;
      this.pointerKey = options.pointerKey || POINTER;
      this.snapshot = null;
      this.pointer = null;
      this.version = 0;
      this.fileVersion = null;
      this.pending = null;
      this.closed = false;
      this.queue = Promise.resolve();
    }

    _check() {
      if (this.closed) throw error('instance_closed', 'This editor instance has closed.');
    }

    _serial(action) {
      const run = this.queue.then(() => { this._check(); return action(); });
      this.queue = run.catch(() => {});
      return run;
    }

    async open() {
      await this.refresh();
      return this;
    }

    refresh() {
      return this._serial(async () => {
        if (this.pending) return this._resolvePending();
        return this._read();
      });
    }

    check() {
      return this._serial(async () => {
        if (this.pending) return this._resolvePending();
        const latest = await this.sdk.data.get(this.pointerKey);
        if (latest.version !== this.version) throw error('version_conflict', 'Saved editor data changed. Reopen it before saving again.');
        return this;
      });
    }

    async _read() {
      // A previous snapshot may be collected while a candidate downloads it.
      // Only retry when the live pointer actually changed; corrupt data is an error.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        this._check();
        const current = await this.sdk.data.get(this.pointerKey);
        try {
          let snapshot = empty(), fileVersion = null;
          if (current.exists) {
            if (current.value?.schema_version !== 1 || !current.value.fileId || !current.value.hash) {
              throw error('persistence_invalid', 'Saved editor data uses an unsupported format.');
            }
            const file = await this.sdk.files.get(current.value.fileId);
            snapshot = JSON.parse(await file.data.text());
            if (snapshot.schema_version !== 1 || !snapshot.stores || STORES.some(name => !Array.isArray(snapshot.stores[name]))) {
              throw error('persistence_invalid', 'Saved editor data is incomplete.');
            }
            if (await this.contract.sha256Ref(snapshot) !== current.value.hash) {
              throw error('persistence_invalid', 'Saved editor data did not match its content.');
            }
            for (const name of STORES) {
              if (snapshot.stores[name].some(row => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string')) {
                throw error('persistence_invalid', 'Saved editor records are invalid.');
              }
            }
            fileVersion = file.version;
          }
          this._check();
          this.snapshot = snapshot;
          this.pointer = current.exists ? clone(current.value) : null;
          this.version = current.version;
          this.fileVersion = fileVersion;
          return this;
        } catch (failure) {
          const latest = await this.sdk.data.get(this.pointerKey);
          if (latest.version === current.version || attempt === 2) throw failure;
        }
      }
    }

    _records(store) {
      if (!STORES.includes(store)) throw error('persistence_invalid', 'Unknown editor record store.');
      if (!this.snapshot) throw error('persistence_not_ready', 'Editor storage has not opened.');
      return new Map(this.snapshot.stores[store]);
    }

    get(store, key) { return this._serial(() => clone(this._records(store).get(key) ?? null)); }
    getAll(store) { return this._serial(() => Array.from(this._records(store).values(), clone)); }

    async _remove(fileId, version) {
      if (!fileId || !Number.isSafeInteger(version)) return;
      // Cleanup cannot turn an acknowledged domain save into a failure.
      try { await this.sdk.files.remove(fileId, {expectedVersion: version}); } catch (_) {}
    }

    async _accept(pending, version) {
      this.snapshot = pending.snapshot;
      this.pointer = pending.pointer;
      this.version = version;
      this.fileVersion = pending.file.version;
      this.pending = null;
      await this._remove(pending.previous?.fileId, pending.previousFileVersion);
    }

    async _resolvePending() {
      const pending = this.pending;
      const latest = await this.sdk.data.get(this.pointerKey);
      if (latest.value?.mutationId === pending.pointer.mutationId && latest.value?.hash === pending.pointer.hash) {
        await this._accept(pending, latest.version);
        return this;
      }
      if (latest.version !== pending.expectedVersion) {
        this.pending = null;
        await this._remove(pending.file.id, pending.file.version);
        throw error('version_conflict', 'Saved editor data changed. Reopen it before saving again.');
      }
      throw error('persistence_unknown', 'The last save is still unconfirmed. Check again before saving.');
    }

    applyBatch(records, deletes = [], clears = []) {
      return this._serial(async () => {
        if (this.pending) await this._resolvePending();
        const snapshot = clone(this.snapshot);
        const touched = new Set(records.concat(deletes).map(record => record.store).concat(clears));
        for (const store of touched) {
          const values = this._records(store);
          if (clears.includes(store)) values.clear();
          for (const record of records.filter(record => record.store === store)) values.set(String(record.key), clone(record.value));
          for (const record of deletes.filter(record => record.store === store)) values.delete(String(record.key));
          snapshot.stores[store] = Array.from(values);
        }
        const hash = await this.contract.sha256Ref(snapshot);
        if (hash === this.pointer?.hash) return;
        const mutationId = identity();
        const file = await this.sdk.files.put('shader-editor-store-' + mutationId + '.json', new Blob([JSON.stringify(snapshot)], {type: 'application/json'}));
        const pointer = {schema_version: 1, fileId: file.id, hash, mutationId};
        const pending = {snapshot, pointer, file, expectedVersion: this.version, previous: this.pointer, previousFileVersion: this.fileVersion};
        this.pending = pending;
        try {
          const saved = await this.sdk.data.set(this.pointerKey, pointer, {expectedVersion: this.version});
          await this._accept(pending, saved.version);
        } catch (failure) {
          // Explicit backend refusals did not commit. A lost response is different:
          // read the stable mutation identity rather than issuing another CAS write.
          if (['version_conflict', 'data_quota_exceeded', 'unauthorized', 'invalid_data', 'instance_closed'].includes(failure.code)) {
            this.pending = null;
            await this._remove(file.id, file.version);
            throw failure;
          }
          try { await this._resolvePending(); }
          catch (uncertain) {
            if (uncertain.code === 'version_conflict') throw uncertain;
            throw error('persistence_unknown', 'The save result is unknown. Check again before saving.');
          }
        }
      });
    }

    putMany(records) { return this.applyBatch(records); }
    delete(store, key) { return this.applyBatch([], [{store, key}]); }
    clear(store) { return this.applyBatch([], [], [store]); }
    close() { this.closed = true; }
  }

  return Object.freeze({AppsBackend, POINTER});
});
