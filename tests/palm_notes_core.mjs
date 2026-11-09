import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fingers, recognize, NoteGate} from '../apps/palm-notes/src/gesture.mjs';
import {Tone} from '../apps/palm-notes/src/tone.mjs';
const config = JSON.parse(fs.readFileSync(new URL('../apps/palm-notes/src/instrument.json', import.meta.url)));

// Construct independent joint geometry for every subset, not count-specific
// canned results. Rotation/reflection/depth and scale should preserve all bits.
function hand(mask) {
  const p = [[0,0,0],[-.3,.3,0],[-.6,.55,0],[-.9,.8,0],[-1.2,1.05,0]];
  if (!(mask & 1)) { p[3] = [-.2,.65,0]; p[4] = [.15,.65,0]; }
  for (let finger = 0; finger < 4; finger++) {
    const x = -.45 + finger * .3, y = finger === 3 ? .8 : 1;
    p.push([x,y,0], [x,y+.4,0]);
    if (mask & 1 << (finger+1)) p.push([x,y+.7,0],[x,y+1,0]);
    else p.push([x,y+.25,.25],[x,y,.1]);
  }
  return p;
}
let geometry = 0;
for (let mask = 0; mask < 32; mask++) for (const mirror of [1,-1]) for (const radians of [0,.7,1.57,3.14,4.5]) {
  const p = hand(mask).map(([x,y,z]) => {
    x *= mirror;
    const a=x*Math.cos(radians)-y*Math.sin(radians), b=x*Math.sin(radians)+y*Math.cos(radians);
    return [a*.04, (b*Math.cos(.5)-z*Math.sin(.5))*.04, (b*Math.sin(.5)+z*Math.cos(.5))*.04];
  });
  assert.deepEqual(fingers({world_landmarks:p},config.tracking), Array.from({length:5},(_,i)=>!!(mask & 1<<i)), 'mask '+mask);
  assert.equal(recognize({world_landmarks:p},config.tracking).note, mask===17?6:mask.toString(2).replaceAll('0','').length);
  geometry++;
}
assert.equal(fingers({world_landmarks:[]},config.tracking),null);
assert.equal(fingers({world_landmarks:Array(21).fill([0,0,0])},config.tracking),null);
const okHand=hand(28);okHand[4]=okHand[8].map((v,i)=>v+(i===0?.08:0));
assert.equal(recognize({world_landmarks:okHand},config.tracking).note,7);
const nearOk=structuredClone(okHand);nearOk[4][0]=nearOk[8][0]+.27;
assert.equal(recognize({world_landmarks:nearOk},config.tracking).note,3,'near pinch alone must not enter OK');
assert.equal(recognize({world_landmarks:nearOk},config.tracking,{gesture:'ok'}).note,7,'pinch hysteresis retains OK');
nearOk[4][0]=nearOk[8][0]+.4;
assert.equal(recognize({world_landmarks:nearOk},config.tracking,{gesture:'ok'}).note,3,'open pinch returns to count');
for(const aspect of [.75,1,4/3,2])for(const mirror of [1,-1]) {
  const world=okHand.map(([x,y,z])=>[x*mirror,y,z]);
  assert.equal(recognize({world_landmarks:world,landmarks:world.map(([x,y])=>[x/aspect,y])},config.tracking,{},aspect).note,7);
}
const falseOverlap=structuredClone(okHand);falseOverlap[4][2]=3;
assert.notEqual(recognize({world_landmarks:falseOverlap,landmarks:okHand.map(([x,y])=>[x,y])},config.tracking).note,7,'image overlap alone does not overcome distant depth');
const gate = new NoteGate(config.tracking);
assert.equal(gate.update(1,0),null);
assert.equal(gate.update(1,67),1);
assert.equal(gate.update(2,134),1);
assert.equal(gate.update(1,201),1,'single-frame jitter must not change note');
assert.equal(gate.update(3,268),1);
assert.equal(gate.update(3,335),3);
assert.equal(gate.update(0,402),0,'fist immediately releases');
assert.equal(gate.update(5,469),0);
assert.equal(gate.update(5,536),5);
assert.equal(gate.update(null,603),null,'missing hand immediately releases');
assert.equal(gate.update(2,670),null);
assert.equal(gate.update(2,737),2);
assert.equal(gate.expire(1000),null,'stale result releases');
assert.equal(gate.update(2,1100),null,'recovery requires fresh stability');
assert.equal(gate.update(2,1167),2);
for(const [n,t,expected] of [[6,1234,2],[6,1301,6],[7,1368,6],[7,1435,7],[3,1502,7],[3,1569,3],[0,1636,0],[7,1703,0],[7,1770,7],[null,1837,null]])assert.equal(gate.update(n,t),expected);
let soundCases = 0;
for (const note of config.notes) {
  const tone = new Tone(48000,config.sound), signal=new Float32Array(48000);
  tone.set({frequency:note.frequency,leaseMs:2000}); tone.render(signal);
  const crossings=[];
  for(let i=4800;i<signal.length;i++) if(signal[i-1]<=0&&signal[i]>0) crossings.push(i);
  const frequency=(crossings.length-1)*48000/(crossings.at(-1)-crossings[0]);
  assert(Math.abs(frequency-note.frequency)<.05);
  for(let i=0;i<30;i++) { tone.set({frequency:note.frequency,leaseMs:260}); tone.render(new Float32Array(960)); }
  assert.equal(tone.attacks,1,'refreshes must not retrigger');
  const stopped=new Float32Array(20000); tone.render(stopped);
  assert(stopped.slice(16000).every(v=>v===0),'audio lease must expire without UI events');
  tone.set({frequency:note.frequency,leaseMs:260}); tone.render(new Float32Array(3000));
  tone.set({frequency:0}); const release=new Float32Array(4000); tone.render(release);
  assert(release.slice(2900).every(v=>v===0));
  assert(signal.every(v=>Number.isFinite(v)&&Math.abs(v)<.3));
  soundCases++;
}
console.log(JSON.stringify({geometryCases:geometry,soundCases,gate:'jitter/fist/loss/stale/recovery pass'}));

const spectra=[];
for(const voice of config.voices) {
  const tone=new Tone(48000,config.sound,config.voices), signal=new Float32Array(48000);
  tone.set({frequency:440,voice:voice.id,leaseMs:1500});tone.render(signal);
  assert(signal.every(v=>Number.isFinite(v)&&Math.abs(v)<.5),voice.id+' bounded');
  const magnitude=frequency=>{
    let re=0,im=0;for(let i=4800;i<24000;i++){const p=2*Math.PI*frequency*i/48000;re+=signal[i]*Math.cos(p);im+=signal[i]*Math.sin(p);}
    return Math.hypot(re,im);
  };
  const fundamental=magnitude(440);assert(fundamental>100,voice.id+' audible');
  assert(magnitude(400)<fundamental*.02&&magnitude(480)<fundamental*.02,'preset preserves pitch');
  spectra.push([voice.id,...[2,3,5].map(n=>magnitude(440*n)/fundamental)]);
  tone.set({frequency:0});const tail=new Float32Array(6000);tone.render(tail);
  assert(tail.slice(5000).every(v=>v===0),'all voices release');
}
for(let i=0;i<spectra.length;i++)for(let j=i+1;j<spectra.length;j++)assert(Math.hypot(...spectra[i].slice(1).map((v,k)=>v-spectra[j][k+1]))>.1,'distinct harmonic profiles');
const switched=new Tone(48000,config.sound,config.voices);let previous=0,maxJump=0;
for(let i=0;i<120;i++) {
  switched.set({frequency:440,leaseMs:260,voice:config.voices[i%4].id});
  const block=new Float32Array(128);switched.render(block);
  for(const sample of block){maxJump=Math.max(maxJump,Math.abs(sample-previous));previous=sample;}
}
assert(maxJump<.05,'rapid preset changes stay smooth: '+maxJump);
assert.equal(switched.attacks,1,'changing timbre does not restart note');
console.log(JSON.stringify({voices:spectra,maxJump}));
