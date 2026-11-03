/* SF2 (SoundFont 2) reader for the browser.
   Parses the RIFF chunk tree, preset/instrument zone trees and the sample
   block into one flat Float32Array. Everything the synth needs is returned as
   plain arrays so the result can be posted to an AudioWorklet. */

(function (root) {
  'use strict';

  // the real opcodes (kept explicit to avoid mistakes above)
  const OP = {
    START_OFF: 0x00,
    END_OFF: 0x01,
    STARTLOOP_OFF: 0x02,
    ENDLOOP_OFF: 0x03,
    START_COARSE: 0x04,
    END_COARSE: 0x0c,
    STARTLOOP_COARSE: 0x2d,
    ENDLOOP_COARSE: 0x2e,
    PAN: 0x11,
    ATTEN: 0x30,
    FILTER_FC: 0x08,
    FILTER_Q: 0x09,
    COARSE_TUNE: 0x33,
    FINE_TUNE: 0x34,
    SAMPLE_MODES: 0x36,
    ROOT_KEY: 0x3a,
    SCALE_TUNING: 0x38,
    KEY_RANGE: 0x2b,
    VEL_RANGE: 0x2c,
    VENV_DELAY: 0x21,
    VENV_ATTACK: 0x22,
    VENV_HOLD: 0x23,
    VENV_DECAY: 0x24,
    VENV_SUSTAIN: 0x25,
    VENV_RELEASE: 0x26,
    K2VENV_HOLD: 0x27,
    K2VENV_DECAY: 0x28,
    KEYNUM: 0x2f,
    VELOCITY: 0x30 + 100
  };

  function readChunks(view, start, end) {
    const out = [];
    let pos = start;
    while (pos + 8 <= end) {
      const id = fourcc(view, pos);
      let size = view.getUint32(pos + 4, true);
      const dataStart = pos + 8;
      if (dataStart + size > end) size = end - dataStart;
      out.push({ id, dataStart, size });
      pos = dataStart + size + (size & 1);
    }
    return out;
  }

  function fourcc(view, pos) {
    return String.fromCharCode(
      view.getUint8(pos), view.getUint8(pos + 1), view.getUint8(pos + 2), view.getUint8(pos + 3)
    );
  }

  function readFixedName(view, pos, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = view.getUint8(pos + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  /* one generator list -> map of applied values (later entries win) */
  function readGens(view, start, count) {
    const g = {};
    for (let i = 0; i < count; i++) {
      const op = view.getUint16(start + i * 4, true);
      const lo = view.getUint8(start + i * 4 + 2);
      const hi = view.getUint8(start + i * 4 + 3);
      let amount = view.getInt16(start + i * 4 + 2, true);
      if (op === OP.KEY_RANGE || op === OP.VEL_RANGE) {
        g[op] = { lo, hi };
      } else if (op === OP.SAMPLE_MODES) {
        g[op] = amount & 0x3;
      } else if (op === OP.START_OFF || op === OP.END_OFF || op === OP.STARTLOOP_OFF || op === OP.ENDLOOP_OFF ||
                 op === OP.START_COARSE || op === OP.END_COARSE || op === OP.STARTLOOP_COARSE || op === OP.ENDLOOP_COARSE) {
        g[op] = amount;
      } else {
        g[op] = amount;
      }
    }
    return g;
  }

  function parse(buffer) {
    const view = new DataView(buffer);
    if (fourcc(view, 0) !== 'RIFF' || fourcc(view, 8) !== 'sfbk') throw new Error('not an SF2 file');

    const chunks = readChunks(view, 12, view.byteLength);
    let smpl = null;
    const pdta = {};

    for (const c of chunks) {
      if (c.id !== 'LIST') continue;
      const type = fourcc(view, c.dataStart);
      const inner = readChunks(view, c.dataStart + 4, c.dataStart + c.size);
      if (type === 'sdta') {
        for (const s of inner) if (s.id === 'smpl') smpl = s;
      } else if (type === 'pdta') {
        for (const s of inner) pdta[s.id] = s;
      }
    }
    if (!smpl || !pdta.phdr) throw new Error('SF2 is missing sample or preset data');

    /* ---- samples: one flat Float32 buffer + headers ---- */
    const pcmBytes = smpl.size;
    const pcm16 = new Int16Array(buffer, smpl.dataStart, pcmBytes >> 1);
    const pcm = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) pcm[i] = pcm16[i] / 32768;

    const shdrCount = Math.floor(pdta.shdr.size / 46) - 1; // last record is EOI
    const samples = [];
    for (let i = 0; i < shdrCount; i++) {
      const b = pdta.shdr.dataStart + i * 46;
      samples.push({
        name: readFixedName(view, b, 20),
        start: view.getUint32(b + 20, true),
        end: view.getUint32(b + 24, true),
        loopStart: view.getUint32(b + 28, true),
        loopEnd: view.getUint32(b + 32, true),
        rate: view.getUint32(b + 36, true),
        rootKey: view.getUint8(b + 40),
        correction: view.getInt8(b + 41),
        type: view.getUint16(b + 44, true)
      });
    }

    /* ---- instruments ---- */
    const instCount = Math.floor(pdta.inst.size / 22) - 1;
    const ibagCount = Math.floor(pdta.ibag.size / 4);
    const instruments = [];
    for (let i = 0; i < instCount; i++) {
      const b = pdta.inst.dataStart + i * 22;
      const bagStart = view.getUint16(b + 20, true);
      const bagEnd = view.getUint16(pdta.inst.dataStart + (i + 1) * 22 + 20, true);
      const zones = [];
      for (let z = bagStart; z < bagEnd; z++) {
        const genStart = view.getUint16(pdta.ibag.dataStart + z * 4, true);
        const genEnd = view.getUint16(pdta.ibag.dataStart + (z + 1) * 4, true);
        if (genEnd <= genStart) continue;
        let sampleIndex = 0;
        const gens = {};
        for (let g = genStart; g < genEnd; g++) {
          const op = view.getUint16(pdta.igen.dataStart + g * 4, true);
          if (op === 0x35) { // sampleID
            sampleIndex = view.getUint16(pdta.igen.dataStart + g * 4 + 2, true);
            continue;
          }
          const v = readGens(view, pdta.igen.dataStart + g * 4, 1);
          Object.assign(gens, v);
        }
        zones.push({ gens, sampleIndex });
      }
      instruments.push({ name: readFixedName(view, b, 20), zones });
    }

    /* ---- presets ---- */
    const pbagCount = Math.floor(pdta.pbag.size / 4);
    const presetCount = Math.floor(pdta.phdr.size / 38) - 1;
    const presets = [];
    for (let i = 0; i < presetCount; i++) {
      const b = pdta.phdr.dataStart + i * 38;
      const name = readFixedName(view, b, 20);
      const program = view.getUint16(b + 20, true);
      const bank = view.getUint16(b + 22, true);
      const bagStart = view.getUint16(b + 24, true);
      const bagEnd = view.getUint16(pdta.phdr.dataStart + (i + 1) * 38 + 24, true);
      const zones = [];
      for (let z = bagStart; z < bagEnd; z++) {
        const genStart = view.getUint16(pdta.pbag.dataStart + z * 4, true);
        const genEnd = view.getUint16(pdta.pbag.dataStart + (z + 1) * 4, true);
        let instIndex = 0;
        const gens = {};
        for (let g = genStart; g < genEnd; g++) {
          const op = view.getUint16(pdta.pgen.dataStart + g * 4, true);
          if (op === 0x29) { // instrument
            instIndex = view.getUint16(pdta.pgen.dataStart + g * 4 + 2, true);
            continue;
          }
          Object.assign(gens, readGens(view, pdta.pgen.dataStart + g * 4, 1));
        }
        zones.push({ gens, instIndex });
      }
      presets.push({ name, program, bank, zones });
    }

    return { presets, instruments, samples, pcm, pcm16 };
  }

  root.SF2 = { parse, OP };
})(typeof globalThis !== 'undefined' ? globalThis : this);
