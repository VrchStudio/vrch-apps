/* Visuals Player music worker. Renders the current song a little ahead of where it plays, works out the audio features
   the picture reads from that sound, and carries on into the songs that follow. It starts from a blob that also holds the
   Drum 808 engine, the shared audio analysis, spectrum.js and beats/songs.js (see music.js). */
(() => {
  'use strict';
  const {SR, songs, SongRenderer, describe} = self.VisualsBeats, {Spectrum, encodeFrames, RATE, FFT} = self.VisualsSpectrum;
  const CHUNK_BARS = 2;
  let job = null, timer = 0;

  self.onmessage = ({data}) => {
    if (data?.type === 'start') begin(data);
    else if (data?.type === 'playhead') { if (job && job.id === data.job) { job.playhead = data.stream; pump(); } }
    else if (data?.type === 'stop') job = null;
  };
  // A job plays from 'offset' seconds into 'song' (stream time 0) on: it renders from the bar before, so echoes and
  // reverb are already sounding there, and keeps 'ahead' seconds rendered beyond the playhead the App reports.
  function begin({job: id, song, offset = 0, audio = false, ahead = 16}) {
    const timing = describe(song), barSeconds = timing.barSamples / SR;
    const bar = Math.max(0, Math.min(timing.bars - 1, Math.floor(offset / barSeconds) - 1));
    job = {id, audio, ahead, playhead: 0, song, bar, base: -offset, timing, first: true,
      renderer: new SongRenderer(song, self.VisualsDrum808), spectrum: new Spectrum(), tailL: new Float32Array(FFT), tailR: new Float32Array(FFT)};
    pump();
  }
  function pump() { if (!timer) timer = setTimeout(work, 0); }
  function work() {
    timer = 0;
    const current = job;
    if (!current) return;
    const timing = current.timing;
    if (current.base + timing.barStart(current.bar) / SR - current.playhead >= current.ahead) return;
    // The first chunk is one bar so the picture and sound can start sooner.
    const count = Math.min(current.first ? 1 : CHUNK_BARS, timing.bars - current.bar);
    current.first = false;
    const {left, right, start} = current.renderer.render(current.bar, count);
    const L = new Float32Array(FFT + left.length), R = new Float32Array(FFT + right.length);
    L.set(current.tailL); L.set(left, FFT); R.set(current.tailR); R.set(right, FFT);
    const first = Math.ceil(start * RATE / SR), last = Math.ceil((start + left.length) * RATE / SR), samples = [];
    for (let frame = first; frame < last; frame++) samples.push(current.spectrum.read(L, R, Math.round(frame * SR / RATE) - start + FFT));
    current.tailL = L.slice(L.length - FFT); current.tailR = R.slice(R.length - FFT);
    const features = encodeFrames(samples), message = {type: 'chunk', job: current.id, song: current.song, start, frames: left.length,
      stream: current.base + start / SR, first, features: features.buffer, left: null, right: null};
    const transfer = [features.buffer];
    if (current.audio) { message.left = left.buffer; message.right = right.buffer; transfer.push(left.buffer, right.buffer); }
    self.postMessage(message, transfer);
    current.bar += count;
    if (current.bar >= timing.bars) {
      // The next song follows straight on.
      current.base += timing.barStart(timing.bars) / SR;
      current.song = (current.song + 1) % songs.length; current.bar = 0; current.timing = describe(current.song);
      current.renderer = new SongRenderer(current.song, self.VisualsDrum808);
    }
    if (job === current) pump();
  }
  self.postMessage({type: 'ready'});
})();
