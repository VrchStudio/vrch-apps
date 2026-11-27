'use strict';

// Local kit for pads 01–16, in Drum Rack note order.
const localKit = [
  ['sine',70,.28], ['triangle',880,.07], ['bandpass',1800,.18], ['bandpass',1150,.14],
  ['bandpass',2350,.19], ['sine',95,.30], ['highpass',7000,.07], ['sine',115,.27],
  ['highpass',8500,.09], ['sine',135,.24], ['highpass',6200,.42], ['sine',160,.22],
  ['triangle',190,.22], ['highpass',4100,.68], ['triangle',235,.21], ['bandpass',5600,.48]
];

async function openLocalInstrument(sdk, onError) {
  const ctx = new AudioContext({sampleRate:48000, latencyHint:'interactive', sinkId:{type:'none'}});
  let port;
  async function close() {
    await Promise.allSettled([ctx.close(), port?.close()]);
  }
  try {
    await ctx.resume();
    port = await sdk.audio.openOutput({channels:1});
    const output = await port.createNode(ctx);
    const master = ctx.createDynamicsCompressor();
    master.threshold.value = -12;
    master.knee.value = 6;
    master.ratio.value = 4;
    master.connect(output);
    const harmonics = Float32Array.of(0,1,.75,.48,.34,.22,.14,.08);
    const wave = ctx.createPeriodicWave(new Float32Array(harmonics.length), harmonics);
    const noise = ctx.createBuffer(1,ctx.sampleRate,ctx.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i=0;i<samples.length;i++) samples[i]=Math.random()*2-1;

    function play(note, velocity, drums) {
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      const level = .035 + .34 * velocity / 127;
      let source, filter, stopAt = Infinity;
      if (drums) {
        const [type,frequency,duration] = localKit[note-36];
        if (type === 'bandpass' || type === 'highpass') {
          source = ctx.createBufferSource();
          source.buffer = noise;
          filter = ctx.createBiquadFilter();
          filter.type = type;
          filter.frequency.value = frequency;
          source.connect(filter);
        } else {
          source = ctx.createOscillator();
          source.type = type;
          source.frequency.setValueAtTime(frequency*2.1,now);
          source.frequency.exponentialRampToValueAtTime(frequency,now+.05);
        }
        stopAt = now+duration;
      } else {
        source = ctx.createOscillator();
        source.setPeriodicWave(wave);
        source.frequency.value = 440 * 2 ** ((note-69)/12);
      }
      gain.gain.setValueAtTime(.0001,now);
      gain.gain.linearRampToValueAtTime(level,now+.003);
      if (drums) gain.gain.exponentialRampToValueAtTime(.0001,stopAt);
      (filter || source).connect(gain).connect(master);
      let ended = false;
      source.onended = () => {
        ended = true;
        source.disconnect();
        filter?.disconnect();
        gain.disconnect();
      };
      source.start(now);
      if (drums) source.stop(stopAt);
      return () => {
        if (ended || ctx.state === 'closed') return;
        const end = Math.max(ctx.currentTime,now+.012);
        gain.gain.cancelAndHoldAtTime(end);
        gain.gain.setTargetAtTime(0,end,.006);
        source.stop(Math.min(end+.04,stopAt));
      };
    }
    const instrument = {play,close};
    port.onError(error => onError(instrument,error));
    return instrument;
  } catch (error) {
    await close();
    throw error;
  }
}
