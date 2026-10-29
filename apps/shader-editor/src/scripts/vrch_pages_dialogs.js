(function(global){
  'use strict';

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
        '  <div class="ui-dialog__header">',
        '    <h3 class="ui-dialog__title"></h3>',
        '  </div>',
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
        '  <div class="ui-dialog__header">',
        '    <h3 class="ui-dialog__title"></h3>',
        '  </div>',
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
    alert: alertDialog,
    confirm: confirmDialog,
    prompt: promptDialog,
    hasOpenDialog: hasOpenDialog,
    createController: createController,
    createMessageDialog: createMessageDialog,
    createPromptDialog: createPromptDialog
  };
})(window);
