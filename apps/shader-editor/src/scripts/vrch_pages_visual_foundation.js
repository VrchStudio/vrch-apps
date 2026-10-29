(function(root, factory) {
    const api = factory(root && root.document ? root.document : null);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.VrchPagesVisualFoundation = api;
})(typeof window !== 'undefined' ? window : globalThis, function(documentRef) {
    'use strict';

    const CONFIRM_SELECTOR = [
        '[data-ui-confirm]',
        '.ui-btn--sm.is-confirm:not(.is-danger)',
        '.ui-btn--md.is-confirm:not(.is-danger)',
        '.ui-send-action:not(.is-danger)'
    ].join(',');
    const HORIZONTAL_RANGE_SELECTOR = 'input[type="range"]:not(.ui-range--vertical):not([orient="vertical"])';

    function removeBrackets(button) {
        button.querySelectorAll('.ui-confirm-bracket').forEach(node => node.remove());
        button.removeAttribute('data-ui-confirm-enhanced');
    }

    function syncConfirmButton(button) {
        if (!button || button.nodeType !== 1) return false;
        const matches = typeof button.matches === 'function' && button.matches(CONFIRM_SELECTOR);
        if (button.hasAttribute('data-ui-confirm-enhanced') || button.querySelector('.ui-confirm-bracket')) removeBrackets(button);
        return matches;
    }

    function syncRangeProgress(input) {
        if (!input || input.nodeType !== 1 || typeof input.matches !== 'function') return false;
        if (!input.matches(HORIZONTAL_RANGE_SELECTOR)) {
            if (input.style) input.style.removeProperty('--vrch-range-progress');
            return false;
        }
        const min = Number(input.min === '' ? 0 : input.min);
        const max = Number(input.max === '' ? 100 : input.max);
        const value = Number(input.value);
        const span = max - min;
        const ratio = Number.isFinite(value) && Number.isFinite(min) && Number.isFinite(max) && span > 0
            ? Math.min(1, Math.max(0, (value - min) / span))
            : 0;
        const percent = Math.round(ratio * 100000) / 1000;
        input.style.setProperty('--vrch-range-progress', `${percent}%`);
        return true;
    }

    function enhance(rootNode) {
        const scope = rootNode && typeof rootNode.querySelectorAll === 'function' ? rootNode : documentRef;
        if (!scope) return 0;
        let count = 0;
        if (scope.nodeType === 1 && syncConfirmButton(scope)) count += 1;
        scope.querySelectorAll(CONFIRM_SELECTOR).forEach(button => {
            if (syncConfirmButton(button)) count += 1;
        });
        if (scope.nodeType === 1 && syncRangeProgress(scope)) count += 1;
        scope.querySelectorAll(HORIZONTAL_RANGE_SELECTOR).forEach(input => {
            if (syncRangeProgress(input)) count += 1;
        });
        return count;
    }

    function observe() {
        if (!documentRef || !documentRef.documentElement || typeof MutationObserver !== 'function') return null;
        enhance(documentRef);
        const observer = new MutationObserver(records => {
            records.forEach(record => {
                if (record.type === 'attributes') {
                    syncConfirmButton(record.target);
                    syncRangeProgress(record.target);
                    return;
                }
                if (record.target && record.target.nodeType === 1) {
                    syncConfirmButton(record.target);
                    syncRangeProgress(record.target);
                }
                record.addedNodes.forEach(node => {
                    if (node && node.nodeType === 1) enhance(node);
                });
            });
        });
        observer.observe(documentRef.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['class', 'data-ui-confirm', 'type', 'orient', 'min', 'max', 'value']
        });
        return observer;
    }

    function installRangeProgressEvents() {
        if (!documentRef || documentRef.__vrchSharedRangeProgressInstalled) return false;
        documentRef.__vrchSharedRangeProgressInstalled = true;
        const syncEventTarget = event => syncRangeProgress(event.target);
        documentRef.addEventListener('input', syncEventTarget, true);
        documentRef.addEventListener('change', syncEventTarget, true);
        documentRef.addEventListener('reset', event => {
            const form = event.target;
            setTimeout(() => enhance(form), 0);
        }, true);
        return true;
    }

    function installTabKeyboard() {
        if (!documentRef || documentRef.__vrchSharedTabKeyboardInstalled) return false;
        documentRef.__vrchSharedTabKeyboardInstalled = true;
        documentRef.addEventListener('keydown', event => {
            if (event.defaultPrevented || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            const tab = event.target && typeof event.target.closest === 'function'
                ? event.target.closest('.ui-tabs[role="tablist"] [role="tab"]')
                : null;
            if (!tab) return;
            const tablist = tab.closest('.ui-tabs[role="tablist"]');
            if (!tablist) return;
            const vertical = tablist.getAttribute('aria-orientation') === 'vertical' || tablist.classList.contains('ui-tabs--vertical');
            if (vertical && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;
            if (!vertical && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) return;
            const tabs = Array.from(tablist.querySelectorAll(':scope > [role="tab"]'))
                .filter(item => !item.hidden && !item.disabled && item.getAttribute('aria-disabled') !== 'true');
            const index = tabs.indexOf(tab);
            if (index < 0 || tabs.length < 2) return;
            let nextIndex = index;
            if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
            if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
            if (event.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
            if (event.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
            if (event.key === 'Home') nextIndex = 0;
            if (event.key === 'End') nextIndex = tabs.length - 1;
            event.preventDefault();
            tabs[nextIndex].focus();
            tabs[nextIndex].click();
        });
        return true;
    }

    // Shared edge retraction for independently controlled Console bars.
    const barMotion = new WeakMap();
    function setBarVisible(element, visible, { edge = 'bottom' } = {}) {
        if (!element) return;
        const view = element.ownerDocument?.defaultView;
        const previous = barMotion.get(element);
        if (previous?.visible === visible) return;
        const margin = edge === 'top' ? 'marginTop' : 'marginBottom';
        const fromMargin = previous?.animation ? parseFloat(view.getComputedStyle(element)[margin]) : null;
        previous?.animation?.cancel();
        const state = { visible, animation: null };
        barMotion.set(element, state);
        element.inert = !visible;
        element.setAttribute('aria-hidden', String(!visible));
        const original = previous?.original || { display: element.style.display, margin: element.style[margin], clipPath: element.style.clipPath };
        state.original = original;
        const finish = () => {
            if (barMotion.get(element) !== state) return;
            element.classList.toggle('is-hidden', !visible);
            element.style.display = original.display;
            element.style[margin] = original.margin;
            element.style.clipPath = original.clipPath;
            state.animation?.cancel(); state.animation = null;
            element.inert = !visible;
        };
        if (!previous || !element.animate || view.matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
        element.classList.remove('is-hidden');
        // Keep the bar's own layout (compact Status Bar uses a five-column grid).
        element.style.display = original.display;
        element.style.display = view.getComputedStyle(element).display;
        element.style[margin] = original.margin;
        const height = element.offsetHeight;
        const from = fromMargin === null ? (previous.visible ? 0 : -height) : fromMargin;
        const to = visible ? 0 : -height;
        element.classList.toggle('is-hidden', !visible);
        if (!height || from === to) { finish(); return; }
        element.inert = true;
        const frame = value => ({ [margin]: `${value}px`, clipPath: edge === 'top' ? `inset(${-value}px 0 0)` : `inset(0 0 ${-value}px)` });
        state.animation = element.animate([frame(from), frame(to)], { duration: 160 * Math.min(1, Math.abs(to - from) / height), easing: 'ease-out', fill: 'both' });
        state.animation.onfinish = finish;
    }

    if (documentRef) {
        if (documentRef.readyState === 'loading') {
            documentRef.addEventListener('DOMContentLoaded', () => {
                observe();
                installTabKeyboard();
                installRangeProgressEvents();
            }, { once: true });
        } else {
            observe();
            installTabKeyboard();
            installRangeProgressEvents();
        }
    }

    return {
        setBarVisible,
        CONFIRM_SELECTOR,
        HORIZONTAL_RANGE_SELECTOR,
        enhance,
        syncConfirmButton,
        syncRangeProgress,
        installRangeProgressEvents,
        installTabKeyboard
    };
});
