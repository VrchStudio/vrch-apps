/* Visuals Player feature worker. Reads the audio features the picture follows from a built-in track's decoded sound, a
   few seconds at a time, exactly as the App reads a live input (spectrum.js). It starts from a blob that also holds the
   shared audio analysis and spectrum.js (see music.js). */
(() => {
  'use strict';
  const {SR, FFT, RATE, Spectrum, encodeFrames} = self.VisualsSpectrum;
  const jobs = new Map();
  self.onmessage = ({data}) => {
    if (data?.type === 'drop') { jobs.delete(data.job); return; }
    if (data?.type !== 'analyse') return;
    let job = jobs.get(data.job);
    if (!job) {
      if (data.start !== 0) return;
      jobs.set(data.job, job = {spectrum: new Spectrum(), tail: new Float32Array(FFT), next: 0});
    }
    // The chunk follows the last FFT samples of the one before, so each reading sees a full window.
    const mono = new Float32Array(data.mono), end = data.start + mono.length, sound = new Float32Array(FFT + mono.length);
    sound.set(job.tail); sound.set(mono, FFT);
    const first = job.next, samples = [];
    // Frame f is the analyser reading at f / RATE seconds: the FFT samples that end there.
    while (job.next < data.frames) {
      const at = Math.round(job.next * SR / RATE);
      if (at > end && !data.last) break;
      samples.push(job.spectrum.read(sound, sound, at - data.start + FFT));
      job.next++;
    }
    job.tail = sound.slice(sound.length - FFT);
    if (data.last) jobs.delete(data.job);
    const features = encodeFrames(samples);
    self.postMessage({type: 'features', job: data.job, first, last: data.last, features: features.buffer}, [features.buffer]);
  };
  self.postMessage({type: 'ready'});
})();
