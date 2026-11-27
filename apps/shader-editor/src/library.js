/* My Visuals through the Apps SDK: the works on this device (members), each read at a fixed package digest and shown
   in the shared picker as its own entry ('visual:' + visual_id). Without the SDK API, a granted access or the catalog
   helpers, the App works as before with only its packaged visuals. */
(() => {
  'use strict';
  // The host refuses these until the visitor allows My Visuals for this App; they are not errors to show.
  const OFF = new Set(['unsupported_capability', 'capability_required', 'unsupported_operation', 'not_supported']);
  const COVER_MAX = 512 * 1024, BATCH = 8, RETRIES = 6;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const dataUrl = blob => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
  });

  class VisualsLibrary {
    constructor({sdk, catalog}) {
      this.api = sdk?.visuals || null;
      this.catalog = catalog;
      this.supported = !!this.api && typeof catalog?.visualEntry === 'function' && typeof catalog?.setVisualEntries === 'function';
      this.off = !this.supported;
      this.write = false;
      this.rows = new Map();
      this.cache = new Map();
      this.loading = null;
      this.queue = Promise.resolve();
    }
    static isOff(error) { return OFF.has(error?.code); }
    // The host serves one My Visuals transfer per App at a time: requests go in order, and a refusal while another
    // transfer (such as a save) finishes is retried.
    call(method, ...args) {
      const run = async () => {
        for (let attempt = 0; ; attempt++) {
          try { return await this.api[method](...args); }
          catch (error) {
            if (error?.code !== 'transfer_conflict' || attempt >= RETRIES) throw error;
            await wait(100 * (attempt + 1));
          }
        }
      };
      const result = this.queue.then(run, run);
      this.queue = result.catch(() => {});
      return result;
    }
    // Read access and, for an App that declares readwrite, whether saving is allowed now.
    async info() {
      if (this.off) return {read: false, write: false};
      try {
        const info = await this.call('info');
        this.write = info?.write === true;
        return info;
      } catch (error) {
        if (VisualsLibrary.isOff(error)) { this.off = true; this.write = false; }
        throw error;
      }
    }
    row(visualId) { return this.rows.get(visualId) || null; }
    // Every member, in list order, read when the picker opens (never before the App's first frame). Works already read
    // at the same digest come from the cache; the rest arrive in batches (onProgress redraws an open picker). A work
    // that cannot be read here is left out; the others still show.
    refresh(onProgress) {
      if (this.off) return Promise.resolve(false);
      if (this.loading) return this.loading;
      this.loading = (async () => {
        const rows = [];
        let cursor;
        do {
          const page = await this.call('list', {scope: 'members', limit: 100, ...(cursor != null ? {cursor} : {})});
          rows.push(...(page?.items || []).filter(row => row && typeof row.visual_id === 'string'));
          cursor = page?.next_cursor;
        } while (cursor != null);
        this.rows = new Map(rows.map(row => [row.visual_id, row]));
        const items = [], keep = new Set();
        let fresh = 0;
        for (const row of rows) {
          const cached = row.package_digest && this.cache.has(row.visual_id + '/' + row.package_digest);
          try {
            const item = await this.open(row);
            items.push(item); keep.add(item.entry.visual_id + '/' + item.entry.package_digest);
          } catch (_) {}
          if (!cached && ++fresh % BATCH === 0) { this.catalog.setVisualEntries(items); onProgress?.(); }
        }
        for (const key of this.cache.keys()) if (!keep.has(key)) this.cache.delete(key);
        this.catalog.setVisualEntries(items);
        onProgress?.();
        return true;
      })().catch(error => {
        if (!VisualsLibrary.isOff(error)) throw error;
        this.off = true; this.write = false; this.rows.clear(); this.cache.clear(); this.catalog.setVisualEntries([]);
        onProgress?.();
        return false;
      }).finally(() => { this.loading = null; });
      return this.loading;
    }
    // One work at its exact digest, as a picker entry. The cover comes from the package; without one the definition's
    // packaged preview shows.
    async open(row) {
      const cached = row.package_digest && this.cache.get(row.visual_id + '/' + row.package_digest);
      if (cached) return cached;
      const work = await this.call('resolve', row.visual_id, row.package_digest || undefined);
      const fixed = {...row, title: row.title || work.title, package_digest: work.package_digest, thumbnail: await this.cover(row, work.package_digest)};
      const item = await this.catalog.visualEntry(work, fixed);
      this.cache.set(row.visual_id + '/' + work.package_digest, item);
      return item;
    }
    // One work by its ID at its current version, without listing the library (a cold start restoring the last work).
    async openId(visualId) {
      if (this.off) throw Object.assign(Error('My Visuals is not available.'), {code: 'unsupported_capability'});
      try {
        const row = await this.call('get', visualId);
        const item = await this.open({visual_id: visualId, package_digest: row.package_digest, title: row.title, cover_path: row.cover_path,
          updated_at: row.updated_at, origin: row.origin, row_version: row.row_version});
        this.put(item);
        return item;
      } catch (error) {
        if (VisualsLibrary.isOff(error)) { this.off = true; this.write = false; }
        throw error;
      }
    }
    async cover(row, digest) {
      if (typeof row.cover_path !== 'string' || !row.cover_path.startsWith('thumbnails/')) return '';
      try {
        let blob = await this.call('readEntry', row.visual_id, digest, row.cover_path);
        if (!(blob instanceof Blob) || blob.size > COVER_MAX) return '';
        if (!blob.type.startsWith('image/')) blob = blob.slice(0, blob.size, row.cover_path.endsWith('.png') ? 'image/png' : 'image/webp');
        const url = await dataUrl(blob);
        return /^data:image\//.test(url) ? url : '';
      } catch (_) { return ''; }
    }
    // Adds or replaces one work in the picker without listing the library again.
    put(item, row) {
      if (row) this.rows.set(row.visual_id, row);
      this.cache.set(item.entry.visual_id + '/' + item.entry.package_digest, item);
      this.catalog.setVisualEntries([item], false);
    }
  }
  window.VisualsLibrary = VisualsLibrary;
})();
