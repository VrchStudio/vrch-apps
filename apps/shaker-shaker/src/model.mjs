// Original granular chamber model: body-frame specific force, contacts and modal sound.
export const MATERIALS = [
 {name:'Seeds',color:'#e6bf7b',bounce:.28,friction:.25,grain:.0032,noise:.014,modes:[2100,3900,6500],ring:.025},
 {name:'Sand',color:'#d7c6a0',bounce:.10,friction:.37,grain:.0025,noise:.035,modes:[3400,6100,8900],ring:.010},
 {name:'Wood',color:'#d39870',bounce:.34,friction:.30,grain:.0040,noise:.010,modes:[710,1510,3100],ring:.038},
 {name:'Metal',color:'#c5d3d9',bounce:.56,friction:.16,grain:.0030,noise:.007,modes:[2700,5230,8110],ring:.105}
];
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export class Shaker {
 constructor(rate=48000,seed=71829){
  this.rate=rate;this.seed=seed;this.settings={material:0,sensitivity:1.25,fill:.45,body:.5};
  this.force=[0,9.81,0];this.lastForce=[...this.force];this.gyro=[0,0,0];this.age=0;this.sensor=false;this.grip=false;this.muted=false;
  this.energy=0;this.previousNoise=0;this.sample=0;this.time=0;this.impacts=0;this.peak=0;this.motion=0;this.still=0;this.anchor=[0,9.81,0];this.sleeping=false;this.nudge=0;this.demoTail=0;this.outputGain=0;
  this.filters=[{a:0,b:0,y1:0,y2:0},{a:0,b:0,y1:0,y2:0},{a:0,b:0,y1:0,y2:0}];
  this.configure(this.settings);this.reset();
 }
 random(){let x=this.seed|0;x^=x<<13;x^=x>>>17;x^=x<<5;this.seed=x;return (x>>>0)/4294967296;}
 configure(values){
  Object.assign(this.settings,values);this.still=0;this.sleeping=false;const s=this.settings;
  s.material=clamp(Math.round(s.material),0,3);s.sensitivity=clamp(s.sensitivity,.4,3);s.fill=clamp(s.fill,.1,.9);s.body=clamp(s.body,0,1);
  this.material=MATERIALS[s.material];this.radius=.037+s.body*.035;this.axes=[this.radius,this.radius*.78,this.radius*.63];
  this.grain=this.material.grain;this.count=14+Math.round(s.fill*46);
  const pitch=1.32-.55*s.body;
  this.filters.forEach((f,i)=>{const r=Math.exp(-1/(this.rate*this.material.ring*(.75+s.body*.6)));f.a=2*r*Math.cos(2*Math.PI*this.material.modes[i]*pitch/this.rate);f.b=r*r;f.g=Math.sqrt(1-r*r)*.62;});
  this.decay=Math.exp(-1/(this.rate*this.material.noise));
  if(!this.particles||this.particles.length!==this.count)this.seedParticles();
 }
 seedParticles(){this.particles=Array.from({length:this.count},()=>{let x,y,z;do{x=this.random()*2-1;y=this.random()*2-1;z=this.random()*2-1;}while(x*x+y*y+z*z>.65);return {x:x*this.axes[0],y:y*this.axes[1],z:z*this.axes[2],vx:0,vy:0,vz:0};});}
 reset(){this.seedParticles();this.energy=0;this.nudge=0;for(let i=0;i<360;i++)this.physics(1/240,true);this.impacts=0;this.energy=0;this.filters.forEach(f=>{f.y1=f.y2=0;});}
 input(accel,gyro=[0,0,0]){
  if(accel.length!==3||gyro.length!==3||![...accel,...gyro].every(Number.isFinite))return;
  if(Math.hypot(...accel.map((v,i)=>v-this.anchor[i]))>.28||Math.hypot(...gyro)>.2){this.still=0;this.sleeping=false;this.anchor=[...accel];}
  this.force=accel.map(v=>clamp(v,-80,80));this.gyro=gyro.map(v=>clamp(v,-20,20));this.age=0;this.sensor=true;
 }
 tap(){this.nudge=.075;this.demoTail=1.2;this.still=0;this.sleeping=false;}
 impact(speed,scale=1){if(speed<.07)return;const gain=Math.pow(Math.min(speed,4),.85)*.12*scale;this.energy=Math.min(.9,this.energy+gain*gain);this.impacts++;}
 physics(dt,quiet=false){
  const p=this.particles,m=this.material,grip=this.grip?1:0;this.demoTail=Math.max(0,this.demoTail-dt);
  if(!quiet){this.still+=dt;if(this.still>.65&&this.nudge<=0){this.sleeping=true;p.forEach(q=>{q.vx=q.vy=q.vz=0;});}if(this.sleeping)return;}
  const a=this.force.map(v=>-v); // specific force already includes gravity: do not high-pass away the resting force.
  const impulse=this.nudge>0?(this.nudge>.0375?38:-38):0;this.nudge=Math.max(0,this.nudge-dt);a[0]+=impulse;
  const sensitivity=this.settings.sensitivity;
  // Gain changes the dynamic departure from the slowly changing gravity direction, not gravity magnitude.
  const norm=Math.hypot(...this.force),unit=norm>0?this.force.map(v=>v/norm):[0,1,0];
  for(let k=0;k<3;k++){this.lastForce[k]+=(unit[k]*9.81-this.lastForce[k])*Math.min(1,dt*.8);a[k]-=(this.force[k]-this.lastForce[k])*(sensitivity-1);}
  this.motion+=(Math.abs(norm-9.81)-this.motion)*.12;
  const axes=this.axes.map(v=>v-this.grain),e=m.bounce*(1-grip*.7),mu=m.friction+grip*.5;
  const [wx,wy,wz]=this.gyro;
  for(const q of p){
   const cx=wy*q.z-wz*q.y,cy=wz*q.x-wx*q.z,cz=wx*q.y-wy*q.x,vx=q.vx,vy=q.vy,vz=q.vz;
   q.vx+=(a[0]-(wy*cz-wz*cy)-2*(wy*vz-wz*vy))*dt;
   q.vy+=(a[1]-(wz*cx-wx*cz)-2*(wz*vx-wx*vz))*dt;
   q.vz+=(a[2]-(wx*cy-wy*cx)-2*(wx*vy-wy*vx))*dt;
   q.vx*=.998;q.vy*=.998;q.vz*=.998;q.x+=q.vx*dt;q.y+=q.vy*dt;q.z+=q.vz*dt;
   const d=Math.hypot(q.x/axes[0],q.y/axes[1],q.z/axes[2]);
   if(d>1){
    q.x/=d;q.y/=d;q.z/=d;
    let nx=q.x/(axes[0]*axes[0]),ny=q.y/(axes[1]*axes[1]),nz=q.z/(axes[2]*axes[2]);const n=Math.hypot(nx,ny,nz);nx/=n;ny/=n;nz/=n;
    const v=q.vx*nx+q.vy*ny+q.vz*nz;
    if(v>0){if(!quiet)this.impact(v,1-grip*.65);const bounce=v<.07?0:e;q.vx-=(1+bounce)*v*nx;q.vy-=(1+bounce)*v*ny;q.vz-=(1+bounce)*v*nz;}
    const normal=q.vx*nx+q.vy*ny+q.vz*nz,tx=q.vx-normal*nx,ty=q.vy-normal*ny,tz=q.vz-normal*nz,tangent=Math.hypot(tx,ty,tz);
    const loss=Math.min(tangent,mu*Math.max(0,a[0]*nx+a[1]*ny+a[2]*nz)*dt+mu*Math.max(v,0));
    if(tangent>0){q.vx-=tx*loss/tangent;q.vy-=ty*loss/tangent;q.vz-=tz*loss/tangent;if(!quiet&&tangent>.08)this.energy=Math.min(.9,this.energy+loss*tangent*.006*(1-grip*.8));}
   }
  }
  const distance=2*this.grain,dd=distance*distance;
  for(let i=0;i<p.length;i++)for(let j=i+1;j<p.length;j++){
   const u=p[i],v=p[j],dx=v.x-u.x,dy=v.y-u.y,dz=v.z-u.z,d2=dx*dx+dy*dy+dz*dz;
   if(d2>=dd||d2<1e-12)continue;const d=Math.sqrt(d2),nx=dx/d,ny=dy/d,nz=dz/d,push=(distance-d)*.5;
   u.x-=nx*push;u.y-=ny*push;u.z-=nz*push;v.x+=nx*push;v.y+=ny*push;v.z+=nz*push;
   const speed=(v.vx-u.vx)*nx+(v.vy-u.vy)*ny+(v.vz-u.vz)*nz;
   if(speed<0){const k=-(1+e*.4)*speed*.5;u.vx-=nx*k;u.vy-=ny*k;u.vz-=nz*k;v.vx+=nx*k;v.vy+=ny*k;v.vz+=nz*k;if(!quiet)this.impact(-speed,.12);}
  }
 }
 render(output){
  let peak=0;
  for(let i=0;i<output.length;i++){
   if(this.sample++%200===0){this.age+=200/this.rate;this.physics(200/this.rate,(!this.sensor||this.age>.18)&&this.demoTail<=0);}
   const active=this.sensor&&this.age<.18||this.demoTail>0;const target=this.muted||!active?0:.5;this.outputGain+=(target-this.outputGain)*.002;
   this.energy*=this.decay;const noise=this.random()*2-1,hp=noise-this.previousNoise*.65;this.previousNoise=noise;
   const excitation=hp*Math.sqrt(this.energy);let value=excitation*.48;
   for(const f of this.filters){const damping=this.grip?.92:1;const y=excitation+f.a*damping*f.y1-f.b*damping*damping*f.y2;f.y2=f.y1;f.y1=y;value+=y*f.g;}
   value=Math.tanh(value*this.outputGain);output[i]=value;peak=Math.max(peak,Math.abs(value));this.time+=1/this.rate;
  }
  this.peak=peak;
 }
 snapshot(){return {positions:this.particles.map(p=>[p.x/this.axes[0],p.y/this.axes[1],p.z/this.axes[2]]),impacts:this.impacts,peak:this.peak,energy:this.energy,motion:this.motion,age:this.age};}
}
