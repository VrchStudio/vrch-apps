(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.VrchPagesLiveConsoleActionPopover = api;
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function() {
    'use strict';

    function createActionPopoverController({
        document: documentRef = null,
        window: windowRef = null
    } = {}) {
        let state = null;

        function close({ restoreFocus = false, anchorWithin = null } = {}) {
            if (!state) return false;
            const current = state;
            // Renderers that own one section may refresh asynchronously while
            // another settings control is open. A scoped close keeps that
            // unrelated control alive and only dismisses popovers anchored in
            // the subtree being replaced.
            if (anchorWithin
                && (!current.anchorEl
                    || typeof anchorWithin.contains !== 'function'
                    || !anchorWithin.contains(current.anchorEl))) {
                return false;
            }
            if (current.anchorEl) current.anchorEl.setAttribute('aria-expanded', 'false');
            if (current.popoverEl && current.popoverEl.parentNode) {
                current.popoverEl.parentNode.removeChild(current.popoverEl);
            }
            if (documentRef) {
                documentRef.removeEventListener('pointerdown', current.onPointerDown, true);
                documentRef.removeEventListener('keydown', current.onKeyDown, true);
            }
            if (windowRef) {
                windowRef.removeEventListener('resize', current.onReposition, true);
                windowRef.removeEventListener('scroll', current.onReposition, true);
                if (windowRef.visualViewport) {
                    windowRef.visualViewport.removeEventListener('resize', current.onReposition);
                    windowRef.visualViewport.removeEventListener('scroll', current.onReposition);
                }
            }
            state = null;
            if (restoreFocus && current.anchorEl && typeof current.anchorEl.focus === 'function') {
                current.anchorEl.focus({ preventScroll: true });
            }
            return true;
        }

        function position() {
            if (!state || !state.anchorEl || !state.popoverEl || !windowRef) return false;
            const anchorRect = state.anchorEl.getBoundingClientRect();
            const viewport = windowRef.visualViewport;
            const viewportLeft = viewport ? viewport.offsetLeft : 0;
            const viewportTop = viewport ? viewport.offsetTop : 0;
            const viewportWidth = viewport ? viewport.width : windowRef.innerWidth;
            const viewportHeight = viewport ? viewport.height : windowRef.innerHeight;
            const margin = 8;
            const gap = 4;
            const minWidth = Math.max(anchorRect.width, state.minWidth || 160);
            const maxWidth = Math.max(160, viewportWidth - margin * 2);
            const targetWidth = state.matchWidth
                ? Math.min(Math.max(anchorRect.width, state.minWidth || 0), maxWidth)
                : Math.min(minWidth, maxWidth);
            state.popoverEl.style.width = state.matchWidth ? `${targetWidth}px` : '';
            state.popoverEl.style.minWidth = `${targetWidth}px`;
            state.popoverEl.style.maxWidth = `${maxWidth}px`;
            if (state.scrollable) state.popoverEl.style.maxHeight = `${Math.max(0, viewportHeight - margin * 2)}px`;
            state.popoverEl.style.left = '0px';
            state.popoverEl.style.top = '0px';
            const popoverRect = state.popoverEl.getBoundingClientRect();
            const popoverWidth = state.matchWidth ? targetWidth : Math.min(popoverRect.width, maxWidth);
            const popoverHeight = popoverRect.height;
            const minLeft = viewportLeft + margin;
            const maxLeft = viewportLeft + viewportWidth - popoverWidth - margin;
            const preferredLeft = state.align === 'right'
                ? anchorRect.right - popoverWidth
                : anchorRect.left;
            const left = Math.max(minLeft, Math.min(preferredLeft, maxLeft));
            const belowTop = anchorRect.bottom + gap;
            const aboveTop = anchorRect.top - popoverHeight - gap;
            const maxTop = viewportTop + viewportHeight - popoverHeight - margin;
            const belowFits = belowTop + popoverHeight <= viewportTop + viewportHeight - margin;
            const top = belowFits ? belowTop : Math.max(viewportTop + margin, Math.min(aboveTop, maxTop));
            state.popoverEl.style.left = `${left}px`;
            state.popoverEl.style.top = `${top}px`;
            return true;
        }

        function getEnabledMenuItems() {
            if (!state || !state.popoverEl) return [];
            return Array.from(state.popoverEl.children || []).filter(item => {
                return item
                    && item.getAttribute
                    && ['menuitem', 'menuitemcheckbox'].includes(item.getAttribute('role'))
                    && !item.disabled;
            });
        }

        function focusMenuItem(item) {
            if (!item || typeof item.focus !== 'function') return false;
            item.focus({ preventScroll: true });
            if (state && state.scrollable && typeof item.scrollIntoView === 'function') item.scrollIntoView({ block: 'nearest' });
            return true;
        }

        function open(anchorEl, items, options = {}) {
            if (!documentRef || !windowRef || !anchorEl || !Array.isArray(items) || !items.length) return false;
            if (state && state.anchorEl === anchorEl) {
                close({ restoreFocus: true });
                return false;
            }
            close();
            const popoverEl = documentRef.createElement('div');
            popoverEl.className = `ui-action-popover${options.scrollable ? ' ui-action-popover--scrollable' : ''}${options.className ? ` ${options.className}` : ''}`;
            popoverEl.setAttribute('role', 'menu');
            if (options.collections) {
                const nav = documentRef.createElement('nav');
                nav.className = 'ui-tabs ui-tabs--navigation ui-tabs--edge ui-tabs--equal ui-action-popover__collections';
                nav.setAttribute('aria-label', 'Visual collections');
                options.collections.forEach(collection => {
                    const tab = documentRef.createElement('button');
                    tab.type = 'button'; tab.className = 'ui-tab';
                    tab.dataset.collection = collection.id; tab.textContent = collection.label;
                    tab.classList.toggle('is-active', collection.id === options.collection);
                    tab.setAttribute('aria-pressed', String(collection.id === options.collection));
                    tab.addEventListener('click', () => options.onCollection(collection.id));
                    nav.appendChild(tab);
                });
                if (options.closeLabel) {
                    const dismiss = documentRef.createElement('button');
                    dismiss.type = 'button'; dismiss.className = 'ui-dialog__close';
                    dismiss.setAttribute('aria-label', options.closeLabel);
                    const icon = documentRef.createElement('i');
                    icon.className = 'fas fa-xmark'; icon.setAttribute('aria-hidden', 'true');
                    dismiss.appendChild(icon);
                    dismiss.onclick = () => close({ restoreFocus: true });
                    nav.appendChild(dismiss);
                }
                popoverEl.appendChild(nav);
            }
            items.forEach((item) => {
                const itemId = String(item && item.id || '').trim();
                const itemBtn = documentRef.createElement('button');
                itemBtn.type = 'button';
                itemBtn.className = 'ui-action-popover__item';
                const checkable = item && typeof item.checked === 'boolean';
                const current = checkable ? item.checked : item && item.current;
                if (current) itemBtn.classList.add('is-current');
                if (item && item.disabled) itemBtn.classList.add('is-disabled');
                itemBtn.setAttribute('role', checkable ? 'menuitemcheckbox' : 'menuitem');
                if (checkable) itemBtn.setAttribute('aria-checked', String(item.checked));
                itemBtn.dataset.itemId = itemId;
                itemBtn.disabled = !!(item && item.disabled);
                if (item && item.thumbnail) {
                    const image = documentRef.createElement('img');
                    image.className = 'ui-action-popover__item-thumbnail';
                    image.src = item.thumbnail; image.alt = ''; image.loading = 'lazy';
                    itemBtn.classList.add('ui-action-popover__item--media');
                    itemBtn.title = String(item.label || '');
                    itemBtn.appendChild(image);
                }

                const labelEl = documentRef.createElement('span');
                labelEl.className = 'ui-action-popover__item-label';
                const hasExplicitLabel = item && Object.prototype.hasOwnProperty.call(item, 'label');
                const labelText = hasExplicitLabel ? String(item.label || '') : (itemId || 'Option');
                if (labelText) labelEl.appendChild(documentRef.createTextNode(labelText));
                const labelIconClass = String(item && item.labelIconClass || '').trim();
                const labelSuffix = String(item && item.labelSuffix || '').trim();
                if (labelIconClass || labelSuffix) {
                    const labelTargetEl = documentRef.createElement('span');
                    labelTargetEl.className = 'ui-action-popover__item-label-target';
                    if (labelIconClass) {
                        const labelIconEl = documentRef.createElement('i');
                        labelIconEl.className = `fas ${labelIconClass}`;
                        labelIconEl.setAttribute('aria-hidden', 'true');
                        labelTargetEl.appendChild(labelIconEl);
                    }
                    if (labelSuffix) labelTargetEl.appendChild(documentRef.createTextNode(labelSuffix));
                    labelEl.appendChild(labelTargetEl);
                }
                if (item && item.description) {
                    labelEl.classList.add('ui-action-popover__item-label--described');
                    const description = documentRef.createElement('span');
                    description.className = 'ui-action-popover__item-description';
                    description.textContent = String(item.description);
                    labelEl.appendChild(description);
                }
                itemBtn.appendChild(labelEl);
                if (item && item.meta && item.meta.childElementCount) {
                    const meta = documentRef.createElement('span');
                    meta.className = 'ui-action-popover__item-meta';
                    meta.appendChild(item.meta); itemBtn.appendChild(meta);
                }

                const badgeText = String(item && item.badge || '').trim();
                const shouldHideCurrentBadge = !!(item && item.current) && badgeText.toLowerCase() === 'current';
                if (badgeText && !shouldHideCurrentBadge) {
                    const badgeEl = documentRef.createElement('span');
                    badgeEl.className = 'ui-action-popover__item-badge';
                    const badgeIconClass = String(item && item.badgeIconClass || '').trim();
                    if (badgeIconClass) {
                        const badgeIconEl = documentRef.createElement('i');
                        badgeIconEl.className = `fas ${badgeIconClass}`;
                        badgeIconEl.setAttribute('aria-hidden', 'true');
                        badgeEl.appendChild(badgeIconEl);
                    }
                    badgeEl.appendChild(documentRef.createTextNode(badgeText));
                    itemBtn.appendChild(badgeEl);
                }
                const currentIconClass = String(item && item.currentIconClass || (current || checkable ? 'fa-check' : '') || '').trim();
                const currentSlotEl = documentRef.createElement('span');
                currentSlotEl.className = 'ui-action-popover__item-current-icon';
                currentSlotEl.setAttribute('aria-hidden', 'true');
                if (checkable) currentSlotEl.hidden = !item.checked;
                if (currentIconClass) {
                    const currentIconEl = documentRef.createElement('i');
                    currentIconEl.className = `fas ${currentIconClass}`;
                    currentSlotEl.appendChild(currentIconEl);
                }
                itemBtn.appendChild(currentSlotEl);

                itemBtn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (checkable) {
                        item.checked = !item.checked;
                        itemBtn.setAttribute('aria-checked', String(item.checked));
                        itemBtn.classList.toggle('is-current', item.checked);
                        currentSlotEl.hidden = !item.checked;
                    }
                    if (!(checkable || item && item.keepOpen)) close({ restoreFocus: true });
                    if (typeof options.onSelect === 'function') options.onSelect(item, itemBtn);
                });
                popoverEl.appendChild(itemBtn);
            });

            const onPointerDown = (ev) => {
                const target = ev.target;
                if (target && (popoverEl.contains(target) || anchorEl.contains(target))) return;
                close();
            };
            const onKeyDown = (ev) => {
                if (ev.key === 'Escape') {
                    ev.preventDefault();
                    close({ restoreFocus: true });
                    return;
                }
                const grid = options.columns === 2;
                if (!(grid ? ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'] : ['ArrowDown', 'ArrowUp', 'Home', 'End']).includes(ev.key)) return;
                const enabledItems = getEnabledMenuItems();
                if (!enabledItems.length) return;
                const currentIndex = enabledItems.indexOf(documentRef.activeElement);
                let nextIndex = 0;
                if (ev.key === 'End') nextIndex = enabledItems.length - 1;
                else if (ev.key === 'ArrowUp') nextIndex = currentIndex <= 0 ? enabledItems.length - 1 : currentIndex - 1;
                else if (ev.key === 'ArrowDown') nextIndex = currentIndex < 0 || currentIndex === enabledItems.length - 1 ? 0 : currentIndex + 1;
                if (grid && ev.key.startsWith('Arrow')) {
                    const step = ev.key === 'ArrowDown' ? 2 : ev.key === 'ArrowUp' ? -2 : ev.key === 'ArrowRight' ? 1 : -1;
                    nextIndex = Math.max(0, Math.min(enabledItems.length - 1, currentIndex + step));
                }
                ev.preventDefault();
                ev.stopPropagation();
                focusMenuItem(enabledItems[nextIndex]);
            };
            const onReposition = () => position();
            if (options.closeLabel) {
                popoverEl.classList.add('ui-action-popover--with-close');
                const footer = documentRef.createElement('footer');
                footer.className = 'ui-dialog__actions ui-action-popover__actions';
                const dismiss = documentRef.createElement('button');
                dismiss.type = 'button'; dismiss.className = 'ui-btn--md ui-dialog-action ui-btn--fixed-label';
                dismiss.textContent = 'Close'; dismiss.onclick = () => close({ restoreFocus: true });
                footer.appendChild(dismiss); popoverEl.appendChild(footer);
            }
            documentRef.body.appendChild(popoverEl);
            state = {
                anchorEl,
                popoverEl,
                minWidth: Number(options.minWidth || 0) || 160,
                matchWidth: !!options.matchWidth,
                scrollable: !!options.scrollable,
                align: options.align || 'right',
                onPointerDown,
                onKeyDown,
                onReposition
            };
            anchorEl.setAttribute('aria-expanded', 'true');
            documentRef.addEventListener('pointerdown', onPointerDown, true);
            documentRef.addEventListener('keydown', onKeyDown, true);
            windowRef.addEventListener('resize', onReposition, true);
            windowRef.addEventListener('scroll', onReposition, true);
            if (windowRef.visualViewport) {
                windowRef.visualViewport.addEventListener('resize', onReposition);
                windowRef.visualViewport.addEventListener('scroll', onReposition);
            }
            position();
            const enabledItems = getEnabledMenuItems();
            const currentItem = enabledItems.find(item => item.classList && item.classList.contains('is-current'));
            focusMenuItem(currentItem || enabledItems[0]);
            return true;
        }

        return {
            open,
            close,
            position,
            isOpen: () => !!state,
            getState: () => state
        };
    }

    return {
        createActionPopoverController
    };
});
