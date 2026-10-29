/* Shared Scene parameter selection and control rendering for V2 panels. */
(function(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VrchSceneParameterControls = api;
})(typeof window !== 'undefined' ? window : globalThis, function(root) {
  'use strict';

  function clone(value) {
    if (value == null) return value;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function resolveElement(value) {
    if (typeof value === 'string' && root.document) return root.document.getElementById(value);
    return value || null;
  }

  function syncRangeProgress(control) {
    const foundation = root && root.VrchPagesVisualFoundation;
    if (!foundation || typeof foundation.syncRangeProgress !== 'function' || !control) return;
    if (control.matches && control.matches('input[type="range"]')) foundation.syncRangeProgress(control);
    if (control.querySelectorAll) control.querySelectorAll('input[type="range"]').forEach((input) => foundation.syncRangeProgress(input));
  }

  function primaryParameters(parameters, limit = 3, preferredKeys = null) {
    const items = Array.isArray(parameters) ? parameters : [];
    const cap = Math.max(1, Math.min(items.length || 1, Number(limit) || 3));
    if (Array.isArray(preferredKeys) && preferredKeys.length) {
      const byKey = new Map(items.map((parameter) => [parameter.key, parameter]));
      const explicit = preferredKeys.slice(0, cap).map((key) => byKey.get(key)).filter(Boolean);
      if (explicit.length) return explicit;
    }
    if (items.length <= cap) return items.slice();
    const groups = [];
    items.forEach((parameter) => {
      let group = groups.find((entry) => entry.name === parameter.group);
      if (!group) {
        group = { name: parameter.group, items: [] };
        groups.push(group);
      }
      group.items.push(parameter);
    });
    const priorityNames = ['look', 'image', 'blend', 'shape', 'detail', 'background', 'material', 'motion', 'test'];
    const selected = [];
    priorityNames.forEach((name) => {
      const group = groups.find((entry) => String(entry.name || '').toLowerCase() === name);
      if (group && selected.length < cap) {
        const parameter = group.items.find((item) => !selected.includes(item));
        if (parameter) selected.push(parameter);
      }
    });
    groups.forEach((group) => {
      const parameter = group.items.find((item) => !selected.includes(item));
      if (parameter && selected.length < cap) selected.push(parameter);
    });
    items.forEach((parameter) => {
      if (selected.length < cap && !selected.includes(parameter)) selected.push(parameter);
    });
    return selected;
  }

  function colorToHex(value) {
    const values = Array.isArray(value) ? value : [1, 1, 1];
    return '#' + values.slice(0, 3).map((part) => Math.round(Math.max(0, Math.min(1, Number(part))) * 255).toString(16).padStart(2, '0')).join('');
  }

  function hexToColor(value, alpha) {
    const raw = String(value || '#ffffff').slice(1);
    const result = [0, 2, 4].map((offset) => parseInt(raw.slice(offset, offset + 2), 16) / 255);
    if (alpha != null) result.push(alpha);
    return result;
  }

  function formatValue(parameter, value) {
    if (parameter.type === 'color') return colorToHex(value);
    if (parameter.type === 'bool') return value ? 'ON' : 'OFF';
    if (parameter.type === 'vec2') return (Array.isArray(value) ? value : [0, 0]).map((part) => Number(part).toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')).join(' · ');
    if (parameter.type === 'float') {
      const step = Number(parameter.step) || 0.01;
      const decimals = Math.max(0, Math.min(3, String(step).includes('.') ? String(step).split('.')[1].length : 0));
      return Number(value).toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
    }
    return String(value);
  }

  function valueSignature(value) {
    return JSON.stringify(value);
  }

  function formatDisplayLabel(value) {
    return String(value == null ? '' : value).replace(/[A-Za-z][A-Za-z0-9]*/g, (word) => {
      if (/[A-Z]/.test(word.slice(1))) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    });
  }

  class ParameterList {
    constructor(options = {}) {
      this.mount = typeof options.mount === 'string' && root.document ? root.document.getElementById(options.mount) : options.mount;
      this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
      this.signature = '';
      this.disabled = false;
      if (!this.mount) throw new Error('ParameterList requires a mount element.');
    }

    _control(parameter, value) {
      let control;
      if (parameter.type === 'color') {
        control = document.createElement('input');
        control.type = 'color';
        control.className = 'ui-input ui-color-input';
        control.value = colorToHex(value);
      } else if (parameter.type === 'bool') {
        control = document.createElement('input');
        control.type = 'checkbox';
        control.className = 'ui-switch';
        control.checked = !!value;
      } else if (parameter.type === 'enum') {
        control = document.createElement('select');
        control.className = 'ui-input';
        (parameter.options || []).forEach((option) => {
          const element = document.createElement('option');
          element.value = option;
          element.textContent = option;
          control.append(element);
        });
        control.value = value;
      } else if (parameter.type === 'vec2') {
        control = document.createElement('span');
        control.className = 'scene-vec2-control';
        const values = Array.isArray(value) ? value : [0, 0];
        for (let index = 0; index < 2; index += 1) {
          const axis = document.createElement('input');
          axis.type = 'range';
          axis.className = 'ui-range ui-range--compact';
          axis.min = parameter.min == null ? -1 : parameter.min;
          axis.max = parameter.max == null ? 1 : parameter.max;
          axis.step = parameter.step || 0.01;
          axis.value = values[index] == null ? 0 : values[index];
          axis.dataset.axis = String(index);
          axis.disabled = this.disabled;
          control.append(axis);
        }
      } else {
        control = document.createElement('input');
        control.type = 'range';
        control.className = 'ui-range ui-range--compact';
        control.min = parameter.min;
        control.max = parameter.max;
        control.step = parameter.step || (parameter.type === 'int' ? 1 : 0.01);
        control.value = value;
      }
      control.dataset.paramKey = parameter.key;
      control.dataset.paramType = parameter.type;
      control.disabled = this.disabled;
      return control;
    }

    _readValue(control, parameter, originalValue) {
      if (parameter.type === 'color') return hexToColor(control.value, Array.isArray(originalValue) && originalValue.length === 4 ? originalValue[3] : null);
      if (parameter.type === 'bool') return control.checked;
      if (parameter.type === 'vec2') return Array.from(control.querySelectorAll('input[data-axis]')).map((axis) => Number(axis.value));
      if (parameter.type === 'int') return Math.round(Number(control.value));
      if (parameter.type === 'float') return Number(control.value);
      return control.value;
    }

    render(definition, instance, parameters, options = {}) {
      const items = Array.isArray(parameters) ? parameters : [];
      if (!definition || !instance) {
        this.clear();
        return;
      }
      const signature = String(instance.scene_ref && instance.scene_ref.content_hash || definition.scene_id) + ':' + items.map((parameter) => parameter.key).join(',');
      if (signature === this.signature && this.mount.childElementCount === items.length) {
        this.sync(instance, options);
        return;
      }
      this.mount.replaceChildren();
      this.signature = signature;
      items.forEach((parameter) => {
        const value = instance.params[parameter.key];
        const row = document.createElement('label');
        row.className = 'ui-settings-row ui-settings-row--split scene-param-row';
        const heading = document.createElement('span');
        heading.className = 'scene-param-row__heading';
        const label = document.createElement('span');
        label.className = 'ui-settings-label ui-settings-label--emphasis ui-text--truncate';
        label.dataset.sceneParameterLabel = '';
        label.textContent = formatDisplayLabel(parameter.label || parameter.key);
        label.title = parameter.description;
        const controlWrap = document.createElement('span');
        controlWrap.className = 'ui-settings-control scene-param-row__control';
        const control = this._control(parameter, value);
        control.__vrchLastEmittedValue = valueSignature(value);
        const valueElement = document.createElement('span');
        valueElement.className = 'scene-param-row__value';
        valueElement.textContent = formatValue(parameter, value);
        heading.append(label, valueElement);
        const emit = (phase) => {
          const next = this._readValue(control, parameter, value);
          valueElement.textContent = formatValue(parameter, next);
          const nextSignature = valueSignature(next);
          if (nextSignature === control.__vrchLastEmittedValue && phase !== 'end') return;
          control.__vrchLastEmittedValue = nextSignature;
          this.onChange({ key: parameter.key, value: clone(next), phase: phase, parameter: clone(parameter) });
        };
        control.addEventListener('input', () => emit('update'));
        control.addEventListener('change', () => emit('end'));
        controlWrap.append(control);
        row.append(heading, controlWrap);
        this.mount.append(row);
        syncRangeProgress(control);
      });
    }

    sync(instance, options = {}) {
      if (!instance) return;
      this.mount.querySelectorAll('[data-param-key]').forEach((control) => {
        const key = control.dataset.paramKey;
        const value = instance.params[key];
        const parameter = { type: control.dataset.paramType, step: control.step };
        const active = options.force !== true && (control === document.activeElement || (typeof control.contains === 'function' && control.contains(document.activeElement)));
        if (!active) {
          if (parameter.type === 'color') control.value = colorToHex(value);
          else if (parameter.type === 'bool') control.checked = !!value;
          else if (parameter.type === 'vec2') Array.from(control.querySelectorAll('input[data-axis]')).forEach((axis, index) => { axis.value = String(Array.isArray(value) && value[index] != null ? value[index] : 0); });
          else control.value = String(value);
          syncRangeProgress(control);
          control.__vrchLastEmittedValue = valueSignature(value);
          const row = control.closest && control.closest('.scene-param-row');
          const valueElement = row && row.querySelector('.scene-param-row__value');
          if (valueElement) valueElement.textContent = formatValue(parameter, value);
        }
      });
    }

    setDisabled(value) {
      this.disabled = !!value;
      this.mount.querySelectorAll('input, select, button').forEach((control) => { control.disabled = this.disabled; });
    }

    clear() {
      this.signature = '';
      this.mount.replaceChildren();
    }
  }

  function supportsAudio(definition) {
    return !!(definition && (definition.signals || []).some((signal) => String(signal.id || '').startsWith('audio.')));
  }

  function supportsAudioV2(definition) {
    return !!(definition && (definition.signals || []).some((signal) => String(signal.id || '').startsWith('audio.v2.')));
  }

  let visualParameterPanelCount = 0;

  class VisualParameterPanel {
    constructor(options = {}) {
      this.mount = resolveElement(options.mount || options.mountId);
      if (!this.mount) throw new Error('VisualParameterPanel requires a mount element.');
      this.primaryLimit = Math.max(1, Number(options.primaryLimit) || 3);
      this.onParameterChange = typeof options.onParameterChange === 'function' ? options.onParameterChange : () => {};
      this.onAudioChange = typeof options.onAudioChange === 'function' ? options.onAudioChange : () => {};
      this.onBindingChange = typeof options.onBindingChange === 'function' ? options.onBindingChange : () => {};
      this.onReset = typeof options.onReset === 'function' ? options.onReset : () => {};
      this.expanded = false;
      this.mode = 'simple';
      this.extendedCount = 0;
      this.disabled = false;
      this.storage = options.storage || null;
      this.collapseStorageKey = String(options.collapseStorageKey || '');
      this.audioCollapseStorageKey = this.collapseStorageKey ? this.collapseStorageKey + ':audio-response' : '';
      this.collapsed = options.defaultCollapsed === true;
      this.audioCollapsed = false;
      if (this.collapseStorageKey) {
        try {
          const stored = (this.storage || root.localStorage).getItem(this.collapseStorageKey);
          if (stored != null) this.collapsed = stored === '1';
          const storedAudio = this.audioCollapseStorageKey ? (this.storage || root.localStorage).getItem(this.audioCollapseStorageKey) : null;
          if (storedAudio != null) this.audioCollapsed = storedAudio === '1';
        } catch (_) {}
      }
      this._build(options.title || 'Parameters');
    }

    _build(title) {
      visualParameterPanelCount += 1;
      const bodyId = (this.mount.id || 'sceneVisualParameters' + visualParameterPanelCount) + 'Body';
      this.mount.classList.add('scene-visual-parameter-panel');
      this.mount.setAttribute('role', 'group');
      this.mount.setAttribute('aria-label', String(title));
      this.mount.innerHTML = `
        <div class="config-section-header scene-visual-parameter-panel__header" data-scene-parameter-header>
          <button class="scene-visual-parameter-panel__toggle" type="button" aria-expanded="true" aria-controls="${bodyId}" aria-label="Collapse visual parameters" data-scene-parameter-collapse>
            <i class="fas fa-chevron-down" aria-hidden="true"></i>
          </button>
          <span class="config-section-title ui-content-title">${String(title)}</span>
          <div class="ui-panel__actions scene-visual-parameter-panel__actions">
            <button class="ui-btn--sm ui-btn--quiet" type="button" aria-label="Reset visual parameters" data-scene-parameter-reset>Reset</button>
            <button class="ui-btn--sm ui-btn--quiet" type="button" aria-label="Show more visual parameters" data-scene-parameter-more aria-expanded="false" hidden>More</button>
          </div>
        </div>
        <div class="scene-visual-parameter-panel__body" id="${bodyId}" data-scene-parameter-body>
          <div class="scene-parameter-grid" data-scene-parameter-grid>
            <div class="scene-param-list" data-scene-parameter-primary></div>
            <div class="scene-param-list scene-visual-parameter-panel__extended" data-scene-parameter-extended-wrap data-scene-parameter-extended hidden></div>
          </div>
          <section class="scene-audio-response" data-scene-parameter-audio-wrap hidden>
            <div class="config-section-header scene-audio-response__header" data-scene-parameter-audio-header>
              <button class="scene-visual-parameter-panel__toggle scene-audio-response__collapse" type="button" aria-expanded="true" aria-label="Collapse audio response" data-scene-parameter-audio-collapse><i class="fas fa-chevron-down" aria-hidden="true"></i></button>
              <span class="config-section-title ui-content-title">Audio Response</span>
              <button class="ui-btn--sm scene-audio-master__toggle" type="button" aria-label="Audio response" aria-pressed="true" data-scene-parameter-audio-toggle>ON</button>
            </div>
            <div class="scene-audio-response__body" data-scene-parameter-audio-body>
              <div class="scene-parameter-grid scene-visual-parameter-panel__audio-grid">
                <label class="ui-settings-row ui-settings-row--split scene-param-row scene-audio-master" data-scene-audio-control="strength">
                  <span class="scene-param-row__heading"><span class="ui-settings-label ui-settings-label--emphasis ui-text--truncate" data-scene-parameter-label>Strength</span><span class="scene-param-row__value" data-scene-audio-value="strength">1</span></span>
                  <span class="ui-settings-control scene-param-row__control"><input class="ui-range ui-range--compact" type="range" min="0" max="2" step="0.05" value="1" data-scene-parameter-audio-input="strength" aria-label="Audio response strength"></span>
                </label>
                <label class="ui-settings-row ui-settings-row--split scene-param-row scene-audio-master" data-scene-audio-control="low">
                  <span class="scene-param-row__heading"><span class="ui-settings-label ui-settings-label--emphasis ui-text--truncate" data-scene-parameter-label>Low</span><span class="scene-param-row__value" data-scene-audio-value="low">1</span></span>
                  <span class="ui-settings-control scene-param-row__control"><input class="ui-range ui-range--compact" type="range" min="0" max="2" step="0.05" value="1" data-scene-parameter-audio-input="low" aria-label="Low frequency response"></span>
                </label>
                <label class="ui-settings-row ui-settings-row--split scene-param-row scene-audio-master" data-scene-audio-control="mid">
                  <span class="scene-param-row__heading"><span class="ui-settings-label ui-settings-label--emphasis ui-text--truncate" data-scene-parameter-label>Mid</span><span class="scene-param-row__value" data-scene-audio-value="mid">1</span></span>
                  <span class="ui-settings-control scene-param-row__control"><input class="ui-range ui-range--compact" type="range" min="0" max="2" step="0.05" value="1" data-scene-parameter-audio-input="mid" aria-label="Mid frequency response"></span>
                </label>
                <label class="ui-settings-row ui-settings-row--split scene-param-row scene-audio-master" data-scene-audio-control="high">
                  <span class="scene-param-row__heading"><span class="ui-settings-label ui-settings-label--emphasis ui-text--truncate" data-scene-parameter-label>High</span><span class="scene-param-row__value" data-scene-audio-value="high">1</span></span>
                  <span class="ui-settings-control scene-param-row__control"><input class="ui-range ui-range--compact" type="range" min="0" max="2" step="0.05" value="1" data-scene-parameter-audio-input="high" aria-label="High frequency response"></span>
                </label>
              </div>
              <div class="scene-audio-mappings" data-scene-audio-mappings hidden>
                <div class="scene-audio-mappings__title">Mappings</div>
                <div class="scene-audio-mappings__list" data-scene-audio-mapping-list></div>
              </div>
            </div>
          </section>
        </div>`;
      this.header = this.mount.querySelector('[data-scene-parameter-header]');
      this.collapseButton = this.mount.querySelector('[data-scene-parameter-collapse]');
      this.body = this.mount.querySelector('[data-scene-parameter-body]');
      this.resetButton = this.mount.querySelector('[data-scene-parameter-reset]');
      this.moreButton = this.mount.querySelector('[data-scene-parameter-more]');
      this.extendedWrap = this.mount.querySelector('[data-scene-parameter-extended-wrap]');
      this.audioWrap = this.mount.querySelector('[data-scene-parameter-audio-wrap]');
      this.audioHeader = this.mount.querySelector('[data-scene-parameter-audio-header]');
      this.audioBody = this.mount.querySelector('[data-scene-parameter-audio-body]');
      this.audioCollapseButton = this.mount.querySelector('[data-scene-parameter-audio-collapse]');
      this.audioInputs = new Map(Array.from(this.mount.querySelectorAll('[data-scene-parameter-audio-input]')).map((input) => [input.dataset.sceneParameterAudioInput, input]));
      this.audioValues = new Map(Array.from(this.mount.querySelectorAll('[data-scene-audio-value]')).map((value) => [value.dataset.sceneAudioValue, value]));
      this.audioControls = new Map(Array.from(this.mount.querySelectorAll('[data-scene-audio-control]')).map((control) => [control.dataset.sceneAudioControl, control]));
      this.audioToggle = this.mount.querySelector('[data-scene-parameter-audio-toggle]');
      this.audioMappings = this.mount.querySelector('[data-scene-audio-mappings]');
      this.audioMappingList = this.mount.querySelector('[data-scene-audio-mapping-list]');
      this.optionPopover = root.VrchPagesLiveConsoleActionPopover && typeof root.VrchPagesLiveConsoleActionPopover.createActionPopoverController === 'function'
        ? root.VrchPagesLiveConsoleActionPopover.createActionPopoverController({ document: root.document, window: root })
        : null;
      this.audioMappingSignature = '';
      this.expandedAudioMappings = new Set();
      this.currentDefinition = null;
      this.currentInstance = null;
      this.primary = new ParameterList({
        mount: this.mount.querySelector('[data-scene-parameter-primary]'),
        onChange: (change) => this.onParameterChange(change)
      });
      this.extended = new ParameterList({
        mount: this.mount.querySelector('[data-scene-parameter-extended]'),
        onChange: (change) => this.onParameterChange(change)
      });
      this.header.addEventListener('click', (event) => {
        if (event.target.closest('[data-scene-parameter-reset], [data-scene-parameter-more]')) return;
        this.setCollapsed(!this.collapsed);
      });
      this.resetButton.addEventListener('click', () => this.onReset());
      this.moreButton.addEventListener('click', () => this.setExpanded(!this.expanded));
      this.audioToggle.addEventListener('click', () => {
        const enabled = this.audioToggle.getAttribute('aria-pressed') !== 'true';
        this._setAudioToggle(enabled);
        this._emitAudio('end');
      });
      this.audioCollapseButton.addEventListener('click', () => this.setAudioCollapsed(!this.audioCollapsed));
      this.audioInputs.forEach((input, key) => {
        input.addEventListener('input', () => { this._syncAudioValue(key); this._emitAudio('update'); });
        input.addEventListener('change', () => { this._syncAudioValue(key); this._emitAudio('end'); });
      });
      this._syncCollapse();
      this._syncAudioDisclosure();
    }

    _setAudioToggle(enabled) {
      this.audioToggle.setAttribute('aria-pressed', String(!!enabled));
      this.audioToggle.textContent = enabled ? 'ON' : 'OFF';
    }

    _emitAudio(phase) {
      const strength = Number(this.audioInputs.get('strength').value);
      this.onAudioChange({
        enabled: this.audioToggle.getAttribute('aria-pressed') === 'true',
        contract_version: this.audioV2 ? 2 : 1,
        gain: strength,
        strength: strength,
        band_gains: {
          low: Number(this.audioInputs.get('low').value),
          mid: Number(this.audioInputs.get('mid').value),
          high: Number(this.audioInputs.get('high').value)
        },
        phase: phase
      });
    }

    _syncAudioValue(key) {
      const input = this.audioInputs.get(key);
      const value = this.audioValues.get(key);
      if (input && value) value.textContent = Number(input.value).toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
      syncRangeProgress(input);
    }

    _syncAudioDisclosure() {
      if (!this.audioBody || !this.audioCollapseButton) return;
      this.audioBody.hidden = this.audioCollapsed;
      this.audioCollapseButton.setAttribute('aria-expanded', String(!this.audioCollapsed));
      this.audioCollapseButton.setAttribute('aria-label', (this.audioCollapsed ? 'Expand' : 'Collapse') + ' audio response');
      const icon = this.audioCollapseButton.querySelector('i');
      if (icon) icon.classList.toggle('collapsed', this.audioCollapsed);
    }

    setAudioCollapsed(value, options = {}) {
      this.audioCollapsed = !!value;
      this._syncAudioDisclosure();
      if (options.persist !== false && this.audioCollapseStorageKey) {
        try { (this.storage || root.localStorage).setItem(this.audioCollapseStorageKey, this.audioCollapsed ? '1' : '0'); }
        catch (_) {}
      }
    }

    _choiceButton(value, choices, label, onSelect) {
      const button = root.document.createElement('button');
      button.type = 'button';
      button.className = 'ui-select-control scene-audio-mapping__choice';
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', label);
      const valueElement = root.document.createElement('span');
      valueElement.className = 'ui-select-control__value';
      const selected = choices.find((choice) => choice.id === value);
      valueElement.textContent = selected ? selected.label : String(value || '—');
      const icon = root.document.createElement('i');
      icon.className = 'fas fa-chevron-down ui-select-control__chevron';
      icon.setAttribute('aria-hidden', 'true');
      button.append(valueElement, icon);
      button.disabled = this.disabled || !choices.length;
      button.addEventListener('click', () => {
        if (button.disabled) return;
        if (this.optionPopover) {
          this.optionPopover.open(button, choices.map((choice) => ({
            id: choice.id,
            label: choice.label,
            current: choice.id === value,
            currentIconClass: choice.id === value ? 'fa-check' : ''
          })), {
            className: 'live-console-settings__option-popover scene-audio-mapping__popover',
            minWidth: Math.max(132, button.getBoundingClientRect().width),
            matchWidth: true,
            align: 'left',
            onSelect: (choice) => {
              valueElement.textContent = choice.label;
              onSelect(choice.id);
            }
          });
          return;
        }
        const index = Math.max(0, choices.findIndex((choice) => choice.id === value));
        onSelect(choices[(index + 1) % choices.length].id);
      });
      return button;
    }

    _emitBinding(binding, phase) {
      this.onBindingChange({ binding: clone(binding), phase: phase || 'end' });
    }

    _mappingRange(binding, field, label, min, max, step) {
      const wrap = root.document.createElement('label');
      wrap.className = 'scene-audio-mapping__range';
      const heading = root.document.createElement('span');
      heading.className = 'scene-audio-mapping__range-heading';
      const labelElement = root.document.createElement('span');
      labelElement.className = 'ui-settings-label';
      labelElement.textContent = label;
      const valueElement = root.document.createElement('span');
      const input = root.document.createElement('input');
      input.type = 'range';
      input.className = 'ui-range ui-range--compact';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(binding[field]);
      input.disabled = this.disabled;
      input.dataset.audioBindingId = binding.binding_id;
      input.dataset.audioBindingField = field;
      valueElement.dataset.audioBindingId = binding.binding_id;
      valueElement.dataset.audioBindingValue = field;
      const syncValue = () => {
        const value = Number(input.value);
        valueElement.textContent = field.endsWith('_ms') ? Math.round(value) + ' ms' : value.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
        syncRangeProgress(input);
      };
      input.addEventListener('input', () => { binding[field] = Number(input.value); syncValue(); this._emitBinding(binding, 'update'); });
      input.addEventListener('change', () => { binding[field] = Number(input.value); syncValue(); this._emitBinding(binding, 'end'); });
      heading.append(labelElement, valueElement);
      wrap.append(heading, input);
      syncValue();
      return wrap;
    }

    _renderAudioMappings(definition, instance) {
      if (!this.audioMappings || !this.audioMappingList) return;
      const bindings = (instance && instance.bindings || []).filter((binding) => binding.binding_version === 2 && String(binding.signal_id || '').startsWith('audio.'));
      const shouldShow = this.mode === 'expert' && bindings.length > 0;
      this.audioMappings.hidden = !shouldShow;
      if (!shouldShow) {
        this.audioMappingList.replaceChildren();
        this.audioMappingSignature = '';
        return;
      }
      const signature = String(instance.scene_ref && instance.scene_ref.content_hash || definition.scene_id) + ':' + bindings.map((binding) => [binding.binding_id, binding.signal_id, binding.param_key, binding.curve, binding.polarity].join('/')).join('|');
      if (signature === this.audioMappingSignature) {
        bindings.forEach((binding) => {
          ['depth', 'attack_ms', 'release_ms'].forEach((field) => {
            const input = this.audioMappingList.querySelector('[data-audio-binding-id="' + binding.binding_id + '"][data-audio-binding-field="' + field + '"]');
            if (!input || input === root.document.activeElement) return;
            input.value = String(binding[field]);
            syncRangeProgress(input);
            const value = this.audioMappingList.querySelector('[data-audio-binding-id="' + binding.binding_id + '"][data-audio-binding-value="' + field + '"]');
            if (value) value.textContent = field.endsWith('_ms') ? Math.round(Number(binding[field])) + ' ms' : Number(binding[field]).toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
          });
        });
        return;
      }
      this.audioMappingSignature = signature;
      this.audioMappingList.replaceChildren();
      const signalChoices = (definition.signals || []).filter((signal) => String(signal.id || '').startsWith('audio.') && ['scalar', 'trigger'].includes(signal.type)).map((signal) => ({ id: signal.id, label: formatDisplayLabel(signal.id.replace(/^audio\.v2\./, '').replace(/^audio\./, '').replace(/_/g, ' ')) }));
      const targetChoices = (definition.parameters || []).filter((parameter) => ['float', 'int'].includes(parameter.type)).map((parameter) => ({ id: parameter.key, label: formatDisplayLabel(parameter.label || parameter.key) }));
      const curveChoices = ['linear', 'ease_in', 'ease_out', 'smoothstep'].map((value) => ({ id: value, label: formatDisplayLabel(value.replace(/_/g, ' ')) }));
      const polarityChoices = ['positive', 'negative', 'bipolar'].map((value) => ({ id: value, label: formatDisplayLabel(value) }));
      bindings.forEach((sourceBinding) => {
        const binding = clone(sourceBinding);
        const row = root.document.createElement('section');
        row.className = 'scene-audio-mapping';
        row.dataset.bindingId = binding.binding_id;
        const route = root.document.createElement('div');
        route.className = 'scene-audio-mapping__route';
        const sourceButton = this._choiceButton(binding.signal_id, signalChoices, 'Audio source', (value) => {
          binding.signal_id = value;
          const signal = (definition.signals || []).find((item) => item.id === value);
          if (signal) binding.signal_type = signal.type;
          this.audioMappingSignature = '';
          this._emitBinding(binding, 'end');
        });
        const arrow = root.document.createElement('i');
        arrow.className = 'fas fa-arrow-right scene-audio-mapping__arrow';
        arrow.setAttribute('aria-hidden', 'true');
        const targetButton = this._choiceButton(binding.param_key, targetChoices, 'Visual target', (value) => {
          binding.param_key = value;
          this.audioMappingSignature = '';
          this._emitBinding(binding, 'end');
        });
        const detailButton = root.document.createElement('button');
        detailButton.type = 'button';
        detailButton.className = 'ui-btn--sm';
        detailButton.dataset.sceneAudioMappingDetails = '';
        detailButton.textContent = 'DETAILS';
        const details = root.document.createElement('div');
        details.className = 'scene-audio-mapping__details';
        const expanded = this.expandedAudioMappings.has(binding.binding_id);
        details.hidden = !expanded;
        detailButton.setAttribute('aria-expanded', String(expanded));
        detailButton.addEventListener('click', () => {
          const next = details.hidden;
          details.hidden = !next;
          detailButton.setAttribute('aria-expanded', String(next));
          if (next) this.expandedAudioMappings.add(binding.binding_id);
          else this.expandedAudioMappings.delete(binding.binding_id);
        });
        route.append(sourceButton, arrow, targetButton, detailButton);
        const depth = this._mappingRange(binding, 'depth', 'Depth', -1, 1, 0.01);
        depth.classList.add('scene-audio-mapping__depth');
        const curveButton = this._choiceButton(binding.curve, curveChoices, 'Response curve', (value) => { binding.curve = value; this.audioMappingSignature = ''; this._emitBinding(binding, 'end'); });
        const polarityButton = this._choiceButton(binding.polarity, polarityChoices, 'Polarity', (value) => { binding.polarity = value; this.audioMappingSignature = ''; this._emitBinding(binding, 'end'); });
        details.append(curveButton, polarityButton, this._mappingRange(binding, 'attack_ms', 'Attack', 0, 1000, 10), this._mappingRange(binding, 'release_ms', 'Release', 0, 2000, 10));
        row.append(route, depth, details);
        this.audioMappingList.append(row);
      });
    }

    _syncDisclosure() {
      const hasExtended = this.extendedCount > 0;
      this.moreButton.hidden = !hasExtended || this.collapsed;
      this.moreButton.textContent = this.expanded ? 'Less' : 'More (' + this.extendedCount + ')';
      this.moreButton.setAttribute('aria-label', this.expanded ? 'Show fewer visual parameters' : 'Show ' + this.extendedCount + ' more visual parameters');
      this.moreButton.setAttribute('aria-expanded', String(this.expanded && hasExtended));
      this.extendedWrap.hidden = !hasExtended || !this.expanded;
    }

    _syncCollapse() {
      this.mount.classList.toggle('is-collapsed', this.collapsed);
      this.collapseButton.setAttribute('aria-expanded', String(!this.collapsed));
      this.collapseButton.setAttribute('aria-label', (this.collapsed ? 'Expand' : 'Collapse') + ' visual parameters');
      const icon = this.collapseButton.querySelector('i');
      if (icon) icon.classList.toggle('collapsed', this.collapsed);
      this.body.hidden = this.collapsed;
      this.body.setAttribute('aria-hidden', String(this.collapsed));
      this._syncDisclosure();
    }

    setCollapsed(value, options = {}) {
      this.collapsed = !!value;
      this._syncCollapse();
      if (options.persist !== false && this.collapseStorageKey) {
        try { (this.storage || root.localStorage).setItem(this.collapseStorageKey, this.collapsed ? '1' : '0'); }
        catch (_) {}
      }
    }

    setMode(value, options = {}) {
      const next = value === 'expert' ? 'expert' : 'simple';
      const changed = next !== this.mode;
      this.mode = next;
      if (changed || options.force === true) this.expanded = next === 'expert';
      this._syncDisclosure();
      if (this.currentDefinition && this.currentInstance) this._renderAudioMappings(this.currentDefinition, this.currentInstance);
    }

    setExpanded(value) {
      this.expanded = !!value && this.extendedCount > 0;
      this._syncDisclosure();
    }

    render(definition, instance, options = {}) {
      const parameters = definition && Array.isArray(definition.parameters) ? definition.parameters : [];
      const audioVisible = supportsAudio(definition);
      const visible = !!(definition && instance && (parameters.length || audioVisible));
      this.mount.hidden = !visible;
      if (!visible) {
        this.clear();
        return;
      }
      this.currentDefinition = definition;
      this.currentInstance = instance;
      const simpleParameters = definition.ui && definition.ui.simple_parameters;
      const primary = primaryParameters(parameters, this.primaryLimit, simpleParameters);
      const primaryKeys = new Set(primary.map((parameter) => parameter.key));
      const extended = parameters.filter((parameter) => !primaryKeys.has(parameter.key));
      this.extendedCount = extended.length;
      this.primary.render(definition, instance, primary, options);
      this.extended.render(definition, instance, extended, options);
      this.disabled = options.disabled === true;
      this.primary.setDisabled(this.disabled);
      this.extended.setDisabled(this.disabled);
      this.resetButton.disabled = this.disabled || options.canReset === false;
      this.audioWrap.hidden = !audioVisible;
      this.audioToggle.disabled = this.disabled;
      if (audioVisible) {
        const audio = instance.modulation_master && instance.modulation_master.audio || {};
        this.audioV2 = audio.contract_version === 2 || supportsAudioV2(definition);
        this.audioWrap.classList.toggle('is-v2', this.audioV2);
        const bandGains = audio.band_gains || {};
        const values = {
          strength: this.audioV2 ? (Number.isFinite(Number(audio.strength)) ? Number(audio.strength) : 1) : (Number.isFinite(Number(audio.gain)) ? Number(audio.gain) : 1),
          low: Number.isFinite(Number(bandGains.low)) ? Number(bandGains.low) : 1,
          mid: Number.isFinite(Number(bandGains.mid)) ? Number(bandGains.mid) : 1,
          high: Number.isFinite(Number(bandGains.high)) ? Number(bandGains.high) : 1
        };
        this.audioInputs.forEach((input, key) => {
          input.disabled = this.disabled;
          const active = input === root.document.activeElement;
          if (!active || options.force === true) input.value = String(values[key]);
          this._syncAudioValue(key);
        });
        const signalIds = new Set((definition.signals || []).map((signal) => String(signal.id || '')));
        ['low', 'mid', 'high'].forEach((band) => {
          const control = this.audioControls.get(band);
          if (!control) return;
          control.hidden = !this.audioV2 || !(signalIds.has('audio.v2.' + band) || signalIds.has('audio.v2.' + band + '_share'));
        });
        this._setAudioToggle(audio.enabled !== false);
        this._renderAudioMappings(definition, instance);
      }
      this._syncDisclosure();
      this._syncAudioDisclosure();
    }

    clear() {
      this.primary.clear();
      this.extended.clear();
      this.extendedCount = 0;
      this.audioWrap.hidden = true;
      this.currentDefinition = null;
      this.currentInstance = null;
      this.audioMappingSignature = '';
      if (this.audioMappingList) this.audioMappingList.replaceChildren();
      this._syncDisclosure();
    }
  }

  return Object.freeze({
    ParameterList: ParameterList,
    VisualParameterPanel: VisualParameterPanel,
    primaryParameters: primaryParameters,
    supportsAudio: supportsAudio,
    supportsAudioV2: supportsAudioV2,
    colorToHex: colorToHex,
    hexToColor: hexToColor,
    formatValue: formatValue,
    formatDisplayLabel: formatDisplayLabel
  });
});
