// scope.js: how an incoming signal is read in input mode (the pocket oscilloscope). Plain functions over samples;
// nothing here draws or touches the audio system.
//
// IN   mono samples at 48 kHz (Float32Array), newest last
// OUT  trigger()   where a sweep should start so a steady tone stands still on screen
//      spectrum()  level in dB for each of "columns" steps along a logarithmic frequency axis
//      pitch()     the note being played, if there is a clear one
//
// To remix: change how the sweep is triggered, the frequency range, or what counts as a clear pitch.
(() => {
  'use strict';
  const SR = 48000;

  // Start of the latest stretch of "length" samples that begins where the wave rises through zero. The wave must have
  // dipped clearly below zero first, so noise around zero does not trigger. Returns a fractional index, or -1.
  function trigger(samples, count, length) {
    let peak = 0;
    for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(samples[i]));
    const dip = -0.15 * peak;
    for (let i = count - length; i > 0; i--) {
      if (!(samples[i - 1] < 0 && samples[i] >= 0)) continue;
      for (let j = i - 1; j >= 0; j--) {
        if (samples[j] <= dip) return i - samples[i] / (samples[i] - samples[i - 1]);
        if (samples[j] >= -dip) break;
      }
    }
    return -1;
  }

  // In-place FFT of real[] and imag[] (length a power of two).
  function fft(real, imag) {
    const n = real.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const r = real[i]; real[i] = real[j]; real[j] = r; const m = imag[i]; imag[i] = imag[j]; imag[j] = m; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = -2 * Math.PI / size, wr = Math.cos(step), wi = Math.sin(step);
      for (let start = 0; start < n; start += size) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = start + k, b = a + half, tr = real[b] * cr - imag[b] * ci, ti = real[b] * ci + imag[b] * cr;
          real[b] = real[a] - tr; imag[b] = imag[a] - ti; real[a] += tr; imag[a] += ti;
          const next = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = next;
        }
      }
    }
  }
  // A spectrum analyser over the newest "size" samples. read() fills out[] with dB (0 = a full-scale sine) for each
  // column from "low" to "high" Hz on a logarithmic axis, eased over time, and returns the loudest frequency in Hz.
  function spectrum({size = 8192, low = 40, high = 12000} = {}) {
    const real = new Float32Array(size), imag = new Float32Array(size), power = new Float32Array(size / 2), hann = new Float32Array(size);
    for (let i = 0; i < size; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);
    return {size, low, high, read(samples, out, columns) {
      for (let i = 0; i < size; i++) { real[i] = samples[i] * hann[i]; imag[i] = 0; }
      fft(real, imag);
      let top = 1;
      for (let k = 1; k < size / 2; k++) {
        const now = (real[k] * real[k] + imag[k] * imag[k]) * 16 / (size * size);
        power[k] += (now - power[k]) * 0.5;
        if (power[k] > power[top] && k * SR / size >= low) top = k;
      }
      for (let c = 0; c < columns; c++) {
        // Each column shows the strongest of the FFT bins it covers (at least the two nearest, blended, at the low end).
        const from = low * (high / low) ** (c / columns) * size / SR, to = low * (high / low) ** ((c + 1) / columns) * size / SR;
        let best = 0;
        if (to - from < 1) { const k = Math.floor(from), mix = from - k; best = power[k] * (1 - mix) + power[k + 1] * mix; }
        else for (let k = Math.ceil(from); k < to; k++) best = Math.max(best, power[k]);
        out[c] = 10 * Math.log10(best + 1e-12);
      }
      // Loudest frequency, placed between bins from its two neighbours.
      const a = Math.log(power[top - 1] + 1e-20), b = Math.log(power[top] + 1e-20), c = Math.log(power[top + 1] + 1e-20), shift = a - 2 * b + c ? 0.5 * (a - c) / (a - 2 * b + c) : 0;
      return (top + shift) * SR / size;
    }};
  }

  // The pitch of the newest samples, 40 Hz to 2 kHz, by comparing the wave with itself shifted in time (YIN): the
  // shift at which it best matches is one period. Returns {hz, clear}; clear is 0..1 and low for noise or chords.
  const HALF = new Float32Array(1700), DIFF = new Float32Array(602);
  function pitch(samples, count) {
    const need = HALF.length * 2;
    if (count < need) return {hz: 0, clear: 0};
    // Half the rate is plenty for these notes and four times less work.
    for (let i = 0, at = count - need; i < HALF.length; i++, at += 2) HALF[i] = (samples[at] + samples[at + 1]) / 2;
    const window = 1024, longest = 600, shortest = 12;
    let running = 0, found = -1;
    DIFF[0] = 1;
    for (let lag = 1; lag <= longest; lag++) {
      let sum = 0;
      for (let j = 0; j < window; j++) { const d = HALF[j] - HALF[j + lag]; sum += d * d; }
      running += sum;
      DIFF[lag] = running ? sum * lag / running : 1;
    }
    for (let lag = shortest; lag < longest; lag++) if (DIFF[lag] < 0.12 && DIFF[lag] <= DIFF[lag + 1]) { found = lag; break; }
    if (found < 0) return {hz: 0, clear: 0};
    const a = DIFF[found - 1], b = DIFF[found], c = DIFF[found + 1], shift = a - 2 * b + c ? 0.5 * (a - c) / (a - 2 * b + c) : 0;
    return {hz: SR / 2 / (found + shift), clear: 1 - b};
  }
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // Nearest note and how far off it is, in hundredths of a semitone.
  function note(hz) {
    const midi = 69 + 12 * Math.log2(hz / 440), nearest = Math.round(midi);
    return {name: NOTES[(nearest % 12 + 12) % 12] + (Math.floor(nearest / 12) - 1), cents: (midi - nearest) * 100};
  }

  globalThis.XYScope = {trigger, spectrum, pitch, note};
})();
