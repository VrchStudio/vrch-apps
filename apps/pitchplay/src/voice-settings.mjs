const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const bend = (value, min, centre, max) => centre + (value < 0 ? centre - min : max - centre) * value / 100;
const inverse = (value, min, centre, max) => value < centre ? (value-centre)/(centre-min)*100 : (value-centre)/(max-centre)*100;
export function voiceDefaults(config, id) {
  const voice = config.voices.find(v => v.id === id) || config.voices[0];
  return {pitch:0, size:0, texture:voice.texture};
}
export function normalizeSettings(config, value = {}) {
  const state = {...config.defaults};
  if (config.voices.some(v => v.id === value.voice)) state.voice = value.voice;
  else if (value.voice) state.voice = value.voice === 'robot' ? 'robot' : ['man','giant','elder','original'].includes(value.voice) || value.pitch < 0 ? 'deep' : 'bright';
  Object.assign(state, voiceDefaults(config,state.voice));
  const voice = config.voices.find(v => v.id === state.voice);
  if (value.controlsVersion === 3) {
    for (const p of config.parameters) if (Number.isFinite(value[p.id])) state[p.id] = value[p.id];
  } else {
    if (value.controlsVersion === 2) {
      if (voice.id === 'robot') {state.texture=Number.isFinite(value.amount)?value.amount:100;state.pitch=Number.isFinite(value.tone)?value.tone:0;}
      else {
        const oldPitch=(voice.id==='deep'?-5:24)*(Number.isFinite(value.amount)?value.amount/100:.8);
        state.pitch=inverse(oldPitch,voice.pitchMin,voice.pitch,voice.pitchMax);
        state.size=Number.isFinite(value.tone)?value.tone:0;
      }
    } else if (Number.isFinite(value.pitch) && voice.id !== 'robot') {
      state.pitch=inverse(value.pitch,voice.pitchMin,voice.pitch,voice.pitchMax);
      if (Number.isFinite(value.size)) state.size=value.size/6*100;
    }
    if (Number.isFinite(value.level)) state.level=value.level;
  }
  for (const p of config.parameters) state[p.id]=Math.round(clamp(state[p.id],p.min,p.max)/p.step)*p.step;
  if (typeof value.bypass === 'boolean') state.bypass=value.bypass;
  if (value.voice === 'original') state.bypass=true;
  return state;
}
export function dspSettings(config, state) {
  const voice=config.voices.find(v=>v.id===state.voice)||config.voices[0];
  const result={...config.effects,pitch:0,mix:1,bypass:state.bypass,level:state.level/100};
  result.formant=bend(state.size,voice.formantMin,voice.formant,voice.formantMax);
  if(voice.id==='robot'){
    result.carrier=bend(state.pitch,voice.carrierMin,voice.carrier,voice.carrierMax);
    result.robot=voice.robotMin+(1-voice.robotMin)*state.texture/100;
  }else{
    result.pitch=bend(state.pitch,voice.pitchMin,voice.pitch,voice.pitchMax);
    result.body=voice.body;result.air=voice.air;result.roughness=state.texture/100;
    result.articulation=voice.articulation||0;
  }
  return result;
}
