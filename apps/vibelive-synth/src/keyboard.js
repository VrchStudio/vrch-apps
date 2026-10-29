// On-screen keyboard for the vibe box.
//
// The device is touch-only (a USB keyboard is optional), so the App carries
// its own keyboard instead of relying on an OS one (`inputmode="none"` keeps
// any system keyboard away while a physical keyboard still types normally).
// Keys are flex units, rows share the height left over in the App, so the same
// layout fits 480x432 (VibeCtrl bars shown) and 480x480 (bars hidden) without
// reloading. Every key acts on pointerdown with preventDefault, which keeps
// focus and the caret in the input and also works with the Apps host's
// synthetic touch (it delivers PointerEvents only, never click).
'use strict';
(() => {
  const VOCAB = [
    // genres / styles
    'lo-fi', 'synthwave', 'techno', 'minimal techno', 'house', 'deep house', 'ambient', 'jazz', 'boom bap',
    'trap', 'drum and bass', 'dub', 'dubstep', 'afrobeat', 'funk', 'disco', 'garage', 'breakbeat', 'downtempo',
    'chillwave', 'vaporwave', 'hip hop', 'cinematic', 'soul', 'gospel', 'reggae', 'bossa nova', 'industrial',
    // instruments / parts
    'piano', 'rhodes', 'organ', 'strings', 'choir', 'bells', 'marimba', 'kalimba', 'guitar', 'bass guitar',
    'sub bass', '808', 'kick', 'snare', 'hi-hats', 'claps', 'shaker', 'congas', 'tabla', 'saxophone', 'trumpet',
    'horns', 'flute', 'synth pad', 'arpeggio', 'pluck', 'lead synth', 'bassline', 'vocal chops', 'drums',
    'percussion', 'drum machine', 'breakbeat drums',
    // textures / moods
    'warm', 'dusty', 'vinyl crackle', 'tape hiss', 'tape', 'rainy', 'dreamy', 'dark', 'driving', 'mellow',
    'uplifting', 'punchy', 'crisp', 'deep', 'airy', 'glitchy', 'lush', 'analog', 'night', 'sunrise', 'ocean',
    'rain', 'reverb', 'delay', 'distorted', 'soft', 'rolling', 'groovy', 'hypnotic', 'nostalgic', 'with', 'and',
  ];
  const FOLLOW_UPS = ['with', 'drums', 'bass', 'synth pad', 'vinyl crackle', 'reverb'];
  const LAYERS = {
    abc: [
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
      [{gap: 0.5}, 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', {gap: 0.5}],
      [{act: 'shift', label: '⇧', w: 1.5}, 'z', 'x', 'c', 'v', 'b', 'n', 'm', {act: 'back', label: '⌫', w: 1.5}],
      [{act: 'layer', to: 'sym', label: '?123', w: 1.5}, ',', {act: 'space', label: 'space', w: 4.5}, '.',
       {act: 'enter', label: 'send ↵', w: 2}],
    ],
    sym: [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
      ['-', '/', ':', ';', '(', ')', '&', '@', '"', "'"],
      ['_', '?', '!', '#', '%', '+', '=', '*', {act: 'back', label: '⌫', w: 2}],
      [{act: 'layer', to: 'abc', label: 'ABC', w: 1.5}, ',', {act: 'space', label: 'space', w: 4.5}, '.',
       {act: 'enter', label: 'send ↵', w: 2}],
    ],
  };
  const REPEAT_DELAY = 420, REPEAT_EVERY = 60, CAPS_TAP = 350;

  function createKeyboard({input, host, presets = [], onSubmit, onToggle}) {
    let layer = 'abc', shift = false, caps = false, lastShiftAt = 0, open = false;
    let repeatTimer = 0, popTimer = 0;
    const max = Number(input.maxLength) > 0 ? Number(input.maxLength) : 200;

    host.innerHTML = '<div class="kb-suggest"><div class="kb-chips"></div>' +
      '<button type="button" class="kb-close" aria-label="hide keyboard">✕</button></div>' +
      '<div class="kb-rows"></div><div class="kb-pop hidden"></div>';
    const chipsEl = host.querySelector('.kb-chips');
    const rowsEl = host.querySelector('.kb-rows');
    const popEl = host.querySelector('.kb-pop');

    // ── text editing at the caret ──
    function caret() {
      const s = input.selectionStart ?? input.value.length;
      const e = input.selectionEnd ?? s;
      return [s, e];
    }
    function changed() {
      // setRangeText fires no input event; announce the edit (this also refreshes
      // the suggestion strip through the listener below).
      input.dispatchEvent(new Event('input', {bubbles: true}));
    }
    function insert(text) {
      const [s, e] = caret();
      const room = max - (input.value.length - (e - s));
      if (room <= 0) return;
      input.setRangeText(text.slice(0, room), s, e, 'end');
      changed();
    }
    function backspace() {
      const [s, e] = caret();
      if (s !== e) input.setRangeText('', s, e, 'end');
      else if (s > 0) input.setRangeText('', s - 1, s, 'end');
      else return;
      changed();
    }
    function fragment() {
      const [s] = caret();
      const before = input.value.slice(0, s);
      const m = before.match(/[^\s,]*$/);
      return {text: m ? m[0] : '', start: s - (m ? m[0].length : 0), end: s};
    }

    // ── suggestion strip ──
    function suggest() {
      const frag = fragment();
      const f = frag.text.toLowerCase();
      let items;
      if (!input.value.trim()) {
        items = presets.map((p) => ({label: p, fill: p}));
      } else if (!f) {
        items = FOLLOW_UPS.map((w) => ({label: w, word: w}));
      } else {
        const head = VOCAB.filter((w) => w.startsWith(f) && w !== f);
        const inner = VOCAB.filter((w) => !w.startsWith(f) && w.split(/[\s-]/).some((p) => p.startsWith(f)));
        items = head.concat(inner).slice(0, 6).map((w) => ({label: w, word: w, frag}));
      }
      chipsEl.innerHTML = '';
      chipsEl.scrollLeft = 0;
      for (const it of items.slice(0, 6)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'kb-chip' + (it.fill ? ' preset' : '');
        b.textContent = it.label;
        // The strip scrolls sideways, so a chip fires on release, and only if the
        // finger did not travel (a swipe arrives as pointercancel or a long move).
        let x0 = null;
        b.addEventListener('pointerdown', (ev) => { ev.preventDefault(); x0 = ev.clientX; b.classList.add('down'); });
        b.addEventListener('pointercancel', () => { x0 = null; b.classList.remove('down'); });
        b.addEventListener('pointerleave', () => { x0 = null; b.classList.remove('down'); });
        b.addEventListener('pointerup', (ev) => {
          b.classList.remove('down');
          if (x0 === null || Math.abs(ev.clientX - x0) > 8) { x0 = null; return; }
          x0 = null;
          if (it.fill) {
            input.value = it.fill.slice(0, max);
            input.setSelectionRange(input.value.length, input.value.length);
          } else {
            const fr = it.frag || {start: caret()[0], end: caret()[0]};
            const lead = fr.start > 0 && !/[\s,]$/.test(input.value.slice(0, fr.start)) ? ' ' : '';
            input.setRangeText(lead + it.word + ' ', fr.start, fr.end, 'end');
          }
          input.focus();
          changed();
        });
        chipsEl.appendChild(b);
      }
    }

    // ── key rendering ──
    function keyLabel(k) {
      if (typeof k !== 'string') return k.label;
      return (shift || caps) && layer === 'abc' ? k.toUpperCase() : k;
    }
    function build() {
      rowsEl.innerHTML = '';
      for (const row of LAYERS[layer]) {
        const r = document.createElement('div');
        r.className = 'kb-row';
        for (const k of row) {
          if (k.gap) {
            const g = document.createElement('span');
            g.className = 'kb-gap';
            g.style.flexGrow = k.gap;
            r.appendChild(g);
            continue;
          }
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'kb-key' + (typeof k === 'string' ? ' char' : ' fn ' + k.act);
          if (k.act === 'shift' && (shift || caps)) b.classList.add('on');
          if (k.act === 'shift' && caps) b.classList.add('caps');
          b.style.flexGrow = (typeof k === 'string' ? 1 : k.w || 1);
          b.textContent = keyLabel(k);
          wireKey(b, k);
          r.appendChild(b);
        }
        rowsEl.appendChild(r);
      }
    }
    function showPop(btn, text) {
      const kr = btn.getBoundingClientRect(), hr = host.getBoundingClientRect();
      popEl.textContent = text;
      popEl.style.left = (kr.left - hr.left + kr.width / 2) + 'px';
      popEl.style.top = (kr.top - hr.top) + 'px';
      popEl.classList.remove('hidden');
      clearTimeout(popTimer);
    }
    function hidePop() {
      clearTimeout(popTimer);
      popTimer = setTimeout(() => popEl.classList.add('hidden'), 90);
    }
    function stopRepeat() {
      clearTimeout(repeatTimer);
      clearInterval(repeatTimer);
      repeatTimer = 0;
    }
    function press(k) {
      if (typeof k === 'string') {
        insert(keyLabel(k));
        if (shift && !caps) { shift = false; build(); }
        return;
      }
      switch (k.act) {
        case 'space': insert(' '); break;
        case 'back': backspace(); break;
        case 'enter': onSubmit && onSubmit(); break;
        case 'layer': layer = k.to; shift = false; build(); break;
        case 'shift': {
          const t = performance.now();
          if (caps) { caps = false; shift = false; }
          else if (shift && t - lastShiftAt < CAPS_TAP) { caps = true; }
          else { shift = !shift; }
          lastShiftAt = t;
          build();
          break;
        }
      }
    }
    function wireKey(btn, k) {
      btn.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        if (document.activeElement !== input) input.focus();
        btn.classList.add('down');
        if (typeof k === 'string') showPop(btn, keyLabel(k));
        press(k);
        if (k.act === 'back') {
          stopRepeat();
          repeatTimer = setTimeout(() => { repeatTimer = setInterval(backspace, REPEAT_EVERY); }, REPEAT_DELAY);
        }
      });
      const up = () => { btn.classList.remove('down'); hidePop(); if (k.act === 'back') stopRepeat(); };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('pointerleave', up);
    }

    // ── open / close ──
    function show() {
      if (open) { suggest(); return; }
      open = true;
      layer = 'abc';
      shift = caps = false;
      build();
      suggest();
      host.classList.remove('hidden');
      onToggle && onToggle(true);
    }
    function hide() {
      if (!open) return;
      open = false;
      stopRepeat();
      host.classList.add('hidden');
      popEl.classList.add('hidden');
      onToggle && onToggle(false);
    }
    host.querySelector('.kb-close').addEventListener('pointerdown', (ev) => { ev.preventDefault(); hide(); input.blur(); });
    input.addEventListener('input', () => { if (open) suggest(); });
    input.addEventListener('keyup', () => { if (open) suggest(); });

    return {show, hide, isOpen: () => open};
  }

  window.VibeKeyboard = {create: createKeyboard};
})();
