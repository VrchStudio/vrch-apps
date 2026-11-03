/* Flatten an SF2 bank into layers the synth worklet can play directly.

   SF2 nests preset zones -> instruments -> instrument zones -> samples. For each
   preset we resolve every layer that can sound, with its key/velocity window,
   tuning, attenuation, loop points and volume envelope already in readable
   units (seconds, 0..1 gain). */

(function (root) {
  'use strict';

  const OP = {
    START_OFF: 0x00, END_OFF: 0x01, STARTLOOP_OFF: 0x02, ENDLOOP_OFF: 0x03,
    START_COARSE: 0x04, END_COARSE: 0x0c, STARTLOOP_COARSE: 0x2d, ENDLOOP_COARSE: 0x2e,
    PAN: 0x11, ATTEN: 0x30, COARSE_TUNE: 0x33, FINE_TUNE: 0x34,
    SAMPLE_MODES: 0x36, ROOT_KEY: 0x3a, SCALE_TUNING: 0x38,
    KEY_RANGE: 0x2b, VEL_RANGE: 0x2c,
    VENV_DELAY: 0x21, VENV_ATTACK: 0x22, VENV_HOLD: 0x23, VENV_DECAY: 0x24,
    VENV_SUSTAIN: 0x25, VENV_RELEASE: 0x26
  };

  const tc2sec = (tc) => {
    const v = Math.pow(2, tc / 1200);
    return Math.max(0.001, Math.min(12, v));
  };
  const cb2gain = (cb) => Math.pow(10, -cb / 200);

  function build(sf) {
    const samples = sf.samples;
    const pcm = sf.pcm;

    const presetList = [];
    for (const p of sf.presets) {
      const layers = [];
      for (const pz of p.zones) {
        const inst = sf.instruments[pz.instIndex];
        if (!inst) continue;
        const pg = pz.gens || {};
        for (const iz of inst.zones) {
          const ig = iz.gens || {};
          // sample 0 is the GM test tone that the DLS conversion references from
          // almost every instrument; it is a placeholder, not a real layer
          if (iz.sampleIndex === 0) continue;
          const s = samples[iz.sampleIndex];
          if (!s || s.end <= s.start) continue;

          const keyRange = pg[OP.KEY_RANGE] || ig[OP.KEY_RANGE] || { lo: 0, hi: 127 };
          const velRange = pg[OP.VEL_RANGE] || ig[OP.VEL_RANGE] || { lo: 0, hi: 127 };

          const startOff = (ig[OP.START_OFF] || 0) + 32768 * (ig[OP.START_COARSE] || 0);
          const endOff = (ig[OP.END_OFF] || 0) + 32768 * (ig[OP.END_COARSE] || 0);
          const loopStartOff = (ig[OP.STARTLOOP_OFF] || 0) + 32768 * (ig[OP.STARTLOOP_COARSE] || 0);
          const loopEndOff = (ig[OP.ENDLOOP_OFF] || 0) + 32768 * (ig[OP.ENDLOOP_COARSE] || 0);

          const start = Math.max(0, s.start + startOff);
          const end = Math.min(pcm.length, s.end + endOff);
          if (end - start < 8) continue;
          const loopStart = Math.max(start, Math.min(end - 2, s.loopStart + loopStartOff));
          const loopEnd = Math.max(loopStart + 2, Math.min(end, s.loopEnd + loopEndOff));

          const mode = ig[OP.SAMPLE_MODES] !== undefined ? ig[OP.SAMPLE_MODES] : 0;
          const root = ig[OP.ROOT_KEY] !== undefined ? ig[OP.ROOT_KEY] : s.rootKey;
          const coarse = (ig[OP.COARSE_TUNE] || 0) + (pg[OP.COARSE_TUNE] || 0);
          const fine = (ig[OP.FINE_TUNE] || 0) + (pg[OP.FINE_TUNE] || 0) + (s.correction || 0);
          const scale = (ig[OP.SCALE_TUNING] !== undefined ? ig[OP.SCALE_TUNING] : 100);

          const attenCb = (ig[OP.ATTEN] || 0) + (pg[OP.ATTEN] || 0);
          const panRaw = (ig[OP.PAN] || 0) + (pg[OP.PAN] || 0);

          // an absent generator means "no delay / instant attack / full sustain",
          // not the SF2 "0 timecents = 1 second" value
          const g = (o) => (ig[o] !== undefined ? ig[o] : pg[o] !== undefined ? pg[o] : undefined);
          const env = {
            delay: g(OP.VENV_DELAY) !== undefined ? tc2sec(g(OP.VENV_DELAY)) : 0,
            attack: g(OP.VENV_ATTACK) !== undefined ? Math.max(0.001, tc2sec(g(OP.VENV_ATTACK))) : 0.002,
            hold: g(OP.VENV_HOLD) !== undefined ? Math.max(0, tc2sec(g(OP.VENV_HOLD))) : 0,
            decay: g(OP.VENV_DECAY) !== undefined ? Math.max(0.005, tc2sec(g(OP.VENV_DECAY))) : 0.4,
            sustain: g(OP.VENV_SUSTAIN) !== undefined
              ? Math.max(0, Math.min(1, cb2gain(g(OP.VENV_SUSTAIN)))) : 1,
            release: g(OP.VENV_RELEASE) !== undefined ? Math.max(0.01, tc2sec(g(OP.VENV_RELEASE))) : 0.3
          };

          layers.push({
            keyLo: keyRange.lo, keyHi: keyRange.hi,
            velLo: velRange.lo, velHi: velRange.hi,
            sample: start, sampleEnd: end,
            loopStart, loopEnd,
            loop: mode === 1 || mode === 3,
            root, coarse, fine, scale,
            gain: cb2gain(attenCb),
            pan: Math.max(-1, Math.min(1, panRaw / 500)),
            rate: s.rate || 44100,
            env
          });
        }
      }
      presetList.push({ name: p.name, bank: p.bank, program: p.program, layers });
    }

    return { presets: presetList, pcm: pcm };
  }

  root.Bank = { build };
})(typeof globalThis !== 'undefined' ? globalThis : this);
