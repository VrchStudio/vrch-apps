// Render the audio engine's real grains. Animation stays off the audio/input path.
const PALETTES=[['#ffcf8a','#fa714d','#e5b874'],['#aeecde','#46b8b5','#b4dbcf'],['#ffb89c','#db6453','#e99a7c'],['#e3d8ff','#a09bea','#bfc9ed']];
const TAU=Math.PI*2;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export function createVisual(canvas){
 const ctx=canvas.getContext('2d'),reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
 let width=0,height=0,dpr=1,previousTime=0,energy=0,rotation=0,aimX=0,aimY=0,latest=null,positions=[],previous=[],snapshotAt=0,previousImpacts=0,flash=0,palette=-1,sprite,disposed=false;
 const ripples=[],rest=Array.from({length:35},(_,i)=>{const x=Math.sin(i*2.399)*Math.sqrt((i+.5)/35)*.7;return[x,-.50-Math.sqrt(Math.max(0,1-x*x))*.23+Math.sin(i*4.1)*.10,Math.cos(i*2.399)*.35];});
 const observer=new ResizeObserver(()=>{const r=canvas.getBoundingClientRect();width=r.width;height=r.height;dpr=Math.min(devicePixelRatio,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);});observer.observe(canvas);
 function spark(color){const c=document.createElement('canvas');c.width=c.height=64;const s=c.getContext('2d'),g=s.createRadialGradient(32,32,0,32,32,32);g.addColorStop(0,'#fff7e8');g.addColorStop(.09,color);g.addColorStop(.28,color+'88');g.addColorStop(1,color+'00');s.fillStyle=g;s.fillRect(0,0,64,64);return c;}
 function update(snapshot){if(disposed||!snapshot?.positions)return;previous=positions.length===snapshot.positions.length?positions.map(p=>p.slice()):snapshot.positions.map(p=>p.slice());latest=snapshot;snapshotAt=performance.now();if(snapshot.impacts>previousImpacts){flash=Math.min(1,flash+Math.min(.6,(snapshot.impacts-previousImpacts)*.008));if(!reduced&&ripples.length<5&&snapshot.peak>.008)ripples.push({age:0,power:Math.min(1,snapshot.peak*10)});}previousImpacts=snapshot.impacts;}
 function draw(now,{material=0,grip=false,muted=false,motion=[0,9.81,0]}={}){
  if(disposed||width<2||height<2)return;const dt=Math.min(.05,(now-previousTime)/1000||.016);previousTime=now;
  if(palette!==material){palette=material;sprite=spark(PALETTES[material][0]);}
  const [light,accent,grain]=PALETTES[material],source=latest?.positions||rest;
  const mix=clamp((now-snapshotAt)/55,0,1);positions=source.map((p,i)=>p.map((v,j)=>{const a=previous[i]?.[j]??v;return a+(v-a)*mix;}));
  const target=muted||now-snapshotAt>250?0:clamp((latest?.peak||0)*7,0,1);energy+=(target-energy)*Math.min(1,dt*12);flash*=Math.exp(-dt*6);
  const tiltX=clamp(motion[0]/16,-.65,.65),tiltY=clamp((motion[1]-9.81)/20,-.3,.3);
  aimX+=(tiltX-aimX)*Math.min(1,dt*8);aimY+=(tiltY-aimY)*Math.min(1,dt*8);rotation+=(aimX*.16-rotation)*Math.min(1,dt*8);
  const cx=width*.5+aimX*6,cy=height*.43+aimY*5,rx=Math.min(width*.355,(height-180)*.56),ry=rx*.81;
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';ctx.fillStyle='#080809';ctx.fillRect(0,0,width,height);
  // A restrained light field gives the transparent chamber depth without a UI card.
  const halo=ctx.createRadialGradient(cx,cy,rx*.05,cx,cy,rx*1.65);halo.addColorStop(0,accent+'20');halo.addColorStop(.55,accent+(grip?'13':'19'));halo.addColorStop(1,accent+'00');ctx.fillStyle=halo;ctx.fillRect(0,0,width,height);
  ctx.save();ctx.translate(cx,cy);ctx.rotate(reduced?0:rotation);const squeeze=grip?.94:1;ctx.scale(squeeze,squeeze);
  const shell=ctx.createLinearGradient(-rx,-ry,rx,ry);shell.addColorStop(0,light+'17');shell.addColorStop(.4,light+'03');shell.addColorStop(1,accent+'13');ctx.fillStyle=shell;ctx.beginPath();ctx.ellipse(0,0,rx,ry,0,0,TAU);ctx.fill();
  // Curved meridians and a lit double rim read as one physical resonator.
  ctx.lineWidth=.6;ctx.strokeStyle=light+'16';for(const k of [.28,.56,.82]){ctx.beginPath();ctx.ellipse(0,0,rx*k,ry,0,0,TAU);ctx.stroke();}for(const k of [-.55,0,.55]){const a=Math.sqrt(1-k*k);ctx.beginPath();ctx.ellipse(0,ry*k,rx*a,ry*.13*a,0,0,TAU);ctx.stroke();}
  const rim=ctx.createLinearGradient(-rx,-ry,rx,ry);rim.addColorStop(0,light+'dd');rim.addColorStop(.25,accent+'50');rim.addColorStop(.55,light+'30');rim.addColorStop(.85,accent+'d0');rim.addColorStop(1,light+'dd');ctx.strokeStyle=rim;ctx.lineWidth=grip?2.4:1.3;ctx.beginPath();ctx.ellipse(0,0,rx,ry,0,0,TAU);ctx.stroke();
  ctx.globalAlpha=.4+flash*.4;ctx.lineWidth=.5;ctx.beginPath();ctx.ellipse(0,0,rx+3,ry+3,0,0,TAU);ctx.stroke();ctx.globalAlpha=1;
  // Understated external registration marks remain still until real motion arrives.
  ctx.strokeStyle=light+'36';ctx.lineWidth=1;for(let i=0;i<48;i++){const a=i/48*TAU,x=Math.cos(a),y=Math.sin(a),l=i%4===0?5:2;ctx.beginPath();ctx.moveTo(x*(rx+10),y*(ry+10));ctx.lineTo(x*(rx+10+l),y*(ry+10+l));ctx.stroke();}
  const ordered=positions.map((p,i)=>({p,i})).sort((a,b)=>a.p[2]-b.p[2]);ctx.save();ctx.beginPath();ctx.ellipse(0,0,rx-1,ry-1,0,0,TAU);ctx.clip();
  for(const {p,i} of ordered){const z=p[2],x=(p[0]+z*.11)*rx*.92,y=-(p[1]+z*.08)*ry*.91,size=Math.max(2.1,rx*.024)*(1+z*.20),alpha=clamp(.65+z*.3,.3,1);ctx.globalAlpha=alpha;
   if(!reduced&&energy>.025&&previous[i]){const old=previous[i],ox=(old[0]+old[2]*.11)*rx*.92,oy=-(old[1]+old[2]*.08)*ry*.91;ctx.strokeStyle=grain+'90';ctx.lineWidth=size*.85;ctx.beginPath();ctx.moveTo(ox,oy);ctx.lineTo(x,y);ctx.stroke();}
   ctx.globalCompositeOperation='lighter';const glow=size*(grip?2.6:3.5+energy*2.5);ctx.drawImage(sprite,x-glow,y-glow,glow*2,glow*2);ctx.globalCompositeOperation='source-over';ctx.fillStyle=light;ctx.beginPath();ctx.arc(x,y,size*(material===1?.75:1),0,TAU);ctx.fill();ctx.fillStyle='#fff8ec';ctx.globalAlpha=alpha*.8;ctx.beginPath();ctx.arc(x-size*.22,y-size*.28,size*.32,0,TAU);ctx.fill();
  }ctx.restore();ctx.globalAlpha=1;
  for(let i=ripples.length-1;i>=0;i--){const r=ripples[i];r.age+=dt;if(r.age>.7){ripples.splice(i,1);continue;}ctx.strokeStyle=accent;ctx.globalAlpha=(1-r.age/.7)*r.power*.35;ctx.lineWidth=.8;ctx.beginPath();ctx.ellipse(0,0,rx*(1+r.age*.22),ry*(1+r.age*.22),0,0,TAU);ctx.stroke();}ctx.globalAlpha=1;
  if(grip){ctx.strokeStyle=light;ctx.lineWidth=2;for(const sign of [-1,1]){ctx.beginPath();ctx.arc(0,0,rx+20,sign===1?-.35:Math.PI-.35,sign===1?.35:Math.PI+.35);ctx.stroke();}}
  ctx.restore();
 }
 return{update,draw,destroy(){disposed=true;observer.disconnect();}};
}
