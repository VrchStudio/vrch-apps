// ear.js: listening. It opens the audio input when asked and says which pitch it hears, and nothing else. What it
// hears is never played back, kept or sent anywhere: each short stretch is looked at once and forgotten.
//
// new Ear({sdk, onPitch, onChange})
//   open()      ask for the audio input and start listening; resolves once it is open or has failed
//   close()     give the input back
//   listening   true while the input is open
//   problem     null, 'refused' (not allowed), 'missing' (no input) or 'stopped' (it went away)
//   onPitch(hertz, loudness)   about 25 times a second while listening. hertz is 0 when no clear pitch is heard
//               (silence, noise, several notes at once); otherwise between 50 and 1000.
//   onChange()  "listening" or "problem" may have changed
//
// How the pitch is found: the newest 64 ms are laid over themselves, shifted a little further each time. A steady note
// repeats, so at a shift of exactly one of its periods the two copies agree almost everywhere; the shortest shift
// at which they clearly do is the period. (This is the YIN method.) A quarter of the samples are enough for it.
(() => {
  'use strict';
  const RATE = 48000, EVERY = 4, SLOW = RATE / EVERY;   // the input's samples a second, and the 12,000 that are kept
  const SPAN = 768;                  // samples looked at: 64 ms
  const LONGEST = 240, SHORTEST = 12;   // shifts tried, in samples: 50 Hz down to 1000 Hz
  const HOP = 480;                   // a new look every 40 ms
  const CLEAR = 0.15;                // the copies must differ by less than this share of their usual difference
  const QUIET = 0.006;               // below this loudness nothing is looked for
  const REFUSALS = ['permission_required', 'permission_denied', 'capability_denied', 'io_not_authorized', 'NotAllowedError'];

  window.Ear = class {
    constructor({sdk, onPitch, onChange}) {
      this.sdk = sdk; this.onPitch = onPitch || (() => {}); this.onChange = onChange || (() => {});
      this.session = null; this.problem = null;
      this.ring = new Float32Array(2048); this.at = 0; this.sum = 0; this.count = 0; this.since = 0;
      this.x = new Float32Array(SPAN); this.d = new Float32Array(LONGEST + 2);
    }
    get listening() { return !!this.session?.port; }
    async open() {
      this.close();
      const session = this.session = {port: null, cancelled: false};
      this.problem = null; this.at = 0; this.sum = 0; this.count = 0; this.since = 0;
      try {
        // (Echo cancelling is made for speech and would bend a held note.)
        const port = await this.sdk.audio.openInput({channels: 1, echoCancellation: false});
        if (session.cancelled) { void Promise.resolve(port.close()).catch(() => {}); return; }
        session.port = port;
        port.onData(samples => { if (this.session === session) this.hear(samples); });
        port.onError(() => { if (this.session === session) { this.close(); this.problem = 'stopped'; this.onChange(); } });
      } catch (error) {
        if (this.session !== session) return;
        this.close();
        this.problem = REFUSALS.includes(error?.code || error?.name) ? 'refused' : 'missing';
      }
      this.onChange();
    }
    close() {
      const session = this.session;
      this.session = null;
      if (!session) return;
      session.cancelled = true;
      if (session.port) void Promise.resolve(session.port.close()).catch(() => {});
    }
    // New samples from the input: every fourth is kept (the mean of four), and every 40 ms the pitch is looked for.
    hear(samples) {
      const ring = this.ring, size = ring.length;
      for (let i = 0; i < samples.length; i++) {
        this.sum += samples[i];
        if (++this.count < EVERY) continue;
        ring[this.at % size] = this.sum / EVERY; this.at++; this.sum = 0; this.count = 0;
        if (++this.since >= HOP && this.at >= SPAN) { this.since = 0; this.look(); }
      }
    }
    look() {
      const ring = this.ring, size = ring.length, x = this.x, d = this.d, from = this.at - SPAN;
      let mean = 0;
      for (let i = 0; i < SPAN; i++) { x[i] = ring[(from + i) % size]; mean += x[i]; }
      mean /= SPAN;
      let power = 0;
      for (let i = 0; i < SPAN; i++) { x[i] -= mean; power += x[i] * x[i]; }
      const loudness = Math.sqrt(power / SPAN);
      if (loudness < QUIET) { this.onPitch(0, loudness); return; }
      // d[shift]: how much the stretch differs from itself moved by "shift", as a share of the mean so far.
      const length = SPAN - LONGEST;
      let running = 0, found = 0;
      d[0] = 1;
      for (let shift = 1; shift <= LONGEST + 1; shift++) {
        let sum = 0;
        for (let i = 0; i < length - 1; i++) { const apart = x[i] - x[i + shift]; sum += apart * apart; }
        running += sum;
        d[shift] = running ? sum * shift / running : 1;
      }
      for (let shift = SHORTEST; shift <= LONGEST; shift++) {
        if (d[shift] >= CLEAR) continue;
        // The bottom of this dip.
        while (shift < LONGEST && d[shift + 1] < d[shift]) shift++;
        found = shift; break;
      }
      if (!found) { this.onPitch(0, loudness); return; }
      // The true bottom lies between samples: where a curve through the three lowest points turns.
      const before = d[found - 1], here = d[found], after = d[found + 1], bend = before - 2 * here + after;
      const period = found + (bend > 0 ? 0.5 * (before - after) / bend : 0);
      this.onPitch(SLOW / period, loudness);
    }
  };
})();
