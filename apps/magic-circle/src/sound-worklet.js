'use strict';
class MagicSoundProcessor extends AudioWorkletProcessor {
 constructor(){super();this.settings={volume:.25,pitch:110,tone:0,space:.45,speed:.7,pattern:0};this.phase=[0,0,0,0,0,0];this.tick=0;this.level=0;this.hit=0;this.hitPhase=0;this.noise=0;this.writeIndex=0;this.left=new Float32Array(sampleRate);this.right=new Float32Array(sampleRate);this.port.onmessage=({data:m})=>{if(m.type==='settings')Object.assign(this.settings,m.value);if(m.type==='pulse')this.hit=Math.min(1,Number(m.strength)||1);if(m.type==='mute')this.settings.volume=0;};}
 process(inputs,outputs){const out=outputs[0];if(!out?.length)return true;const p=this.settings,base=p.pitch,ratios=[1,1.5,2,2.5,3,4],stepRate=.55+p.speed*.9,delay=Math.floor(sampleRate*(.17+p.space*.22)),freqs=[base,base*1.003,base*1.5,base,base*2.002,base*.5];
  for(let i=0;i<out[0].length;i++){
   const t=this.tick++/sampleRate,step=Math.floor(t*stepRate),beat=t*stepRate-step,note=ratios[(step+p.pattern)%ratios.length];freqs[3]=base*note;
   for(let j=0;j<6;j++){this.phase[j]+=Math.PI*2*freqs[j]/sampleRate;if(this.phase[j]>Math.PI*2)this.phase[j]-=Math.PI*2;}
   const ph=this.phase,bell=Math.exp(-beat*(p.tone===1?6:3)),breath=.7+.3*Math.sin(t*.42),drone=Math.sin(ph[0])*.1+Math.sin(ph[1])*.06+Math.sin(ph[2])*.04;
   let voice;if(p.tone===0)voice=drone*breath+(Math.sin(ph[3])+.23*Math.sin(ph[3]*2))*.055*bell;
   else if(p.tone===1)voice=drone*.28+(Math.sin(ph[3])+.3*Math.sin(ph[3]*2)+.12*Math.sin(ph[3]*4))*.13*bell;
   else voice=(Math.sin(ph[0]+Math.sin(ph[2])*(1.2+.7*Math.sin(t*.3)))*.13+Math.sin(ph[5])*.07)*breath+Math.sin(ph[3])*.035*bell;
   this.hit*=Math.exp(-1/(sampleRate*.27));this.hitPhase+=Math.PI*2*(base*1.5+this.hit*base*5)/sampleRate;this.hitPhase%=Math.PI*2;this.noise+=(Math.random()*2-1-this.noise)*.13;
   voice+=(Math.sin(this.hitPhase)*.23+this.noise*.22)*this.hit;
   const pos=(this.writeIndex-delay+this.left.length)%this.left.length,dl=this.left[pos],dr=this.right[pos],pan=Math.sin(t*.23)*.22;
   this.left[this.writeIndex]=voice*(1-pan)+dr*.3*p.space;this.right[this.writeIndex]=voice*(1+pan)+dl*.3*p.space;this.writeIndex=(this.writeIndex+1)%this.left.length;
   this.level+=(p.volume-this.level)*.0015;
   out[0][i]=Math.tanh((voice*(1-pan)+dl*p.space*.65)*this.level)*.7;
   if(out[1])out[1][i]=Math.tanh((voice*(1+pan)+dr*p.space*.65)*this.level)*.7;
  }return true;
 }
}
registerProcessor('magic-circle-sound',MagicSoundProcessor);
