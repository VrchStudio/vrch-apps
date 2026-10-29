/* VRCH Scene logical Source 0/1 to physical Source A/B binding. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VrchSceneSourceBinding = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  'use strict';

  const PHYSICAL_SLOTS = Object.freeze(['A', 'B']);
  const DEFAULT_BINDINGS = Object.freeze({ 0: 'A', 1: 'B' });

  function normalizeSlot(value, fallback) {
    const slot = String(value || '').toUpperCase();
    return PHYSICAL_SLOTS.includes(slot) ? slot : fallback;
  }

  function normalizeChannel(value, fallback) {
    const channel = String(value == null ? '' : value).trim();
    return /^[1-8]$/.test(channel) ? channel : String(fallback || '2');
  }

  function createState(value) {
    const source = value || {};
    const bindings = source.source_bindings || source.bindings || source;
    return {
      source_bindings: {
        0: normalizeSlot(bindings[0] == null ? bindings['0'] : bindings[0], DEFAULT_BINDINGS[0]),
        1: normalizeSlot(bindings[1] == null ? bindings['1'] : bindings[1], DEFAULT_BINDINGS[1])
      },
      source_a_channel: normalizeChannel(source.source_a_channel, '1'),
      source_b_channel: normalizeChannel(source.source_b_channel, '2'),
      revision: Math.max(0, Number.isInteger(source.revision) ? source.revision : 0)
    };
  }

  function patchState(current, patch) {
    const before = createState(current);
    const change = patch || {};
    const requestedBindings = change.source_bindings || change.bindings || {};
    const next = createState({
      source_bindings: {
        0: Object.prototype.hasOwnProperty.call(requestedBindings, '0') ? requestedBindings['0'] : before.source_bindings[0],
        1: Object.prototype.hasOwnProperty.call(requestedBindings, '1') ? requestedBindings['1'] : before.source_bindings[1]
      },
      source_a_channel: Object.prototype.hasOwnProperty.call(change, 'source_a_channel') ? change.source_a_channel : before.source_a_channel,
      source_b_channel: Object.prototype.hasOwnProperty.call(change, 'source_b_channel') ? change.source_b_channel : before.source_b_channel,
      revision: before.revision
    });
    const changed = next.source_bindings[0] !== before.source_bindings[0] ||
      next.source_bindings[1] !== before.source_bindings[1] ||
      next.source_a_channel !== before.source_a_channel ||
      next.source_b_channel !== before.source_b_channel;
    next.revision = changed ? before.revision + 1 : before.revision;
    return { state: next, changed: changed };
  }

  function resolve(state, physicalSources) {
    const normalized = createState(state);
    const sources = physicalSources || {};
    return [
      sources[normalized.source_bindings[0]] || null,
      sources[normalized.source_bindings[1]] || null
    ];
  }

  function swap(state) {
    const current = createState(state);
    return patchState(current, {
      source_bindings: { 0: current.source_bindings[1], 1: current.source_bindings[0] }
    });
  }

  function swapChannels(state) {
    const current = createState(state);
    return patchState(current, {
      source_a_channel: current.source_b_channel,
      source_b_channel: current.source_a_channel
    });
  }

  return Object.freeze({
    PHYSICAL_SLOTS: PHYSICAL_SLOTS,
    DEFAULT_BINDINGS: DEFAULT_BINDINGS,
    normalizeSlot: normalizeSlot,
    normalizeChannel: normalizeChannel,
    createState: createState,
    patchState: patchState,
    resolve: resolve,
    swap: swap,
    swapChannels: swapChannels
  });
});
