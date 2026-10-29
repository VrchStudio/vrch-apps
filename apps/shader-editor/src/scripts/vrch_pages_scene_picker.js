/* Shared Scene preset picker dialog for Image Settings V2 and Shader Editor V2. */
(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VrchScenePresetPicker = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root) {
  'use strict';

  const FAVORITES_KEY = 'vrch-scene:v1:favorites';
  const RECENTS_KEY = 'vrch-scene:v1:recents';
  const COLLECTION_KEY = 'vrch-scene:v1:last-collection';
  const GROUPS = Object.freeze([
    { category: 'Generate', id: 'generator', label: 'Generator' },
    { category: 'Filter', id: 'filter', label: 'Filter' },
    { category: 'Blend', id: 'mixer', label: 'Mixer' }
  ]);

  function categoryLabel(value) {
    const group = GROUPS.find((item) => item.category === value);
    return group ? group.label : String(value || '');
  }

  function resolveElement(value) {
    if (!value || typeof document === 'undefined') return null;
    return typeof value === 'string' ? document.getElementById(value) : value;
  }

  function readList(key, storage) {
    try {
      const value = JSON.parse((storage || root.localStorage).getItem(key) || '[]');
      return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  }

  function writeList(key, value, storage) {
    try { (storage || root.localStorage).setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  function normalize(value) {
    return String(value || '').normalize('NFKD').toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function sourceLabel(definition) {
    if ((definition && definition.analysis_requirements || []).length) return 'Tracked source';
    const count = Number(definition && definition.runtime && definition.runtime.max_sources) || 0;
    return count <= 0 ? 'No image' : count === 1 ? 'Current image' : 'Two images';
  }

  function hasAudio(definition) {
    return (definition && definition.signals || []).some((signal) => String(signal.id || '').startsWith('audio.'));
  }

  function capabilities(definition) {
    const analysisKinds = new Set((definition && definition.analysis_requirements || [])
      .map((requirement) => String(requirement && requirement.kind || '').trim().toLowerCase())
      .filter(Boolean));
    return {
      camera: (Number(definition && definition.runtime && definition.runtime.max_sources) || 0) > 0,
      microphone: hasAudio(definition),
      hand: analysisKinds.has('hand'),
      face: analysisKinds.has('face'),
      body: analysisKinds.has('pose') || analysisKinds.has('body')
    };
  }

  function capabilityLabels(definition) {
    const flags = capabilities(definition);
    return [
      flags.camera ? 'Supports camera input' : '',
      flags.microphone ? 'Responds to microphone' : '',
      flags.hand ? 'Hand tracking' : '',
      flags.face ? 'Face tracking' : '',
      flags.body ? 'Body tracking' : ''
    ].filter(Boolean);
  }

  function capabilityIcons(definition) {
    const flags = capabilities(definition);
    const group = document.createElement('span');
    group.className = 'scene-capability-icons';
    const add = (kind, iconClass, label) => {
      const indicator = document.createElement('span');
      indicator.className = 'scene-capability-icon scene-capability-icon--' + kind;
      indicator.setAttribute('role', 'img');
      indicator.setAttribute('aria-label', label);
      indicator.title = label;
      const icon = document.createElement('i');
      icon.className = 'fas ' + iconClass;
      icon.setAttribute('aria-hidden', 'true');
      indicator.appendChild(icon);
      group.appendChild(indicator);
    };
    if (flags.camera) add('camera', 'fa-camera', 'Supports camera input');
    if (flags.microphone) add('microphone', 'fa-microphone', 'Responds to microphone');
    if (flags.hand) add('hand', 'fa-hand', 'Hand tracking');
    if (flags.face) add('face', 'fa-face-smile', 'Face tracking');
    if (flags.body) add('body', 'fa-person', 'Body tracking');
    return group;
  }

  function renderCapabilityMeta(element, labels, definition) {
    if (!element) return;
    element.replaceChildren();
    const copy = document.createElement('span');
    copy.className = 'scene-capability-copy';
    copy.textContent = (labels || []).filter(Boolean).join(' · ');
    if (copy.textContent) element.appendChild(copy);
    const icons = capabilityIcons(definition);
    if (icons.childElementCount) element.appendChild(icons);
  }

  function thumbnailUrl(item, cacheToken) {
    const definition = item && item.definition || item;
    const entry = item && item.entry || {};
    const ref = String(entry.thumbnail_ref || definition && definition.catalog && definition.catalog.thumbnail_ref || '');
    if (!/^(?:scenes\/|data:image\/)/.test(ref)) return '';
    return ref.startsWith('data:') ? ref : ref + '?v=' + encodeURIComponent(cacheToken || '');
  }

  function filterText(item) {
    const definition = item.definition || {};
    return normalize([
      item.entry && item.entry.display_name,
      definition.title,
      definition.scene_id,
      definition.description,
      definition.catalog && definition.catalog.category,
      ...((definition.catalog && definition.catalog.tags) || [])
    ].join(' '));
  }

  class ScenePresetPicker {
    constructor(options = {}) {
      if (!options.catalog) throw new Error('ScenePresetPicker requires a PresetCatalog.');
      this.catalog = options.catalog;
      this.selection = options.selection || root.VrchSceneSelection;
      this.collectionId = 'curated';
      this.trigger = resolveElement(options.trigger || options.triggerId);
      this.display = resolveElement(options.display || options.displayId) || this.trigger;
      this.options = Object.assign({
        id: 'scenePresetPicker',
        source: 'scene-picker',
        title: 'Choose a Visual',
        primaryLabel: 'Use',
        progressLabel: 'Working...',
        emptyTitle: 'Choose a visual',
        emptyMeta: 'None selected',
        currentLabel: 'CURRENT',
        triggerEmptyLabel: 'Choose',
        triggerCurrentLabel: 'Change',
        favoriteLongPressMs: 550,
        favoritesStorageKey: FAVORITES_KEY,
        recentsStorageKey: RECENTS_KEY,
        recentLimit: 6,
        onConfirm: null,
        onClear: null,
        onDelete: null,
        onOpen: null,
        onClose: null,
        getCurrentHash: null
      }, options);
      this.currentHash = null;
      this.pendingHash = null;
      this.filterQuery = '';
      this.searching = false;
      this.browseState = null;
      this.busy = false;
      this.openGeneration = 0;
      this.remote = options.hosted ? root.VrchScenePickerBridge.createClient(this) : null;
      this.overlay = null;
      this.controller = null;
      this.mirror = null;
      this.elements = {};
      this.favoriteHashes = readList(this.options.favoritesStorageKey, this.options.storage);
      this.recentHashes = readList(this.options.recentsStorageKey, this.options.storage);
      this._boundStorage = (event) => this._onStorage(event);
      this._boundVisibility = () => this._onVisibility();
      this._unbindCatalog = this.catalog.on('loaded', () => this.refresh());
      if (this.trigger) {
        this.trigger.setAttribute('aria-haspopup', 'dialog');
        this.trigger.setAttribute('aria-expanded', 'false');
        this._boundTrigger = () => this.open();
        this.trigger.addEventListener('click', this._boundTrigger);
      }
      root.addEventListener('storage', this._boundStorage);
      document.addEventListener('visibilitychange', this._boundVisibility);
      this.syncTrigger();
    }

    _currentHash() {
      if (typeof this.options.getCurrentHash === 'function') {
        const value = this.options.getCurrentHash();
        if (value) {
          const item = this.catalog.get(String(value));
          return item ? this.catalog.itemKey(item) : String(value);
        }
      }
      const item = this.currentHash && this.catalog.get(this.currentHash);
      return item ? this.catalog.itemKey(item) : this.currentHash;
    }

    _allItems() {
      const ids = new Set(this.selection.items.map((item) => item.scene_id));
      return this.catalog.list({ pickerOnly: true }).filter((item) =>
        item.entry.local === true || ids.has(item.definition.scene_id));
    }

    _selection(item) {
      if (!item || item.entry.local === true) return null;
      return this.selection.items.find((entry) => entry.scene_id === item.definition.scene_id) || null;
    }

    _collection(item) {
      const entry = this._selection(item);
      return entry ? entry.collection : 'library';
    }

    _family(item) {
      if (!this._selection(item)) return null;
      return this.selection.families.find((family) => family.variants.some((variant) => variant.scene_id === item.definition.scene_id)) || null;
    }

    _key(item) {
      return item ? this.catalog.itemKey(item) : '';
    }

    _title(item) {
      const entry = this._selection(item);
      return item && (item.entry.display_name || entry && entry.label || item.definition.title) || '';
    }

    _thumbnail(item) {
      const entry = this._selection(item);
      return entry && entry.thumbnail
        ? entry.thumbnail + '?v=' + encodeURIComponent(this.catalog.cacheToken)
        : thumbnailUrl(item, this.catalog.cacheToken);
    }

    _item(key) {
      return key ? this.catalog.get(String(key)) : null;
    }

    _ensureDialog() {
      if (this.overlay) return;
      const overlay = document.createElement('div');
      overlay.id = this.options.id + 'Overlay';
      overlay.className = 'ui-modal hidden scene-picker-modal';
      if (root.document.body.classList.contains('live-console-page')) overlay.classList.add('ui-motion-window');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.setAttribute('aria-label', this.options.title);
      overlay.setAttribute('tabindex', '-1');
      overlay.innerHTML = `
        <div class="ui-modal__dialog scene-picker-dialog">
          <div class="scene-picker-header">
            <nav class="ui-tabs ui-tabs--navigation ui-tabs--edge ui-tabs--equal scene-picker-collections" data-role="collections" aria-label="Visual collections"></nav>
            <button type="button" class="ui-icon-action" data-role="search-open" aria-label="Search all visuals" title="Search all visuals" aria-expanded="false"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></button>
            <div class="scene-picker-search" data-role="search" role="search" aria-label="All visuals" hidden>
              <button type="button" class="ui-icon-action" data-role="search-back" aria-label="Back to categories" title="Back to categories"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button>
              <input type="search" class="ui-input scene-picker-filter" data-role="filter" placeholder="Search all visuals..." autocomplete="off" aria-label="Search all visuals">
              <span class="visually-hidden" data-role="count" aria-live="polite"></span>
              <button type="button" class="ui-icon-action" data-role="search-clear" aria-label="Clear search" title="Clear search" hidden><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
            </div>
          </div>
          <div class="scene-picker-layout">
            <section class="scene-picker-preview-panel" aria-label="Selected visual preview">
              <div class="scene-picker-preview" data-role="preview">
                <img class="scene-picker-preview__thumbnail" data-role="preview-thumbnail" alt="">
                <span class="ui-tag scene-picker-preview__status" data-role="preview-status"><span class="ui-tag__bracket">[</span><span class="ui-tag__text">PREVIEW · WAITING</span><span class="ui-tag__bracket">]</span></span>
              </div>
              <div class="scene-picker-preview__copy">
                <h3 data-role="preview-title">Choose a visual</h3>
                <p class="scene-picker-preview__meta" data-role="preview-meta"></p>
                <p class="scene-picker-preview__description" data-role="preview-description"></p>
                <div class="ui-grid-btn-group scene-picker-variants" data-role="variants" aria-label="Visual variants" hidden></div>
              </div>
            </section>
            <div class="scene-picker-catalog" data-role="catalog" aria-label="Visual presets"></div>
          </div>
          <div class="ui-dialog__actions scene-picker-actions">
            <span class="scene-picker-feedback" data-role="feedback" aria-live="polite"></span>
            <button type="button" class="ui-btn--md ui-btn--ghost" data-role="cancel">Cancel</button>
            <button type="button" class="ui-btn--md ui-btn--ghost" data-role="clear" hidden>Clear Visual</button>
            <button type="button" class="ui-btn--md is-confirm scene-picker-confirm" data-role="confirm" disabled></button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      this.overlay = overlay;
      this.elements = {
        filter: overlay.querySelector('[data-role="filter"]'),
        count: overlay.querySelector('[data-role="count"]'),
        catalog: overlay.querySelector('[data-role="catalog"]'),
        collections: overlay.querySelector('[data-role="collections"]'),
        variants: overlay.querySelector('[data-role="variants"]'),
        preview: overlay.querySelector('[data-role="preview"]'),
        previewThumbnail: overlay.querySelector('[data-role="preview-thumbnail"]'),
        previewStatus: overlay.querySelector('[data-role="preview-status"]'),
        previewTitle: overlay.querySelector('[data-role="preview-title"]'),
        previewMeta: overlay.querySelector('[data-role="preview-meta"]'),
        previewDescription: overlay.querySelector('[data-role="preview-description"]'),
        feedback: overlay.querySelector('[data-role="feedback"]'),
        cancel: overlay.querySelector('[data-role="cancel"]'),
        clear: overlay.querySelector('[data-role="clear"]'),
        confirm: overlay.querySelector('[data-role="confirm"]')
      };
      this.searchControls = {
        open: overlay.querySelector('[data-role="search-open"]'),
        back: overlay.querySelector('[data-role="search-back"]'),
        clear: overlay.querySelector('[data-role="search-clear"]'),
        search: overlay.querySelector('[data-role="search"]')
      };
      this.searchControls.search.id = this.options.id + 'Search';
      this.searchControls.open.setAttribute('aria-controls', this.searchControls.search.id);
      this.searchControls.open.addEventListener('click', () => this.enterSearch());
      this.searchControls.back.addEventListener('click', () => this.leaveSearch());
      this.searchControls.clear.addEventListener('click', () => {
        if (this.busy) return;
        this.filterQuery = '';
        this.elements.filter.value = '';
        this._renderCatalog();
        this.elements.catalog.scrollTop = 0;
        this.elements.filter.focus({ preventScroll: true });
      });
      // First Escape returns to browsing; sibling confirmation dialogs own theirs.
      overlay.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !this.searching || this.busy) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.leaveSearch();
      }, true);
      this.elements.confirm.textContent = this.options.primaryLabel;
      this.selection.collections.forEach((collection) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ui-tab';
        button.dataset.collection = collection.id;
        button.textContent = collection.label;
        button.title = collection.description;
        button.addEventListener('click', () => {
          if (this.busy) return;
          this.collectionId = collection.id;
          try { (this.options.storage || root.localStorage).setItem(COLLECTION_KEY, collection.id); } catch (_) {}
          this.filterQuery = '';
          this.elements.filter.value = '';
          this._renderCatalog();
          this.elements.catalog.scrollTop = 0;
        });
        this.elements.collections.appendChild(button);
      });
      this.controller = root.VrchDialogs && typeof root.VrchDialogs.createController === 'function'
        ? root.VrchDialogs.createController({
            overlay,
            dismissResult: 'cancel',
            onClose: (result) => this._afterClose(result)
          })
        : null;
      this.elements.filter.addEventListener('input', () => {
        this.filterQuery = this.elements.filter.value;
        this._renderCatalog();
        this.elements.catalog.scrollTop = 0;
      });
      this.elements.cancel.addEventListener('click', () => this.close('cancel'));
      this.elements.clear.addEventListener('click', () => this._confirm(true));
      this.elements.confirm.addEventListener('click', () => this._confirm());
      overlay.addEventListener('keydown', (event) => {
        // Escape closes this dialog without also restoring a fullscreen Console pane.
        if (event.key === 'Escape') event.stopPropagation();
        if (event.key !== 'Tab') return;
        const controls = Array.from(overlay.querySelectorAll('button:not(:disabled), input:not(:disabled)')).filter((element) => element.getClientRects().length);
        const index = controls.indexOf(document.activeElement);
        if (!controls.length || index >= 0 && (event.shiftKey ? index > 0 : index < controls.length - 1)) return;
        event.preventDefault();
        controls[event.shiftKey ? controls.length - 1 : 0].focus();
      });
      this.compactMedia = root.matchMedia('(max-width: 760px) and (max-height: 640px)');
      this._boundCompactChange = () => {
        const focusHidden = this.isOpen() && this.elements.preview.closest('section').contains(document.activeElement);
        if (this.isOpen()) {
          if (focusHidden || document.activeElement === document.body) {
            const target = this.searching ? this.elements.filter : this.elements.collections.querySelector('button');
            target.focus({ preventScroll: true });
          }
          this._renderPreview();
        }
      };
      this.compactMedia.addEventListener('change', this._boundCompactChange);
    }

    _syncSearchControls() {
      if (!this.searchControls) return;
      const {open, back, clear, search} = this.searchControls;
      this.elements.collections.hidden = !!this.searching;
      open.hidden = !!this.searching;
      open.setAttribute('aria-expanded', String(!!this.searching));
      search.hidden = !this.searching;
      clear.hidden = !this.filterQuery;
      for (const control of [open, back, clear]) control.disabled = this.busy;
    }

    enterSearch() {
      if (this.busy || this.searching) return;
      this.browseState = { collection: this.collectionId, scrollTop: this.elements.catalog.scrollTop };
      this.searching = true;
      this.filterQuery = '';
      this.elements.filter.value = '';
      this._renderCatalog();
      this.elements.catalog.scrollTop = 0;
      this.elements.filter.focus({ preventScroll: true });
    }

    leaveSearch() {
      if (this.busy || !this.searching) return;
      this.searching = false;
      this.filterQuery = '';
      this.elements.filter.value = '';
      this.collectionId = this.browseState.collection;
      this._renderCatalog();
      this.elements.catalog.scrollTop = this.browseState.scrollTop;
      this.searchControls.open.focus({ preventScroll: true });
    }

    _setPreviewState(state) {
      if (!this.elements.previewStatus) return;
      const text = state === 'visible' ? 'PREVIEW · LIVE' : state === 'loading' ? 'PREVIEW · LOADING' : state === 'unavailable' ? 'PREVIEW · UNAVAILABLE' : 'PREVIEW · WAITING';
      const label = this.elements.previewStatus.querySelector('.ui-tag__text');
      label.textContent = text;
      this.elements.previewStatus.classList.toggle('is-ok', state === 'visible');
      this.elements.previewStatus.classList.toggle('is-warn', state === 'unavailable');
      this.elements.preview.classList.toggle('has-live-preview', state === 'visible');
    }

    _ensureMirror() {
      if (this.mirror) return this.mirror;
      if (!root.VrchSceneMirror || typeof root.VrchSceneMirror.SceneMirror !== 'function') return null;
      try {
        this.mirror = new root.VrchSceneMirror.SceneMirror({
          ...(this.options.mirrorOptions || {}),
          container: this.elements.preview,
          onState: (state) => this._setPreviewState(state)
        });
      } catch (_) {
        this._setPreviewState('unavailable');
      }
      return this.mirror;
    }

    _matches(item) {
      const terms = normalize(this.filterQuery).split(' ').filter(Boolean);
      if (!terms.length) return true;
      const entry = this._selection(item);
      const family = this._family(item);
      const value = filterText(item) + ' ' + normalize([entry && entry.label, entry && entry.description, family && family.label].join(' '));
      return terms.every((term) => value.includes(term));
    }

    _orderedByHashes(hashes, byHash) {
      const seen = new Set();
      return hashes.map((hash) => byHash.get(hash) || this._item(hash)).filter((item) => {
        const key = this._key(item);
        return item && key && !seen.has(key) && seen.add(key);
      });
    }

    getFavorites() {
      return this._orderedByHashes(readList(this.options.favoritesStorageKey, this.options.storage), new Map(this._allItems().map(item => [this._key(item), item])));
    }

    _groupedItems() {
      if (this.searching) {
        const items = [...new Map(this._allItems().map(item => [this._key(item), item])).values()];
        const groups = this.selection.collections.map(collection => {
          const matches = items.filter(item => this._collection(item) === collection.id && this._matches(item));
          return {
            id: collection.id === 'library' ? 'my-visuals' : collection.id,
            title: collection.id === 'library' ? 'My Visuals' : collection.label,
            items: matches,
            cards: matches.map(item => ({item, family: null}))
          };
        }).filter(group => group.items.length);
        return {items, groups};
      }
      const items = this._allItems();
      const byHash = new Map(items.map((item) => [this._key(item), item]));
      let groups = this.collectionId === 'library' ? [
        { id: 'favorites', title: 'Favorites', items: this.getFavorites() },
        {
          id: 'my-visuals',
          title: 'My Visuals',
          items: items.filter((item) => item.entry.user_saved === true).sort((a, b) => String(b.entry.updated_at || '').localeCompare(String(a.entry.updated_at || '')))
        },
        { id: 'recent', title: 'Recent', items: this._orderedByHashes(this.recentHashes, byHash) }
      ] : [];
      if (this.collectionId !== 'library') {
        const collectionItems = this.selection.items.filter((entry) => entry.collection === this.collectionId)
          .map((entry) => items.find((item) => item.entry.local !== true && item.definition.scene_id === entry.scene_id)).filter(Boolean);
        groups = this.collectionId === 'demos'
          ? this.selection.groups.map((group) => ({ id: group.id, title: group.label, items: collectionItems.filter((item) => this._selection(item).group === group.id) }))
          : [{ id: this.collectionId, title: '', items: collectionItems }];
      }
      groups = groups.map((group) => {
        const matches = group.items.filter((item) => this._matches(item));
        const families = new Set();
        const cards = [];
        matches.forEach((item) => {
          const family = this.collectionId === 'library' ? null : this._family(item);
          if (family && families.has(family.id)) return;
          const variants = family ? matches.filter((candidate) => this._family(candidate) === family) : [item];
          const representative = variants.find((candidate) => this._key(candidate) === this.pendingHash)
            || variants.find((candidate) => this._key(candidate) === this.currentHash) || item;
          if (family) families.add(family.id);
          cards.push({ item: representative, family });
        });
        return Object.assign({}, group, { items: matches, cards });
      }).filter((group) => group.items.length);
      return { items, groups };
    }

    _renderCatalog() {
      if (!this.elements.catalog) return;
      const grouped = this._groupedItems();
      const collection = this.selection.collections.find((entry) => entry.id === this.collectionId);
      this.elements.collections.querySelectorAll('button').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.collection === this.collectionId));
        button.classList.toggle('is-active', button.dataset.collection === this.collectionId);
      });
      this.elements.catalog.replaceChildren();
      const uniqueMatches = new Set();
      grouped.groups.forEach((group) => {
        const section = document.createElement('section');
        section.className = 'scene-picker-group';
        section.dataset.group = group.id;
        const header = document.createElement('div');
        header.className = 'scene-picker-group__header';
        const title = document.createElement('h3');
        title.textContent = group.title;
        const count = document.createElement('span');
        count.textContent = '(' + String(group.items.length) + ')';
        header.append(title, count);
        const grid = document.createElement('div');
        grid.className = 'scene-picker-grid';
        group.cards.forEach(({ item, family }) => {
          uniqueMatches.add(family ? 'family:' + family.id : this._key(item));
          grid.appendChild(this._createCard(item, { family, deletable: group.id === 'my-visuals' }));
        });
        if (group.title) section.appendChild(header);
        section.appendChild(grid);
        this.elements.catalog.appendChild(section);
      });
      if (!grouped.groups.length) {
        const empty = document.createElement('div');
        empty.className = 'scene-empty-state';
        empty.textContent = this.filterQuery ? 'No matching visuals.' : collection.empty;
        this.elements.catalog.appendChild(empty);
      }
      const hasFamilies = grouped.groups.some((group) => group.cards.some((card) => card.family));
      this.elements.count.textContent = uniqueMatches.size + (hasFamilies ? ' choices' : ' visual' + (uniqueMatches.size === 1 ? '' : 's'));
      this._syncCardState();
      this._syncInteractiveState();
    }

    _createCard(item, options = {}) {
      const definition = item.definition;
      const hash = this._key(item);
      const titleText = this._title(item);
      const wrapper = document.createElement('article');
      wrapper.className = 'scene-picker-card';
      wrapper.dataset.sceneKey = hash;
      if (options.family) wrapper.dataset.family = options.family.id;
      wrapper.classList.toggle('is-pending', hash === this.pendingHash);
      wrapper.classList.toggle('is-current', hash === this.currentHash);
      wrapper.classList.toggle('is-favorite', this.favoriteHashes.includes(hash));

      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'scene-picker-card__select';
      select.dataset.scenePickerSelect = hash;
      select.setAttribute('aria-pressed', String(hash === this.pendingHash));
      const capabilityDescription = capabilityLabels(definition);
      select.setAttribute('aria-label', ['Select ' + titleText].concat(capabilityDescription).join('. '));
      const media = document.createElement('span');
      media.className = 'scene-picker-card__media';
      media.classList.toggle('scene-picker-card__media--contain', this._selection(item)?.thumbnail_fit === 'contain');
      const url = this._thumbnail(item);
      if (url) {
        const image = document.createElement('img');
        image.className = 'scene-picker-card__thumbnail';
        image.src = url;
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.addEventListener('error', () => image.remove(), { once: true });
        media.appendChild(image);
      }
      const current = document.createElement('span');
      current.className = 'scene-picker-card__current';
      current.textContent = this.options.currentLabel;
      current.hidden = hash !== this.currentHash;
      media.appendChild(current);
      select.appendChild(media);
      const copy = document.createElement('span');
      copy.className = 'scene-picker-card__copy';
      const name = document.createElement('span');
      name.className = 'scene-picker-card__name';
      name.textContent = options.family ? options.family.label : titleText;
      const meta = document.createElement('span');
      meta.className = 'scene-picker-card__meta';
      renderCapabilityMeta(meta, [options.family ? options.family.variants.length + ' variants' : sourceLabel(definition)], definition);
      copy.append(name, meta);
      select.appendChild(copy);

      const favorite = document.createElement('button');
      favorite.type = 'button';
      favorite.className = 'scene-picker-card__favorite';
      favorite.dataset.scenePickerFavorite = hash;
      favorite.setAttribute('aria-pressed', String(this.favoriteHashes.includes(hash)));
      favorite.setAttribute('aria-label', (this.favoriteHashes.includes(hash) ? 'Remove from favorites: ' : 'Add to favorites: ') + titleText);
      favorite.title = this.favoriteHashes.includes(hash) ? 'Remove from favorites' : 'Add to favorites';
      favorite.textContent = this.favoriteHashes.includes(hash) ? '★' : '☆';
      favorite.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._toggleFavorite(hash, titleText);
      });
      const deletable = options.deletable === true && item.entry.user_saved === true && typeof this.options.onDelete === 'function';
      const deleteButton = document.createElement('button');
      if (deletable) {
        deleteButton.type = 'button';
        deleteButton.className = 'scene-picker-card__delete';
        deleteButton.dataset.scenePickerDelete = hash;
        deleteButton.setAttribute('aria-label', 'Delete visual: ' + titleText);
        deleteButton.title = 'Delete visual';
        deleteButton.innerHTML = '<i class="fas fa-trash-can" aria-hidden="true"></i>';
        deleteButton.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this._delete(item);
        });
      }
      select.addEventListener('click', () => {
        if (this.busy) return;
        this._select(hash);
      });
      select.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._select(hash);
        void this._confirm();
      });
      select.addEventListener('keydown', (event) => this._moveCardFocus(event, select));
      this._attachFavoriteLongPress(select, hash, titleText);
      wrapper.append(select, favorite);
      if (deletable) wrapper.appendChild(deleteButton);
      return wrapper;
    }

    _moveCardFocus(event, button) {
      if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;
      const buttons = Array.from(this.elements.catalog.querySelectorAll('[data-scene-picker-select]')).filter((item) => !item.disabled && item.offsetParent !== null);
      const index = buttons.indexOf(button);
      if (index < 0 || buttons.length < 2) return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length].focus();
    }

    _attachFavoriteLongPress(button, hash, title) {
      let timer = 0;
      let startX = 0;
      let startY = 0;
      let suppressUntil = 0;
      const clear = () => {
        if (timer) root.clearTimeout(timer);
        timer = 0;
        button.classList.remove('is-hold-pending');
      };
      button.addEventListener('pointerdown', (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        clear();
        startX = Number(event.clientX) || 0;
        startY = Number(event.clientY) || 0;
        button.classList.add('is-hold-pending');
        timer = root.setTimeout(() => {
          timer = 0;
          suppressUntil = Date.now() + 800;
          button.classList.remove('is-hold-pending');
          this._toggleFavorite(hash, title);
        }, Math.max(300, Number(this.options.favoriteLongPressMs) || 550));
      });
      button.addEventListener('pointermove', (event) => {
        if (!timer) return;
        const dx = (Number(event.clientX) || 0) - startX;
        const dy = (Number(event.clientY) || 0) - startY;
        if ((dx * dx) + (dy * dy) > 100) clear();
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => button.addEventListener(type, clear));
      button.addEventListener('click', (event) => {
        if (Date.now() >= suppressUntil) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
      button.addEventListener('contextmenu', (event) => event.preventDefault());
    }

    _toggleFavorite(hash, title) {
      const favorite = this.favoriteHashes.includes(hash);
      this.favoriteHashes = favorite ? this.favoriteHashes.filter((item) => item !== hash) : [hash].concat(this.favoriteHashes.filter((item) => item !== hash));
      writeList(this.options.favoritesStorageKey, this.favoriteHashes, this.options.storage);
      this._renderCatalog();
    }

    async _delete(item) {
      const generation = this.openGeneration;
      if (this.busy || !item || item.entry.user_saved !== true || typeof this.options.onDelete !== 'function') return;
      const hash = this._key(item);
      const title = this._title(item);
      const confirmed = root.VrchDialogs && typeof root.VrchDialogs.confirm === 'function'
        ? await root.VrchDialogs.confirm('Delete Visual', 'Delete "' + title + '" from My Visuals?', {
            primaryLabel: 'Delete',
            secondaryLabel: 'Cancel',
            primaryClass: 'danger',
            secondaryClass: 'ghost',
            focus: 'secondaryBtn',
            dismissResult: false
          })
        : root.confirm('Delete "' + title + '" from My Visuals?');
      if (!confirmed || this.busy || generation !== this.openGeneration) return;
      this.busy = true;
      this._feedback('Deleting...');
      this._syncInteractiveState();
      try {
        const result = await this.options.onDelete(item);
        if (generation !== this.openGeneration) return;
        if (result === false) throw new Error('Visual was not deleted.');
        this.favoriteHashes = this.favoriteHashes.filter((value) => value !== hash);
        this.recentHashes = this.recentHashes.filter((value) => value !== hash);
        writeList(this.options.favoritesStorageKey, this.favoriteHashes, this.options.storage);
        writeList(this.options.recentsStorageKey, this.recentHashes, this.options.storage);
        if (this.pendingHash === hash) {
          const items = this._allItems();
          const current = this._item(this._currentHash());
          this.pendingHash = current ? this._key(current) : items[0] ? this._key(items[0]) : null;
        }
        this.currentHash = this._currentHash();
        this.busy = false;
        this._feedback('Deleted ' + title + '.');
        this.syncTrigger();
        this._renderCatalog();
        this._renderPreview();
      } catch (error) {
        if (generation !== this.openGeneration) return;
        this.busy = false;
        this._feedback(error && (error.userMessage || error.message) || 'Could not delete this visual.', 'warn');
        this._syncInteractiveState();
      }
    }

    _select(hash) {
      if (this.busy || !this._item(hash)) return;
      if (this.searching) this._endTyping();
      this.pendingHash = hash;
      this._feedback('');
      this._syncCardState();
      this._syncInteractiveState();
      this._renderPreview();
    }

    // Choosing a search result ends typing: release the search field and ask
    // the host's on-screen keyboard to close.
    _endTyping() {
      const filter = this.elements.filter;
      if (!filter) return;
      if (filter.ownerDocument.activeElement === filter) filter.blur();
      filter.dispatchEvent(new CustomEvent('vrch-virtual-keyboard-dismiss', { bubbles: true, composed: true }));
    }

    _syncCardState() {
      if (!this.elements.catalog) return;
      this.elements.catalog.querySelectorAll('.scene-picker-card[data-scene-key]').forEach((wrapper) => {
        const hash = String(wrapper.dataset.sceneKey || '');
        const item = this._item(hash);
        const title = this._title(item);
        const family = wrapper.dataset.family && this._family(item);
        const contains = (key) => key === hash || family && this._family(this._item(key)) === family;
        const pending = !!contains(this.pendingHash);
        const current = !!contains(this.currentHash);
        const favorite = this.favoriteHashes.includes(hash);
        if (wrapper.classList.contains('is-pending') !== pending) wrapper.classList.toggle('is-pending', pending);
        if (wrapper.classList.contains('is-current') !== current) wrapper.classList.toggle('is-current', current);
        if (wrapper.classList.contains('is-favorite') !== favorite) wrapper.classList.toggle('is-favorite', favorite);
        const select = wrapper.querySelector('[data-scene-picker-select]');
        if (select && select.getAttribute('aria-pressed') !== String(pending)) select.setAttribute('aria-pressed', String(pending));
        const currentLabel = wrapper.querySelector('.scene-picker-card__current');
        if (currentLabel && currentLabel.hidden !== !current) currentLabel.hidden = !current;
        const favoriteButton = wrapper.querySelector('[data-scene-picker-favorite]');
        if (favoriteButton) {
          const pressed = String(favorite);
          const label = (favorite ? 'Remove from favorites: ' : 'Add to favorites: ') + title;
          const tooltip = favorite ? 'Remove from favorites' : 'Add to favorites';
          const glyph = favorite ? '★' : '☆';
          if (favoriteButton.getAttribute('aria-pressed') !== pressed) favoriteButton.setAttribute('aria-pressed', pressed);
          if (favoriteButton.getAttribute('aria-label') !== label) favoriteButton.setAttribute('aria-label', label);
          if (favoriteButton.title !== tooltip) favoriteButton.title = tooltip;
          if (favoriteButton.textContent !== glyph) favoriteButton.textContent = glyph;
        }
      });
    }

    _renderPreview() {
      const item = this._item(this.pendingHash);
      const focusedVariant = this.elements.variants.contains(document.activeElement) && document.activeElement.dataset.variant;
      this.elements.variants.replaceChildren();
      const family = this._family(item);
      this.elements.variants.hidden = !family;
      if (family) family.variants.forEach((variant) => {
        const target = this._allItems().find((candidate) => candidate.entry.local !== true && candidate.definition.scene_id === variant.scene_id);
        if (!target) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ui-btn--sm';
        button.dataset.variant = variant.scene_id;
        const isCurrent = this._key(target) === this.currentHash;
        button.textContent = variant.label;
        button.title = isCurrent ? this.options.currentLabel : '';
        button.setAttribute('aria-current', String(isCurrent));
        button.setAttribute('aria-label', variant.label + (isCurrent ? ', ' + this.options.currentLabel : ''));
        button.setAttribute('aria-pressed', String(this._key(target) === this.pendingHash));
        button.addEventListener('click', () => {
          this._select(this._key(target));
          this._renderCatalog();
        });
        this.elements.variants.appendChild(button);
        if (focusedVariant === variant.scene_id) button.focus({ preventScroll: true });
      });
      if (!item) {
        this.elements.previewTitle.textContent = 'Choose a visual';
        this.elements.previewMeta.textContent = '';
        this.elements.previewDescription.textContent = '';
        this.elements.previewThumbnail.removeAttribute('src');
        if (this.mirror) this.mirror.hide();
        this._setPreviewState('waiting');
        return;
      }
      const definition = item.definition;
      const entry = this._selection(item);
      const collection = this.selection.collections.find((value) => value.id === this._collection(item));
      this.elements.previewTitle.textContent = this._title(item);
      renderCapabilityMeta(this.elements.previewMeta, [entry && entry.status || collection.label, sourceLabel(definition)], definition);
      this.elements.previewDescription.textContent = entry && entry.description || definition.description;
      const url = this._thumbnail(item);
      if (url) this.elements.previewThumbnail.src = url;
      else this.elements.previewThumbnail.removeAttribute('src');
      const mirror = this._ensureMirror();
      if (!mirror || document.hidden) {
        this._setPreviewState(mirror ? 'waiting' : 'unavailable');
        return;
      }
      try {
        mirror.show(definition, this.catalog.makeInstance(this.pendingHash), item.entry.trusted === true);
      } catch (_) {
        this._setPreviewState('unavailable');
      }
    }

    _feedback(text, tone) {
      if (!this.elements.feedback) return;
      this.elements.feedback.textContent = text || '';
      this.elements.feedback.classList.toggle('is-warn', tone === 'warn');
    }

    _syncInteractiveState() {
      if (!this.overlay) return;
      this.elements.filter.disabled = this.busy;
      this.elements.cancel.disabled = this.busy;
      this.elements.clear.hidden = typeof this.options.onClear !== 'function';
      this.elements.clear.disabled = this.busy || !this._currentHash();
      this.elements.confirm.disabled = this.busy || !this._item(this.pendingHash);
      this.elements.confirm.textContent = this.busy ? this.options.progressLabel : this.options.primaryLabel;
      this.elements.catalog.querySelectorAll('button').forEach((button) => { button.disabled = this.busy; });
      this.elements.collections.querySelectorAll('button').forEach((button) => { button.disabled = this.busy; });
      this.elements.variants.querySelectorAll('button').forEach((button) => { button.disabled = this.busy; });
      this.overlay.classList.toggle('is-busy', this.busy);
      this._syncSearchControls();
    }

    async _confirm(clear = false) {
      const generation = this.openGeneration;
      const item = this._item(this.pendingHash);
      if (this.busy || (clear ? typeof this.options.onClear !== 'function' || !this._currentHash() : !item)) return;
      this.busy = true;
      this._feedback(this.options.progressLabel);
      this._syncInteractiveState();
      try {
        const result = clear ? await this.options.onClear()
          : typeof this.options.onConfirm === 'function' ? await this.options.onConfirm(item) : true;
        if (generation !== this.openGeneration) return;
        if (result === false) throw new Error(clear ? 'Visual could not be turned off.' : 'Visual was not loaded.');
        const hash = clear ? null : this.remember(item);
        this.currentHash = hash;
        if (!clear) this.catalog.select(hash, this.options.source);
        this.syncTrigger();
        this._syncCardState();
        this.busy = false;
        this.close('confirmed');
      } catch (error) {
        if (generation !== this.openGeneration) return;
        this.busy = false;
        this._feedback(error && (error.userMessage || error.message) || 'Could not load this visual.', 'warn');
        this._syncInteractiveState();
      }
    }

    _afterClose(result) {
      if (this.overlay) this.overlay.inert = true;
      this.openGeneration += 1;
      this.busy = false;
      if (this.trigger) this.trigger.setAttribute('aria-expanded', 'false');
      if (this.mirror) this.mirror.hide();
      if (typeof this.options.onClose === 'function') this.options.onClose(result || 'cancel');
    }

    _onStorage(event) {
      if (!event || ![this.options.favoritesStorageKey, this.options.recentsStorageKey].includes(event.key)) return;
      this.favoriteHashes = readList(this.options.favoritesStorageKey, this.options.storage);
      this.recentHashes = readList(this.options.recentsStorageKey, this.options.storage);
      if (this.remote) { this.remote.update(); return; }
      if (this.isOpen()) this._renderCatalog();
    }

    _onVisibility() {
      if (this.remote) return;
      if (!this.isOpen()) return;
      if (document.hidden) {
        if (this.mirror) this.mirror.hide();
      } else {
        this._renderPreview();
      }
    }

    open() {
      if (this.remote) return this.remote.open();
      const generation = ++this.openGeneration;
      this.searching = false;
      this.browseState = null;
      this._ensureDialog();
      this.overlay.inert = false;
      this.favoriteHashes = readList(this.options.favoritesStorageKey, this.options.storage);
      this.recentHashes = readList(this.options.recentsStorageKey, this.options.storage);
      this.currentHash = this._currentHash();
      const items = this._allItems();
      let remembered;
      try { remembered = (this.options.storage || root.localStorage).getItem(COLLECTION_KEY); } catch (_) {}
      this.collectionId = this.selection.collections.some(collection => collection.id === remembered) ? remembered : 'curated';
      this.filterQuery = '';
      this.elements.filter.value = '';
      const firstGroup = this._groupedItems().groups[0];
      const firstVisible = firstGroup && firstGroup.items[0];
      this.pendingHash = this._item(this.currentHash) ? this._key(this._item(this.currentHash)) : firstVisible ? this._key(firstVisible) : (items[0] && this._key(items[0])) || null;
      this._feedback('');
      this._renderCatalog();
      if (this.controller) this.controller.open({ focus: false, dismissResult: 'cancel' });
      else {
        this.overlay.classList.remove('hidden');
        this.overlay.classList.add('is-visible');
        this.overlay.setAttribute('aria-hidden', 'false');
      }
      if (this.trigger) this.trigger.setAttribute('aria-expanded', 'true');
      if (typeof this.options.onOpen === 'function') this.options.onOpen();
      root.requestAnimationFrame(() => {
        if (generation !== this.openGeneration || !this.isOpen()) return;
        this._renderPreview();
        const tab = this.elements.collections.querySelector('[aria-pressed="true"]') || this.elements.collections.querySelector('button');
        tab.focus({ preventScroll: true });
      });
    }

    close(result) {
      if (this.remote) return this.remote.close(result);
      if (!this.overlay) return;
      this.overlay.inert = true;
      if (this.controller) this.controller.close(result || 'cancel');
      else {
        this.overlay.classList.add('hidden');
        this.overlay.classList.remove('is-visible');
        this.overlay.setAttribute('aria-hidden', 'true');
        this._afterClose(result || 'cancel');
      }
    }

    isOpen() {
      if (this.remote) return this.remote.active;
      return !!(this.overlay && !this.overlay.classList.contains('hidden'));
    }

    setCurrent(contentHash) {
      const item = contentHash && this.catalog.get(String(contentHash));
      this.currentHash = item ? this.catalog.itemKey(item) : contentHash ? String(contentHash) : null;
      this.syncTrigger();
      if (this.remote) { this.remote.update(); return; }
      if (this.isOpen()) this._syncCardState();
    }

    remember(itemOrKey) {
      const item = itemOrKey && itemOrKey.entry ? itemOrKey : this._item(itemOrKey);
      if (!item) return null;
      const key = this._key(item);
      this.recentHashes = [key].concat(this.recentHashes.filter((value) => value !== key)).slice(0, Math.max(1, Number(this.options.recentLimit) || 6));
      writeList(this.options.recentsStorageKey, this.recentHashes, this.options.storage);
      return key;
    }

    syncTrigger() {
      if (!this.display) return;
      const item = this._item(this._currentHash());
      if (this.trigger) this.trigger.textContent = item ? this.options.triggerCurrentLabel : this.options.triggerEmptyLabel;
      const title = this.display.querySelector('[data-scene-picker-trigger-title]');
      const meta = this.display.querySelector('[data-scene-picker-trigger-meta]');
      const image = this.display.querySelector('[data-scene-picker-trigger-thumbnail]');
      if (title) title.textContent = item ? this._title(item) : this.options.emptyTitle;
      if (meta) {
        if (item) renderCapabilityMeta(meta, [sourceLabel(item.definition)], item.definition);
        else meta.textContent = this.options.emptyMeta;
      }
      if (image) {
        const url = item && this._thumbnail(item);
        this.display.classList.toggle('has-thumbnail', !!url);
        image.hidden = !url;
        if (url) image.src = url;
        else image.removeAttribute('src');
      }
    }

    refresh() {
      this.syncTrigger();
      if (this.remote) { this.remote.update(); return; }
      if (this.isOpen()) {
        this._renderCatalog();
        this._renderPreview();
      }
    }

    destroy() {
      this.openGeneration += 1;
      if (this.remote) this.remote.destroy();
      if (this.trigger && this._boundTrigger) this.trigger.removeEventListener('click', this._boundTrigger);
      if (this._unbindCatalog) this._unbindCatalog();
      if (this.compactMedia) this.compactMedia.removeEventListener('change', this._boundCompactChange);
      root.removeEventListener('storage', this._boundStorage);
      document.removeEventListener('visibilitychange', this._boundVisibility);
      if (this.mirror) this.mirror.dispose();
      if (this.overlay) this.overlay.remove();
      this.mirror = null;
      this.overlay = null;
    }
  }

  function createPicker(options) { return new ScenePresetPicker(options); }

  return Object.freeze({ ScenePresetPicker, createPicker, categoryLabel, capabilityIcons, FAVORITES_KEY, RECENTS_KEY });
});
