(function(global){
  'use strict';
  if (global.VrchDialogs && global.VrchDialogs.createShell) return;

  function hasOwn(obj, key){
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function resolveElement(root, ref){
    if (!root || !ref) return null;
    if (typeof ref === 'string') return root.querySelector(ref);
    if (ref && ref.nodeType === 1) return ref;
    return null;
  }

  function focusElement(target){
    if (!target || typeof target.focus !== 'function') return;
    try {
      target.focus({ preventScroll:true });
    } catch(_) {
      try { target.focus(); } catch(__) {}
    }
  }

  function toButtonClassName(value){
    const classList = ['ui-btn--md'];
    if (Array.isArray(value)) {
      value.forEach((item)=>{
        const text = typeof item === 'string' ? item.trim() : '';
        if (text) classList.push(text);
      });
    } else if (typeof value === 'string' && value.trim()) {
      classList.push(value.trim());
    }
    return classList.join(' ');
  }

  function setDialogVisibility(overlay, open){
    if (!overlay) return;
    overlay.classList.toggle('hidden', !open);
    overlay.classList.toggle('is-visible', !!open);
    overlay.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) overlay.setAttribute('data-open', 'true');
    else overlay.removeAttribute('data-open');
  }

  function createOverlayElement(id, innerHtml){
    if (typeof document === 'undefined' || !document.body) return null;
    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = 'ui-modal hidden';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('tabindex', '-1');
    overlay.innerHTML = innerHtml;
    document.body.appendChild(overlay);
    return overlay;
  }

  function normalizeText(text){
    return text === undefined || text === null ? '' : String(text);
  }

  function normalizeDialogCall(defaultTitle, title, message, options){
    if (typeof title === 'object' && title !== null && message === undefined && options === undefined) {
      const dialogOptions = Object.assign({}, title);
      if (!hasOwn(dialogOptions, 'title')) dialogOptions.title = defaultTitle;
      if (!hasOwn(dialogOptions, 'message')) dialogOptions.message = '';
      return dialogOptions;
    }
    if (message === undefined && (typeof title === 'string' || title === undefined || title === null)) {
      return Object.assign({}, options || {}, {
        title: defaultTitle,
        message: normalizeText(title)
      });
    }
    return Object.assign({}, options || {}, {
      title: title === undefined || title === null ? defaultTitle : normalizeText(title),
      message: normalizeText(message)
    });
  }

  let globalMessageDialog = null;
  let globalPromptDialog = null;

  // Declarative headers and programmatic dialogs share this renderer. Feature
  // code supplies existing title/navigation/action nodes, never header HTML.
  const shells = new WeakMap();
  let nextTitleId = 0;

  function connectShell(overlay, options = {}){
    if (!overlay) return null;
    const existing = shells.get(overlay);
    if (existing) { Object.assign(existing, options); return existing; }
    const surface = options.surface || overlay.querySelector('.ui-modal__dialog') || overlay;
    surface.classList.add('ui-dialog-shell');
    const shell = { overlay, surface, ...options };
    shells.set(overlay, shell);
    return shell;
  }

  function requestClose(shell, reason){
    if (typeof shell.onRequestClose === 'function') return shell.onRequestClose(reason);
    const header = shell.surface.querySelector('vrch-dialog-header');
    const button = header?.querySelector('[data-dialog-close]:not([data-dialog-generated-close])');
    if (button) { if (!button.disabled) button.click(); return; }
    const selector = header?.getAttribute('dismiss');
    const action = selector ? shell.overlay.querySelector(selector) : null;
    if (action) { if (!action.disabled) action.click(); return; }
    // No implicit generic hide: a consumer must provide a real cancellation
    // action or controller, so closing cannot accidentally commit work.
  }

  function renderHeader(header, options = {}){
    options = { ...header.dialogOptions, ...options };
    header.dialogOptions = options;
    const doc = header.ownerDocument;
    let title = options.title || header.querySelector('[slot="title"],.ui-dialog__title');
    if (typeof title === 'string') { const node = header.querySelector('[slot="title"]') || doc.createElement('h2'); if (node.textContent !== title) node.textContent = title; node.classList.add('ui-dialog__title'); title = node; }
    let navigation = hasOwn(options,'navigation') ? options.navigation : header.querySelector('[slot="navigation"],nav.ui-tabs,.ui-chooser__tabs');
    let close = options.close || header.querySelector('[slot="close"],.ui-dialog__close') || header.dialogClose;
    const action = hasOwn(options,'action') ? options.action : header.querySelector('[slot="action"]');
    let identity = header.querySelector('[data-dialog-identity]');
    if (!identity) {
      identity = doc.createElement('span'); identity.dataset.dialogIdentity = '';
      header.prepend(identity);
    }
    identity.className = 'ui-dialog-header__icon';
    const icon = options.icon || header.getAttribute('icon') || 'fa-window-maximize';
    if (options.identity) {
      if (identity.firstChild !== options.identity || identity.childNodes.length !== 1) identity.replaceChildren(options.identity);
    }
    else {
      const className = (icon === 'fa-bluetooth-b' ? 'fab ' : 'fas ') + icon;
      if (identity.firstElementChild?.className !== className) {
        const glyph = doc.createElement('i'); glyph.className = className;
        glyph.setAttribute('aria-hidden','true'); identity.replaceChildren(glyph);
      }
    }
    if (!options.identity) identity.setAttribute('aria-hidden','true');
    else identity.removeAttribute('aria-hidden');
    if (!title) { title = doc.createElement('h2'); title.className = 'ui-dialog__title'; title.textContent = options.label || header.getAttribute('label') || 'Dialog'; }
    title.slot = 'title'; title.classList.add('ui-dialog-header__title');
    title.classList.remove('ui-chooser__title','ui-chooser__title--icon');
    if (!title.id) title.id = 'vrch-dialog-title-' + ++nextTitleId;
    title.hidden = !!navigation;
    if (navigation) { navigation.slot = 'navigation'; navigation.classList.add('ui-dialog-header__navigation'); }
    if (!action && !close) {
      close = doc.createElement('button'); close.type = 'button';
      close.setAttribute('aria-label','Close ' + (options.label || header.getAttribute('label') || 'dialog')); close.dataset.dialogGeneratedClose = '';
      close.addEventListener('click', () => { const shell = header.dialogShell; if (shell) requestClose(shell,'close'); });
    }
    if (!action) {
      close.type = 'button';
      const cross = doc.createElementNS('http://www.w3.org/2000/svg','svg');
      cross.setAttribute('viewBox','0 0 24 24'); cross.setAttribute('width','18'); cross.setAttribute('height','18'); cross.setAttribute('aria-hidden','true');
      const path = doc.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d','m6 6 12 12M18 6 6 18'); path.setAttribute('fill','none'); path.setAttribute('stroke','currentColor'); path.setAttribute('stroke-width','2');
      cross.append(path); close.replaceChildren(cross);
      close.slot = 'close'; close.dataset.dialogClose = '';
      close.classList.remove('ui-chooser__close','ui-modal__close','ui-dialog__close--quiet');
      close.classList.add('ui-dialog__close','ui-dialog-header__close');
      header.dialogClose = close;
    }
    const end = action || close;
    if (action) end.slot = 'action';
    end.type = 'button'; end.classList.add('ui-icon-action','ui-dialog-header__action');
    header.className = 'ui-dialog-header';
    const nodes = [identity, title, ...(navigation ? [navigation] : []), end];
    if (header.children.length !== nodes.length || nodes.some((node,index) => header.children[index] !== node)) header.replaceChildren(...nodes);
    const surface = header.closest('.ui-modal__dialog,[role="dialog"],dialog');
    const overlay = surface?.closest('.ui-modal,.live-console-pane-switcher,[data-notice]') || surface;
    if (overlay) {
      const label = options.label || header.getAttribute('label');
      const named = ['dialog','alertdialog'].includes(surface.getAttribute('role')) ? surface : overlay;
      if (navigation && label) { named.setAttribute('aria-label',label); named.removeAttribute('aria-labelledby'); header.namedByNavigation = true; }
      else if (header.namedByNavigation) { named.removeAttribute('aria-label'); named.setAttribute('aria-labelledby',title.id); header.namedByNavigation = false; }
      else if (!named.hasAttribute('aria-label') && !named.hasAttribute('aria-labelledby')) named.setAttribute('aria-labelledby',title.id);
      header.dialogShell = connectShell(overlay, { surface });
    }
    return header;
  }

  function createHeader(options = {}){
    const doc = options.document || document, header = doc.createElement('vrch-dialog-header');
    if (options.icon) header.setAttribute('icon',options.icon);
    if (options.label) header.setAttribute('label',options.label);
    if (options.dismiss) header.setAttribute('dismiss',options.dismiss);
    renderHeader(header, options);
    return header;
  }

  function createShell(options = {}){
    const doc = options.document || document, overlay = doc.createElement('div'), surface = doc.createElement('section');
    overlay.className = 'ui-modal hidden'; if (options.id) overlay.id = options.id;
    overlay.setAttribute('aria-hidden','true');
    surface.className = 'ui-modal__dialog ui-dialog-shell'; surface.setAttribute('role','dialog'); surface.setAttribute('aria-modal','true');
    surface.append(createHeader(options));
    if (options.body) surface.append(options.body);
    if (options.actions) surface.append(options.actions);
    overlay.append(surface); (options.mount || doc.body).append(overlay);
    connectShell(overlay, { surface, onRequestClose:options.onRequestClose });
    return { overlay, surface, header:surface.querySelector('vrch-dialog-header') };
  }

  if (global.customElements && global.HTMLElement) {
    global.customElements.define('vrch-dialog-header', class extends global.HTMLElement {
      connectedCallback(){
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { if (this.isConnected) renderHeader(this); }, {once:true});
        else renderHeader(this);
      }
    });
    // Escape delegates to the visible foreground dialog's existing cancellation
    // action. No background mutation, Tab interception or focus management.
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      // Existing anchored menus handle their own Escape before the dialog.
      if ([...document.querySelectorAll('.ui-action-popover')].some(node => node.getClientRects().length)) return;
      const visible = [...document.querySelectorAll('vrch-dialog-header')]
        .map(header => header.dialogShell)
        .filter(shell => shell && !shell.overlay.hidden && shell.overlay.getAttribute('aria-hidden') !== 'true'
          && shell.surface.getClientRects().length && getComputedStyle(shell.surface).visibility !== 'hidden');
      visible.sort((a,b) => {
        const nativeA = a.overlay.matches('dialog:modal'), nativeB = b.overlay.matches('dialog:modal');
        if (nativeA !== nativeB) return nativeA ? 1 : -1;
        if (a.overlay.contains(b.overlay)) return -1;
        if (b.overlay.contains(a.overlay)) return 1;
        const layer = (parseFloat(getComputedStyle(a.overlay).zIndex) || 0) - (parseFloat(getComputedStyle(b.overlay).zIndex) || 0);
        return layer || (a.overlay.compareDocumentPosition(b.overlay) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
      });
      const shell = visible.at(-1);
      if (!shell) return;
      event.preventDefault(); event.stopImmediatePropagation(); requestClose(shell,'escape');
    }, true);
  }

  function createController(options){
    const config = Object.assign({
      overlayId: '',
      overlay: null,
      closeOnBackdrop: true,
      closeOnEscape: true,
      dismissResult: 'dismiss',
      fallback: null,
      selectors: {
        titleEl: '.ui-dialog__title',
        messageEl: '.ui-dialog__note',
        primaryBtn: '[data-role="primary"]',
        secondaryBtn: '[data-role="secondary"]',
        tertiaryBtn: '[data-role="tertiary"]'
      }
    }, options || {});

    const state = {
      overlay: null,
      resolver: null,
      prevFocus: null,
      openOptions: null,
      bound: false
    };

    function getOpenOptions(){
      return state.openOptions || {};
    }

    function getDismissResult(){
      const openOptions = getOpenOptions();
      const source = hasOwn(openOptions, 'dismissResult') ? openOptions.dismissResult : config.dismissResult;
      return (typeof source === 'function') ? source(state, api, openOptions) : source;
    }

    function handleFallback(openOptions){
      const source = hasOwn(openOptions || {}, 'fallback') ? openOptions.fallback : config.fallback;
      if (typeof source === 'function') return source(openOptions || {}, api);
      return source !== undefined ? source : null;
    }

    function clearResolver(result){
      const resolver = state.resolver;
      state.resolver = null;
      if (typeof resolver === 'function') resolver(result);
    }

    function ensure(){
      if (state.overlay) return state;
      const overlay = config.overlay || document.getElementById(config.overlayId);
      if (!overlay) return null;
      state.overlay = overlay;
      connectShell(overlay, { onRequestClose:(reason) => {
        if (reason === 'escape' && config.closeOnEscape === false) return;
        if (typeof config.onRequestClose === 'function' && config.onRequestClose(reason,state,api) === false) return;
        api.close(getDismissResult());
      } });
      const selectors = config.selectors || {};
      Object.keys(selectors).forEach((key)=>{
        state[key] = resolveElement(overlay, selectors[key]);
      });
      if (!state.bound) {
        if (config.closeOnBackdrop !== false) {
          overlay.addEventListener('click', (event)=>{
            if (event.target !== overlay) return;
            api.close(getDismissResult());
          });
        }
        if (config.closeOnEscape !== false) {
          overlay.addEventListener('keydown', (event)=>{
            if (event.key !== 'Escape') return;
            event.preventDefault();
            api.close(getDismissResult());
          });
        }
        if (typeof config.onEnsure === 'function') {
          config.onEnsure(state, api);
        }
        state.bound = true;
      }
      return state;
    }

    function focus(target){
      const current = ensure();
      if (!current) return;
      if (target === false) return;
      let element = null;
      if (typeof target === 'string') {
        element = current[target]
          || current[`${target}Btn`]
          || current[`${target}El`]
          || current[`${target}Input`]
          || resolveElement(current.overlay, target);
      } else if (target && target.nodeType === 1) {
        element = target;
      }
      if (!element) {
        element = current.primaryBtn || current.overlay;
      }
      focusElement(element);
    }

    function open(openOptions){
      const current = ensure();
      if (!current) return Promise.resolve(handleFallback(openOptions || {}));
      if (state.resolver) {
        api.close(hasOwn(openOptions || {}, 'interruptResult') ? openOptions.interruptResult : getDismissResult());
      }
      state.openOptions = openOptions || {};
      state.prevFocus = document.activeElement;
      setDialogVisibility(current.overlay, true);
      if (hasOwn(state.openOptions, 'title') && current.titleEl) current.titleEl.textContent = state.openOptions.title || '';
      if (hasOwn(state.openOptions, 'message') && current.messageEl) current.messageEl.textContent = state.openOptions.message || '';
      if (typeof state.openOptions.onOpen === 'function') {
        state.openOptions.onOpen(current, api);
      }
      if (state.openOptions.focus !== undefined) focus(state.openOptions.focus);
      return new Promise((resolve)=>{
        state.resolver = resolve;
      });
    }

    function close(result){
      if (!state.overlay) return result;
      const current = state;
      const openOptions = getOpenOptions();
      const finalResult = (result !== undefined) ? result : getDismissResult();
      if (typeof openOptions.onBeforeResolve === 'function') {
        try {
          openOptions.onBeforeResolve(finalResult, current, api);
        } catch(err) {
          console.error('[VrchDialogs] onBeforeResolve failed', err);
        }
      }
      setDialogVisibility(current.overlay, false);
      state.openOptions = null;
      if (typeof config.onClose === 'function') {
        try {
          config.onClose(finalResult, current, api);
        } catch(err) {
          console.error('[VrchDialogs] onClose failed', err);
        }
      }
      const prevFocus = current.prevFocus;
      current.prevFocus = null;
      if (prevFocus && typeof prevFocus.focus === 'function') {
        focusElement(prevFocus);
      }
      clearResolver(finalResult);
      return finalResult;
    }

    function setButton(key, options){
      const current = ensure();
      if (!current) return null;
      const button = current[key];
      if (!button) return null;
      const buttonOptions = options || {};
      if (hasOwn(buttonOptions, 'visible')) {
        const visible = buttonOptions.visible !== false;
        button.classList.toggle('hidden', !visible);
        if (!visible) {
          if (buttonOptions.clearHandler !== false) button.onclick = null;
          return button;
        }
      }
      if (hasOwn(buttonOptions, 'className')) {
        button.className = toButtonClassName(buttonOptions.className);
      }
      if (hasOwn(buttonOptions, 'label')) {
        button.textContent = buttonOptions.label || '';
      }
      if (buttonOptions.onClick === null) {
        button.onclick = null;
      } else if (typeof buttonOptions.onClick === 'function') {
        button.onclick = buttonOptions.onClick;
      } else if (hasOwn(buttonOptions, 'result')) {
        button.onclick = function(){ api.close(buttonOptions.result); };
      }
      return button;
    }

    function isOpen(){
      return !!(state.overlay && !state.overlay.classList.contains('hidden'));
    }

    function getElement(key){
      const current = ensure();
      if (!current) return null;
      return current[key] || null;
    }

    const api = {
      ensure,
      open,
      close,
      focus,
      setButton,
      getElement,
      isOpen,
      getState: function(){
        return ensure();
      }
    };

    return api;
  }

  function hasOpenDialog(root){
    const scope = root || document;
    if (!scope || typeof scope.querySelector !== 'function') return false;
    return !!scope.querySelector('.ui-modal[data-open="true"], .ui-modal:not(.hidden)');
  }

  function createMessageDialog(options){
    const config = Object.assign({
      overlayId: '',
      overlay: null,
      defaultTitle: 'Dialog'
    }, options || {});

    const controller = createController({
      overlayId: config.overlayId,
      overlay: config.overlay
    });

    function fallbackOpen(openOptions){
      const message = openOptions.message || '';
      if (openOptions.secondaryLabel || openOptions.tertiaryLabel) {
        return global.confirm(message) ? 'primary' : 'secondary';
      }
      global.alert(message);
      return 'primary';
    }

    function open(openOptions){
      const opts = Object.assign({
        primaryLabel: 'Close',
        secondaryLabel: null,
        tertiaryLabel: null,
        primaryClass: 'primary',
        secondaryClass: 'ghost',
        tertiaryClass: 'ghost',
        focus: 'primaryBtn'
      }, openOptions || {});
      const title = hasOwn(opts, 'title') ? opts.title : config.defaultTitle;
      return controller.open({
        title: title || '',
        message: hasOwn(opts, 'message') ? (opts.message || '') : '',
        focus: opts.focus,
        dismissResult: hasOwn(opts, 'dismissResult')
          ? opts.dismissResult
          : function(){
              return opts.secondaryLabel ? 'secondary' : 'primary';
            },
        fallback: function(){
          return fallbackOpen(opts);
        },
        onOpen: function(state, api){
          api.setButton('primaryBtn', {
            visible: !!state.primaryBtn,
            label: opts.primaryLabel || 'OK',
            className: opts.primaryClass,
            result: 'primary'
          });
          api.setButton('secondaryBtn', {
            visible: !!opts.secondaryLabel,
            label: opts.secondaryLabel || '',
            className: opts.secondaryClass,
            result: 'secondary'
          });
          api.setButton('tertiaryBtn', {
            visible: !!opts.tertiaryLabel,
            label: opts.tertiaryLabel || '',
            className: opts.tertiaryClass,
            result: 'tertiary'
          });
        },
        onBeforeResolve: function(result, state, api){
          api.setButton('primaryBtn', { onClick: null });
          api.setButton('secondaryBtn', { onClick: null });
          api.setButton('tertiaryBtn', { onClick: null });
        }
      });
    }

    return {
      controller: controller,
      open: open,
      alert: function(title, message, options){
        const alertOptions = Object.assign({}, options || {}, {
          title: title,
          message: message,
          secondaryLabel: null
        });
        return open(alertOptions).then(function(){ return undefined; });
      },
      confirm: function(title, message, options){
        const confirmOptions = Object.assign({
          primaryLabel: 'Confirm',
          secondaryLabel: 'Cancel'
        }, options || {}, {
          title: title,
          message: message
        });
        return open(confirmOptions).then(function(result){
          return result === 'primary';
        });
      }
    };
  }

  function setInputAttribute(input, key, value){
    if (!input || !key) return;
    if (value === null || value === undefined || value === false) {
      input.removeAttribute(key);
      return;
    }
    input.setAttribute(key, String(value));
  }

  function createPromptDialog(options){
    const config = Object.assign({
      overlayId: '',
      overlay: null,
      defaultTitle: 'Prompt',
      selectors: {}
    }, options || {});

    const controller = createController({
      overlayId: config.overlayId,
      overlay: config.overlay,
      selectors: Object.assign({
        titleEl: '.ui-dialog__title',
        messageEl: '.ui-dialog__note',
        inputEl: '.ui-input',
        primaryBtn: '[data-role="primary"]',
        secondaryBtn: '[data-role="secondary"]'
      }, config.selectors || {})
    });

    function fallbackPrompt(promptOptions){
      const label = promptOptions.fallbackPrompt || promptOptions.title || promptOptions.message || config.defaultTitle || 'Prompt';
      const currentValue = promptOptions.value !== undefined && promptOptions.value !== null
        ? String(promptOptions.value)
        : '';
      const result = global.prompt(label, currentValue);
      return result === null ? null : String(result);
    }

    function prompt(promptOptions){
      const opts = Object.assign({
        primaryLabel: 'Confirm',
        secondaryLabel: 'Cancel',
        primaryClass: 'primary',
        secondaryClass: 'ghost',
        focus: 'inputEl',
        selectOnOpen: true,
        inputType: 'text',
        inputAttributes: null
      }, promptOptions || {});
      const title = hasOwn(opts, 'title') ? opts.title : config.defaultTitle;
      return controller.open({
        title: title || '',
        message: hasOwn(opts, 'message') ? (opts.message || '') : '',
        focus: opts.focus,
        dismissResult: hasOwn(opts, 'dismissResult') ? opts.dismissResult : 'secondary',
        fallback: function(){
          return fallbackPrompt(opts);
        },
        onOpen: function(state, api){
          api.setButton('primaryBtn', {
            visible: !!state.primaryBtn,
            label: opts.primaryLabel || 'Confirm',
            className: opts.primaryClass,
            result: 'primary'
          });
          api.setButton('secondaryBtn', {
            visible: opts.secondaryLabel !== false && opts.secondaryLabel !== null,
            label: opts.secondaryLabel || '',
            className: opts.secondaryClass,
            result: 'secondary'
          });
          if (!state.inputEl) return;
          setInputAttribute(state.inputEl, 'type', opts.inputType || 'text');
          if (opts.inputAttributes && typeof opts.inputAttributes === 'object') {
            Object.keys(opts.inputAttributes).forEach((key)=>{
              setInputAttribute(state.inputEl, key, opts.inputAttributes[key]);
            });
          }
          state.inputEl.value = opts.value !== undefined && opts.value !== null ? String(opts.value) : '';
          state.inputEl.onkeydown = function(event){
            if (event.key !== 'Enter') return;
            event.preventDefault();
            api.close('primary');
          };
          focusElement(state.inputEl);
          if (opts.selectOnOpen !== false && typeof state.inputEl.select === 'function') {
            try { state.inputEl.select(); } catch(_) {}
          }
        },
        onBeforeResolve: function(result, state, api){
          api.setButton('primaryBtn', { onClick: null });
          api.setButton('secondaryBtn', { onClick: null });
          if (state.inputEl) state.inputEl.onkeydown = null;
        }
      }).then(function(result){
        if (result !== 'primary') return null;
        const inputEl = controller.getElement('inputEl');
        return inputEl ? String(inputEl.value || '') : '';
      });
    }

    return {
      controller: controller,
      prompt: prompt
    };
  }

  function ensureGlobalMessageDialog(){
    if (globalMessageDialog) return globalMessageDialog;
    const overlay = createOverlayElement(
      'vrch-global-message-dialog',
      [
        '<div class="ui-modal__dialog" tabindex="-1">',
        '  <vrch-dialog-header icon="fa-circle-info" label="Notice"><h3 slot="title" class="ui-dialog__title"></h3></vrch-dialog-header>',
        '  <div class="ui-dialog__body">',
        '    <div class="ui-dialog__note"></div>',
        '    <div class="ui-dialog__actions">',
        '      <button type="button" class="ui-btn--md ui-btn--ghost" data-role="secondary">Cancel</button>',
        '      <button type="button" class="ui-btn--md hidden" data-role="tertiary">Other</button>',
        '      <button type="button" class="ui-btn--md is-confirm" data-role="primary">Close</button>',
        '    </div>',
        '  </div>',
        '  </div>',
      ].join('')
    );
    if (!overlay) return null;
    globalMessageDialog = createMessageDialog({
      overlay: overlay,
      defaultTitle: 'Notice'
    });
    return globalMessageDialog;
  }

  function ensureGlobalPromptDialog(){
    if (globalPromptDialog) return globalPromptDialog;
    const overlay = createOverlayElement(
      'vrch-global-prompt-dialog',
      [
        '<div class="ui-modal__dialog" tabindex="-1">',
        '  <vrch-dialog-header icon="fa-pen" label="Prompt"><h3 slot="title" class="ui-dialog__title"></h3></vrch-dialog-header>',
        '  <div class="ui-dialog__body">',
        '    <div class="ui-dialog__note"></div>',
        '    <input class="ui-input" type="text" autocomplete="off" />',
        '    <div class="ui-dialog__actions">',
        '      <button type="button" class="ui-btn--md ui-btn--ghost" data-role="secondary">Cancel</button>',
        '      <button type="button" class="ui-btn--md is-confirm" data-role="primary">Confirm</button>',
        '    </div>',
        '  </div>',
        '  </div>',
      ].join('')
    );
    if (!overlay) return null;
    globalPromptDialog = createPromptDialog({
      overlay: overlay,
      defaultTitle: 'Prompt'
    });
    return globalPromptDialog;
  }

  function alertDialog(title, message, options){
    const dialogOptions = normalizeDialogCall('Notice', title, message, options);
    const dialog = ensureGlobalMessageDialog();
    if (!dialog) {
      global.alert(dialogOptions.message || '');
      return Promise.resolve();
    }
    return dialog.alert(dialogOptions.title, dialogOptions.message, dialogOptions);
  }

  function confirmDialog(title, message, options){
    const dialogOptions = normalizeDialogCall('Confirm', title, message, options);
    const dialog = ensureGlobalMessageDialog();
    if (!dialog) {
      return Promise.resolve(global.confirm(dialogOptions.message || ''));
    }
    return dialog.confirm(dialogOptions.title, dialogOptions.message, Object.assign({
      primaryLabel: 'Confirm',
      secondaryLabel: 'Cancel'
    }, dialogOptions));
  }

  function promptDialog(title, message, options){
    const dialogOptions = normalizeDialogCall('Prompt', title, message, options);
    const dialog = ensureGlobalPromptDialog();
    if (!dialog) {
      const fallbackLabel = dialogOptions.message || dialogOptions.title || 'Prompt';
      const currentValue = dialogOptions.value !== undefined && dialogOptions.value !== null
        ? String(dialogOptions.value)
        : '';
      const result = global.prompt(fallbackLabel, currentValue);
      return Promise.resolve(result === null ? null : String(result));
    }
    return dialog.prompt(dialogOptions);
  }

  global.VrchDialogs = {
    createHeader: createHeader,
    setHeader: renderHeader,
    createShell: createShell,
    connectShell: connectShell,
    alert: alertDialog,
    confirm: confirmDialog,
    prompt: promptDialog,
    hasOpenDialog: hasOpenDialog,
    createController: createController,
    createMessageDialog: createMessageDialog,
    createPromptDialog: createPromptDialog
  };
})(window);
