'use strict';
const $=id=>document.getElementById(id),canvas=$('circle'),ctx=canvas.getContext('2d');
const TAU=Math.PI*2,patterns=['Orbit','Sigil','Lattice','Vortex','Eclipse','Bloom','Nova','Prism'],palettes=[{name:'Astral',main:'#58dfff',other:'#b45cff',core:'#e9fbff'},{name:'Ember',main:'#ffae42',other:'#ff3868',core:'#fff1ce'},{name:'Verdant',main:'#67ffb6',other:'#46a7ff',core:'#e1ffee'},{name:'Ritual',main:'#ff46bc',other:'#8b55ff',core:'#ffe8fb'},{name:'Solar',main:'#ffe073',other:'#ff7838',core:'#ffffe4'},{name:'Glacier',main:'#8ba9ff',other:'#52ffe1',core:'#f0ffff'}];
const defaults={speed:.7,points:7,glow:.7,gain:1.5,pattern:0,palette:0,volume:.25,pitch:110,tone:0,space:.45};
let settings={...defaults},time=0,last=0,width=0,height=0,dpr=1,dirty=true,busy=false,disposed=false,input=null,inputEpoch=0,saveTimer,saveChain=Promise.resolve(),audioEnergy=0,smoothed=0,lastPulse=-10000,held=new Set(),pulses=[];
const stars=Array.from({length:65},(_,i)=>({x:((i*37+13)%101)/101,y:((i*61+7)%103)/103,s:.4+(i%3)*.35}));
window.magic={ready:false,audio:'off',level:0,frames:0,pulses:0,settings};
const soundTones=['Astral','Crystal','Void'];let soundBank=false;
const soundEngine=createMagicSound((state,error)=>{magic.sound=state;$('soundStatus').textContent=error;dirty=true;});magic.sound='off';magic.soundBank=false;
function setControlBank(value){soundBank=value;magic.soundBank=value;dirty=true;}
function normalize(v){const n=(k,min,max)=>Math.max(min,Math.min(max,Number.isFinite(Number(v?.[k]))?Number(v[k]):defaults[k]));return {speed:n('speed',0,2),points:Math.round(n('points',3,12)),glow:n('glow',0,1),gain:n('gain',.25,4),pattern:Math.round(n('pattern',0,patterns.length-1)),palette:Math.round(n('palette',0,palettes.length-1)),volume:n('volume',0,1),pitch:Math.round(n('pitch',55,440)),tone:Math.round(n('tone',0,2)),space:n('space',0,1)};}
function render(){magic.settings=settings;soundEngine.update({volume:settings.volume,pitch:settings.pitch,tone:settings.tone,space:settings.space,speed:settings.speed,pattern:settings.pattern});dirty=true;}
function save(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>{const value={...settings};saveChain=saveChain.then(async()=>{const old=await VrchApp.data.get('settings');await VrchApp.data.set('settings',value,{expectedVersion:old.version});}).catch(()=>{$('status').textContent='Settings could not be saved';});},250);}
function update(v){if(!magic.ready)return;settings=normalize({...settings,...v});render();save();}
function pulse(strength=1,withSound=true){if(withSound)soundEngine.pulse(strength);pulses.push({at:time,strength});if(pulses.length>8)pulses.shift();magic.pulses++;}
async function stopInput(){++inputEpoch;const previous=input;input=null;magic.audio='off';audioEnergy=0;$('status').textContent='';dirty=true;await previous?.close().catch(()=>{});}
async function startInput(){
 const epoch=++inputEpoch;magic.audio='starting';$('status').textContent='';dirty=true;
 try{const opened=await VrchApp.audio.openInput({channels:1});if(epoch!==inputEpoch||disposed){await opened.close();return;}input=opened;magic.audio='active';dirty=true;
  opened.onData(samples=>{if(input!==opened)return;let energy=0;for(let i=0;i<samples.length;i++)energy+=samples[i]*samples[i];const rms=Math.sqrt(energy/Math.max(1,samples.length));audioEnergy=Math.min(1,Math.max(0,rms-.004)*settings.gain*14);magic.level=rms;if(audioEnergy>.48&&time-lastPulse>.3){lastPulse=time;pulse(audioEnergy,false);}});
 }catch(error){if(epoch!==inputEpoch||disposed)return;magic.audio='error';dirty=true;$('status').textContent='Input unavailable. Press E4 to retry.';}
}
function toggleAudio(){if(magic.audio==='active'||magic.audio==='starting')void stopInput();else void startInput();}

const motes=Array.from({length:150},(_,i)=>({seed:i*2.399963,life:((i*47)%151)/151,size:.5+(i%4)*.35}));
let previousPattern=settings.pattern,shownPattern=settings.pattern,transition=1,transitionPulse=0,shownPalette=0,previousPalette=0,paletteTransition=1;
const lights=new Map();
function light(color){if(lights.has(color))return lights.get(color);const c=document.createElement('canvas');c.width=c.height=96;const g=c.getContext('2d'),rad=g.createRadialGradient(48,48,0,48,48,48);rad.addColorStop(0,'#ffffff');rad.addColorStop(.07,color);rad.addColorStop(.22,color+'90');rad.addColorStop(.5,color+'20');rad.addColorStop(1,color+'00');g.fillStyle=rad;g.fillRect(0,0,96,96);if(lights.size>100)lights.delete(lights.keys().next().value);lights.set(color,c);return c;}
function flare(x,y,size,color,alpha=1){ctx.globalAlpha=Math.max(0,Math.min(1,alpha));ctx.drawImage(light(color),x-size,y-size,size*2,size*2);}
function path(points,color,alpha=1,line=1,closed=true){ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));if(closed)ctx.closePath();ctx.strokeStyle=color;ctx.globalAlpha=Math.max(0,Math.min(1,alpha));ctx.lineWidth=line;ctx.stroke();}
function ring(radius,color,alpha=1,line=1,start=0,end=TAU){ctx.beginPath();ctx.arc(0,0,Math.max(.1,radius),start,end);ctx.strokeStyle=color;ctx.globalAlpha=Math.max(0,Math.min(1,alpha));ctx.lineWidth=line;ctx.stroke();}
function polygon(count,radius,rotation=0,skip=1){return Array.from({length:count+1},(_,i)=>{const a=rotation+i*skip*TAU/count;return [Math.cos(a)*radius,Math.sin(a)*radius];});}
function luminous(points,color,alpha=1,line=1,closed=true){const power=.3+settings.glow;path(points,color,alpha*.08*power,line+7*power,closed);path(points,color,alpha*.19*power,line+2.5*power,closed);path(points,color,alpha,line,closed);}
function rune(i,x,y,angle,size,color){ctx.save();ctx.translate(x,y);ctx.rotate(angle);const k=i%5;path([[-size*.3,size*.45],[0,-size*.5],[size*.3,size*.45]],color,.85,1,false);path(k===0?[[-size*.35,0],[size*.35,0]]:k===1?[[0,0],[size*.5,-size*.2]]:k===2?[[-size*.4,-size*.2],[0,size*.5],[size*.4,-size*.2]]:k===3?[[0,-size*.65],[0,size*.65]]:[[-size*.5,size*.2],[size*.5,-size*.2]],color,.75,1,false);ctx.restore();}
function resize(){const box=canvas.getBoundingClientRect();width=box.width;height=box.height;dpr=Math.min(devicePixelRatio||1,1.5);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}
new ResizeObserver(resize).observe(canvas);
function geometry(mode,r,t,p,opacity,energy){
 if(opacity<.01)return;const n=settings.points,twist=t*.23,breath=Math.sin(t*.64),a=opacity;
 ctx.save();ctx.rotate(t*.045*(mode%2?1:-1));
 if(mode===0){ // Armillary orbit: a moving collection of planar ellipses.
  for(let k=0;k<5;k++){const pts=[];for(let j=0;j<=96;j++){const q=j*TAU/96;pts.push([Math.cos(q)*r*(.36+k*.1),Math.sin(q)*r*(.14+.06*k+.045*Math.sin(t*.6+k))]);}ctx.save();ctx.rotate(k*Math.PI/5+twist*.3);luminous(pts,k%2?p.other:p.main,a*.8,1);const q=t*(.55+k*.07)+k;flare(Math.cos(q)*r*(.36+k*.1),Math.sin(q)*r*(.14+.06*k+.045*Math.sin(t*.6+k)),r*.06,p.core,a);ctx.restore();}
  luminous(polygon(n,r*.8,-twist,2),p.main,a*.65);
 }else if(mode===1){ // Conjuring sigil: nested star seals and travelling glyphs.
  for(let k=0;k<4;k++){const rr=r*(.78-k*.14)*(1+.025*Math.sin(t+k));luminous(polygon(n,rr,twist*(k%2?-1:1)+k*.2,Math.max(1,Math.floor((n-1)/2))),k%2?p.other:p.main,a*(.95-k*.1),1.2);}
  for(let i=0;i<n;i++){const q=i*TAU/n+twist*.4;ctx.save();ctx.translate(Math.cos(q)*r*.82,Math.sin(q)*r*.82);ring(r*.057,p.core,a*.8);path(polygon(3,r*.044,-t),p.main,a);ctx.restore();}
 }else if(mode===2){ // Interference lattice: fine crossing chords and rosettes.
  for(let k=0;k<3;k++){const pts=[];for(let j=0;j<=180;j++){const q=j*TAU/180,rr=r*(.54+.22*Math.cos(n*q+t*.55+k*2.1));pts.push([Math.cos(q+twist*(k-1))*rr,Math.sin(q+twist*(k-1))*rr]);}luminous(pts,k%2?p.other:p.main,a*.85);}
  for(let j=0;j<n*2;j++){const q=j*TAU/(n*2)+twist,b=q+Math.PI+Math.sin(t*.4)*.55;path([[Math.cos(q)*r*.77,Math.sin(q)*r*.77],[Math.cos(b)*r*.77,Math.sin(b)*r*.77]],p.other,a*.35,.8,false);}
 }else if(mode===3){ // Vortex: deep flowing spirals, open center and radial sparks.
  for(let k=0;k<n;k++){const pts=[];for(let j=0;j<=64;j++){const u=j/64,q=k*TAU/n+twist*3+u*(4.6+breath*.6),rr=r*(.09+u*.72);pts.push([Math.cos(q)*rr,Math.sin(q)*rr]);}luminous(pts,k%2?p.other:p.main,a*.8,1.3,false);}
  ring(r*.17,p.core,a,1.6);flare(0,0,r*.25,p.other,a*.8);
 }else if(mode===4){ // Eclipse: a dark disc with braided solar corona.
  for(let k=0;k<4;k++){const pts=[];for(let j=0;j<=180;j++){const q=j*TAU/180,rr=r*(.47+.04*k+.065*Math.sin(q*n+t*(k%2?-.9:.7))+.035*Math.cos(q*17-t));pts.push([Math.cos(q)*rr,Math.sin(q)*rr]);}luminous(pts,k%2?p.main:p.other,a*.9,1.3);}
  for(let i=0;i<40;i++){const q=i*TAU/40+twist*.25,rr=r*(.56+.12*Math.sin(i*2.3+t*.8)**2);path([[Math.cos(q)*r*.48,Math.sin(q)*r*.48],[Math.cos(q+.05*Math.sin(t+i))*rr,Math.sin(q+.05*Math.sin(t+i))*rr]],p.main,a*.65,1,false);}
  ctx.globalCompositeOperation='source-over';ctx.globalAlpha=a;ctx.fillStyle='#06080e';ctx.beginPath();ctx.arc(0,0,r*.405,0,TAU);ctx.fill();ctx.globalCompositeOperation='lighter';ring(r*.405,p.core,a,1.3);ring(r*.425,p.other,a*.15,10+energy*8);flare(-r*.24,-r*.34,r*.22,p.core,a);
 }else if(mode===5){ // Celestial bloom: petal ribbons open and close continuously.
  for(let k=0;k<5;k++){const pts=[];for(let j=0;j<=180;j++){const q=j*TAU/180,rr=r*(.12+(Math.sin(n*q*.5+t*.25+k*.14)**2)*(.7-k*.08));pts.push([Math.cos(q+twist*.4+k*.06)*rr,Math.sin(q+twist*.4+k*.06)*rr]);}luminous(pts,k%2?p.other:p.main,a*(1-k*.11),1.1);}
 }else if(mode===6){ // Nova: a faceted sun with energetic rays.
  const teeth=n*4;
  for(let k=0;k<3;k++){const pts=[];for(let j=0;j<=teeth*2;j++){const q=j*TAU/(teeth*2)+twist*(k%2?-.5:.3),rr=r*(j%2?.29+k*.04:.64+.13*Math.sin(t*.5+k+j*.9)**2)*(1-k*.12);pts.push([Math.cos(q)*rr,Math.sin(q)*rr]);}luminous(pts,k%2?p.other:p.main,a*.95,1.2);}
  flare(0,0,r*.39,p.main,a*.65);
 }else{ // Prism: folding polygons, nested counter-rotating glass facets.
  for(let k=0;k<8;k++){const rr=r*(.82-k*.078),angle=twist*Math.sin(t*.2+k*.2)+k*.12+Math.sin(t*.35)*.3;luminous(polygon(Math.max(3,n-2),rr,angle),k%2?p.other:p.main,a*(.85-k*.06),1.2);}
  for(let j=0;j<n;j++){const q=j*TAU/n+twist;path([[Math.cos(q)*r*.8,Math.sin(q)*r*.8],[Math.cos(q+1.2)*r*.22,Math.sin(q+1.2)*r*.22]],p.core,a*.4,.8,false);}
 }
 ctx.restore();
}
function mixColor(a,b,t){return '#'+[1,3,5].map(i=>Math.round(parseInt(a.slice(i,i+2),16)*(1-t)+parseInt(b.slice(i,i+2),16)*t).toString(16).padStart(2,'0')).join('');}
function draw(now){
 if(disposed)return;const dt=Math.min(.05,(now-(last||now))/1000);last=now;time+=dt;magic.frames++;smoothed+=(audioEnergy-smoothed)*(1-Math.exp(-dt*12));audioEnergy*=Math.exp(-dt*3);
 if(settings.pattern!==shownPattern){if(magic.ready)soundEngine.pulse(.45);previousPattern=shownPattern;shownPattern=settings.pattern;transition=0;transitionPulse=1;}
 if(settings.palette!==shownPalette){previousPalette=shownPalette;shownPalette=settings.palette;paletteTransition=0;}paletteTransition=Math.min(1,paletteTransition+dt);const pm=Math.round(paletteTransition*20)/20,pa=palettes[previousPalette],pb=palettes[shownPalette];
 transition=Math.min(1,transition+dt*.85);transitionPulse*=Math.exp(-dt*3);const blend=transition*transition*(3-2*transition),p={main:mixColor(pa.main,pb.main,pm),other:mixColor(pa.other,pb.other,pm),core:mixColor(pa.core,pb.core,pm)},t=time*(.16+settings.speed*.85),energy=smoothed;
 pulses=pulses.filter(x=>time-x.at<1.7);const impact=pulses.reduce((v,w)=>Math.max(v,Math.exp(-(time-w.at)*4)*w.strength),0),r=Math.min(width,height)*.46*(1+energy*.045+impact*.025),rot=t*.19,power=.4+settings.glow*.8;
 ctx.setTransform(dpr,0,0,dpr,0,0);ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';ctx.fillStyle='#05070d';ctx.fillRect(0,0,width,height);ctx.translate(width/2,height/2);ctx.globalCompositeOperation='lighter';
 flare(-r*.45,-r*.18,r*1.2,p.main,.075*power);flare(r*.4,r*.3,r*1.1,p.other,.11*power);flare(0,0,r*.65,p.main,.1+energy*.16+impact*.25);
 // Every mote carries a short curved comet tail, giving the field depth.
 for(let i=0;i<motes.length;i++){const s=motes[i],life=(s.life+t*.022*(1+i%3)+impact*.01)%1,rr=r*(.14+life*1.08),q=s.seed+t*(.09+(i%5)*.016)+life*(shownPattern===3?3:1.1),alpha=Math.sin(life*Math.PI)*(.2+settings.glow*.6),stretch=.025+energy*.07+impact*.08,x=Math.cos(q)*rr,y=Math.sin(q)*rr;path([[Math.cos(q-stretch)*rr*(1-stretch*.4),Math.sin(q-stretch)*rr*(1-stretch*.4)],[x,y]],i%3?p.main:p.other,alpha,s.size*.7,false);if(i%4===0)flare(x,y,3+s.size*2,p.main,alpha*.6);}
 ring(r*.94,p.main,.06*power,9);ring(r*.94,p.main,.68,1.2);ring(r*.92,p.other,.55,.65);ring(r*.79,p.main,.25);
 ctx.beginPath();for(let i=0;i<120;i++){const q=i*TAU/120+rot*.13,inner=r*(i%5===0?.96:.975);ctx.moveTo(Math.cos(q)*inner,Math.sin(q)*inner);ctx.lineTo(Math.cos(q)*r,Math.sin(q)*r);}ctx.strokeStyle=p.main;ctx.globalAlpha=.55+energy*.3;ctx.lineWidth=.75;ctx.stroke();
 for(let i=0;i<30;i++){const q=i*TAU/30-rot*.28;rune(i,Math.cos(q)*r*.865,Math.sin(q)*r*.865,q+Math.PI/2,r*.044,p.main);}
 for(let i=0;i<6;i++){const q=i*TAU/6+rot*(i%2?-1:1)*.4;ring(r*(.795+i%2*.225),i%2?p.other:p.main,.9,1.5,q,q+.45+energy*.7);flare(Math.cos(q)*r*.795,Math.sin(q)*r*.795,r*.035,p.core,.65);}
 if(transition<1)geometry(previousPattern,r,t,p,1-blend,energy);geometry(shownPattern,r,t,p,blend,energy);
 if(shownPattern!==4||transition<1){ctx.save();ctx.rotate(-rot);luminous(polygon(6,r*(.145+energy*.045),0,2),p.core,.9,1);ctx.restore();flare(0,0,r*(.1+energy*.15+impact*.23),p.core,.75);ring(r*(.205+energy*.03),p.main,.5,1);}
 for(const wave of pulses){const age=(time-wave.at)/1.7,rr=r*(.12+age*1.22),alpha=(1-age)**2;ring(rr,p.main,alpha*.18,15*power);ring(rr,p.core,alpha,1.4+3*(1-age));for(let j=0;j<28;j++){const q=j*TAU/28+wave.at,tail=rr-r*.05*(1-age);path([[Math.cos(q)*tail,Math.sin(q)*tail],[Math.cos(q)*rr,Math.sin(q)*rr]],j%2?p.main:p.other,alpha,1.4,false);}}
 if(transitionPulse>.02)ring(r*(.2+(1-transitionPulse)*.8),p.core,transitionPulse*.6,2);
 if(magic.ready&&dirty&&!busy){dirty=false;busy=true;const item=(label,value)=>({label,value:String(value)}),values=soundBank?{E1:item('Volume',Math.round(settings.volume*100)+'%'),E2:item('Pitch',settings.pitch+' Hz'),E3:item('Timbre',soundTones[settings.tone]),E4:item('Space',Math.round(settings.space*100)+'%'),K2:item('Pattern',patterns[settings.pattern]),K3:item('Palette',palettes[settings.palette].name),K4:item('Pulse',magic.sound==='active'?'SFX on':magic.sound==='starting'?'Starting':magic.sound==='error'?'Retry E1':'SFX off')}:{E1:item('Speed',settings.speed.toFixed(2)),E2:item('Points',settings.points),E3:item('Glow',Math.round(settings.glow*100)+'%'),E4:item('Input',magic.audio==='active'?settings.gain.toFixed(1):magic.audio==='error'?'Retry':'Off'),K2:item('Pattern',patterns[settings.pattern]),K3:item('Palette',palettes[settings.palette].name),K4:item('Pulse',magic.sound==='active'?'SFX on':magic.sound==='starting'?'Starting':magic.sound==='error'?'Retry E1':'SFX off')};VrchApp.monitor.set(values).catch(()=>{}).finally(()=>busy=false);}

 requestAnimationFrame(draw);
}
canvas.onpointerdown=()=>pulse();
VrchApp.controls.onEvent(e=>{if(!magic.ready)return;const panel=soundBank;if(e.type==='rotate'){const d=Number(e.delta)||0;if(panel){if(e.control==='E1')update({volume:settings.volume+d*.02});if(e.control==='E2')update({pitch:settings.pitch+d*5});if(e.control==='E3')update({tone:(settings.tone+Math.sign(d)+3)%3});if(e.control==='E4')update({space:settings.space+d*.05});}else{if(e.control==='E1')update({speed:settings.speed+d*.05});if(e.control==='E2')update({points:settings.points+d});if(e.control==='E3')update({glow:settings.glow+d*.05});if(e.control==='E4')update({gain:settings.gain+d*.1});}}if(e.type==='down'&&!held.has(e.control)){held.add(e.control);if(e.control==='E1')void soundEngine.toggle();if(e.control==='E3')setControlBank(!soundBank);if(e.control==='E4')toggleAudio();if(e.control==='K2')update({pattern:(settings.pattern+1)%patterns.length});if(e.control==='K3')update({palette:(settings.palette+1)%palettes.length});if(e.control==='K4')pulse();}if(e.type==='up'||e.type==='cancel')held.delete(e.control);});
VrchApp.ready().then(async()=>{try{settings=normalize((await VrchApp.data.get('settings')).value);}catch(_){}magic.ready=true;render();if(VrchApp.context.mode==='device')void startInput();}).catch(()=>$('status').textContent='App unavailable. Reopen it.');
addEventListener('pagehide',()=>{disposed=true;clearTimeout(saveTimer);void stopInput();void soundEngine.stop();},{once:true});render();resize();requestAnimationFrame(draw);
