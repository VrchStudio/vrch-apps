'use strict';
// Body-rate integration in the existing picture axes: X right, Y up, Z out.
function createImuOrientation() {
  let quaternion=[1,0,0,0],last=null;
  function reset(){quaternion=[1,0,0,0];last=null;}
  function update(gyro,threshold=0){
    const timestamp=BigInt(gyro.completed_ns),xyz=gyro.xyz.map(v=>Math.abs(v)<=threshold?0:v);
    if(last){
      const dt=Number(timestamp-last.timestamp)/1e9;
      if(dt>0&&dt<=1){
        const vector=xyz.map((v,i)=>(v+last.xyz[i])*.5),speed=Math.hypot(...vector),angle=speed*dt*.5;
        if(speed>0){
          const k=Math.sin(angle)/speed,[w,x,y,z]=quaternion,[a,b,c,d]=[Math.cos(angle),...vector.map(v=>v*k)];
          const next=[w*a-x*b-y*c-z*d,w*b+x*a+y*d-z*c,w*c-x*d+y*a+z*b,w*d+x*c-y*b+z*a];
          const length=Math.hypot(...next);quaternion=next.map(v=>v/length);
        }
      }
    }
    last={timestamp,xyz:[...xyz]};
  }
  function rotate([x,y,z]){
    const [w,a,b,c]=quaternion,tx=2*(b*z-c*y),ty=2*(c*x-a*z),tz=2*(a*y-b*x);
    return [x+w*tx+b*tz-c*ty,y+w*ty+c*tx-a*tz,z+w*tz+a*ty-b*tx];
  }
  return {reset,update,rotate,pause(){last=null;},get quaternion(){return [...quaternion];}};
}
function createImuWireframe(canvas) {
  const orientation=createImuOrientation(),lines=[],colors=['#ff8297','#7bd4ad','#88b6ef'];
  // Plan proportions from the accepted K4E4_MODEL_3D review geometry.
  const spec={body:[372,542,60],plate:[360,530],screen:{top:80,size:360,bezel:20},encoders:{diameter:68,height:30,rowHeight:80},keys:{top:440,size:90,gap:2,height:12}};
  const segment=(a,b,color='#aaa9a5')=>lines.push({a,b,color});
  function rectangle(x,y,z,w,h,color){const points=[[x-w/2,y-h/2,z],[x+w/2,y-h/2,z],[x+w/2,y+h/2,z],[x-w/2,y+h/2,z]];points.forEach((p,i)=>segment(p,points[(i+1)%4],color));return points;}
  function block(x,y,z,w,h,depth,color){const front=rectangle(x,y,z+depth/2,w,h,color),back=rectangle(x,y,z-depth/2,w,h,color);front.forEach((p,i)=>segment(p,back[i],color));}
  block(0,0,0,...spec.body,'#777');
  rectangle(0,0,31,...spec.plate,'#f0eee8');
  const W=spec.plate[0],H=spec.plate[1],screen=spec.screen,glass=screen.size-screen.bezel*2;
  rectangle(0,H/2-screen.top-screen.size/2,32,glass,glass,'#aaa9a5');
  for(let i=0;i<4;i++){
    const x=-W/2+W/4*(i+.5),y=H/2-spec.encoders.rowHeight/2,r=spec.encoders.diameter/2;
    for(const z of [32,32+spec.encoders.height])for(let j=0;j<16;j++){
      const a=j*Math.PI/8,b=(j+1)*Math.PI/8;segment([x+r*Math.cos(a),y+r*Math.sin(a),z],[x+r*Math.cos(b),y+r*Math.sin(b),z],'#f0eee8');
      if(z===32&&j%4===0)segment([x+r*Math.cos(a),y+r*Math.sin(a),z],[x+r*Math.cos(a),y+r*Math.sin(a),z+spec.encoders.height],'#aaa9a5');
    }
    block(x,H/2-spec.keys.top-spec.keys.size/2,32+spec.keys.height/2,spec.keys.size-spec.keys.gap,spec.keys.size-spec.keys.gap,spec.keys.height,'#f0eee8');
  }
  const tiltX=-.2,tiltY=.35;
  function view([x,y,z]){const a=Math.cos(tiltY),b=Math.sin(tiltY),c=Math.cos(tiltX),d=Math.sin(tiltX);return [a*x+b*z,c*y-d*(-b*x+a*z),d*y+c*(-b*x+a*z)];}
  function draw(){
    const box=canvas.getBoundingClientRect();if(!box.width||!box.height)return;
    const ratio=devicePixelRatio||1;canvas.width=Math.round(box.width*ratio);canvas.height=Math.round(box.height*ratio);
    const ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);ctx.lineWidth=1;
    const scale=Math.min(box.width,box.height)/820;
    const project=point=>{const [x,y]=view(orientation.rotate(point));return [box.width/2+x*scale,box.height/2-y*scale];};
    for(const line of lines){const a=project(line.a),b=project(line.b);ctx.strokeStyle=line.color;ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();}
    ctx.font='10px Control,monospace';ctx.textAlign='center';ctx.textBaseline='middle';
    for(let axis=0;axis<3;axis++){
      const vector=[0,0,0];vector[axis]=240;const a=project([0,0,0]),b=project(vector);ctx.strokeStyle=ctx.fillStyle=colors[axis];ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();
      vector[axis]=265;ctx.fillText('XYZ'[axis],...project(vector));
    }
  }
  return {draw,update(gyro,threshold){orientation.update(gyro,threshold);},pause(){orientation.pause();},reset(){orientation.reset();draw();},get quaternion(){return orientation.quaternion;}};
}
function filterImuAcceleration(xyz,previous,threshold){return xyz.map((v,i)=>previous&&Math.abs(v-previous[i])<=threshold?previous[i]:v);}
function estimateImuThresholds(samples){
  if(samples.length<8)return null;
  if(samples.some((v,i)=>i>0&&(BigInt(v.completed_ns)<=BigInt(samples[i-1].completed_ns)||Number(BigInt(v.completed_ns)-BigInt(samples[i-1].completed_ns))/1e9>.3)))return {failed:true};
  const span=Number(BigInt(samples.at(-1).completed_ns)-BigInt(samples[0].completed_ns))/1e9;
  if(span<1)return null;
  const columns=kind=>[0,1,2].map(i=>samples.map(v=>v[kind].xyz[i]));
  const gyro=columns('gyro'),accel=columns('accel'),range=c=>Math.max(...c)-Math.min(...c);
  const peak=Math.max(...gyro.map(c=>Math.max(...c.map(Math.abs))));
  const gyroRange=Math.max(...gyro.map(range)),accelRange=Math.max(...accel.map(range));
  // Manual still calibration; stable motion cannot be distinguished from bias.
  if(peak>.3||gyroRange>.08||accelRange>.5)return {moving:true};
  const round=(v,max)=>Math.min(max,Math.max(.01,Math.ceil((v-1e-9)/.01)*.01));
  return {gyro:round(peak+Math.max(.005,gyroRange),.5),accel:round(accelRange+.01,1)};
}
