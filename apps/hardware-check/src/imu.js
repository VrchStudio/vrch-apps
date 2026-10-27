'use strict';
function createImuTest(onChange=()=>{}) {
  const get=id=>document.getElementById(id),colors=['#ff8297','#7bd4ad','#88b6ef'];
  const model=createImuWireframe(get('imuModel')),held=new Set(),rates=[10,25,50];
  const state=window.imuCheck={state:'idle',samples:0,latest:null,history:[],enabled:true,targetHz:50,gyroThreshold:.1,accelThreshold:.1,calibration:'idle',orientation:model.quaternion};
  let active=false,epoch=0,timer=null,busy=false,origin=null,lastTime=null,gap=true;
  let closing=Promise.resolve(),monitorState='',cadenceAfter=null;
  let accelPlot=null,holdTimer=null,longPress=false,calibration=[];
  const preview=VrchApp.context.mode!=='device';
  const receiving=()=>active&&(state.enabled||state.calibration==='collecting')&&!preview;
  function draw(kind){
    const canvas=get('imu'+kind+'Chart'),box=canvas.getBoundingClientRect();
    if(!box.width||!box.height)return;
    const ratio=devicePixelRatio||1;canvas.width=Math.round(box.width*ratio);canvas.height=Math.round(box.height*ratio);
    const ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);
    const width=box.width,height=box.height,left=35,right=width-5,top=6,bottom=height-6;
    const points=state.history,end=points.at(-1)?.time||0;
    let limit=kind==='gyro'?.1:10;
    const values=point=>kind==='accel'?point.accelPlot:point.gyro;
    for(const point of points)for(const value of values(point))limit=Math.max(limit,Math.abs(value));
    limit=Math.ceil(limit*10)/10;
    ctx.font='9px Control,monospace';ctx.fillStyle='#8e8e8e';ctx.textBaseline='middle';
    ctx.fillText('+'+limit.toFixed(1),0,top);ctx.fillText('0',0,(top+bottom)/2);ctx.fillText('−'+limit.toFixed(1),0,bottom);
    ctx.strokeStyle='#353535';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(left,(top+bottom)/2);ctx.lineTo(right,(top+bottom)/2);ctx.stroke();
    const x=time=>left+(time-(end-60))/60*(right-left),y=value=>top+(1-value/limit)/2*(bottom-top);
    for(let axis=0;axis<3;axis++){
      ctx.strokeStyle=colors[axis];ctx.lineWidth=1.5;ctx.beginPath();
      points.forEach((point,index)=>{if(index===0||point.break)ctx.moveTo(x(point.time),y(values(point)[axis]));else ctx.lineTo(x(point.time),y(values(point)[axis]));});ctx.stroke();
      if(points.length){const point=points.at(-1);ctx.fillStyle=colors[axis];ctx.beginPath();ctx.arc(x(point.time),y(values(point)[axis]),2,0,2*Math.PI);ctx.fill();}
    }
  }
  function changed(){const next=[state.enabled,state.targetHz,state.state,state.gyroThreshold,state.accelThreshold,state.calibration,...held].join('|');if(next!==monitorState){monitorState=next;onChange();}}
  function render(){
    get('imugyroThreshold').textContent='Threshold '+state.gyroThreshold.toFixed(2)+' rad/s';
    get('imuaccelThreshold').textContent='Threshold '+state.accelThreshold.toFixed(2)+' m/s²';
    const valid=state.state==='live'||state.state==='off'&&!!state.latest,hasHistory=state.history.length>0;
    get('imuState').textContent=({idle:'Ready',off:'Stopped',reading:'Reading…',live:'Live',missing:'No IMU',disconnected:'Disconnected',error:'Read failed · retrying',preview:'Device only'})[state.state]||'Unavailable';
    get('imuState').classList.toggle('is-error',state.state==='error');
    if(state.calibration==='collecting')get('imuState').textContent='Keep still · calibrating';
    else if(state.calibration==='moving')get('imuState').textContent+=' · moved, retry hold K4';
    else if(state.calibration==='failed')get('imuState').textContent+=' · calibration failed';
    else if(state.calibration==='done')get('imuState').textContent+=' · calibrated';
    get('imuEmpty').hidden=valid||hasHistory;
    get('imuEmpty').textContent=state.state==='off'?'Detection stopped. Press K2 to start.':state.state==='missing'?'No IMU connected.':state.state==='disconnected'?'IMU disconnected. Waiting for the device.':state.state==='preview'?'Run on the device to read its IMU.':state.state==='error'?'IMU read failed. Retrying…':'Reading the motion sensor…';
    for(const kind of ['gyro','accel']){
      get('imu'+kind+'Section').hidden=!(valid||hasHistory);
      for(let axis=0;axis<3;axis++)get('imu'+kind+axis).textContent=valid?state.latest[kind].xyz[axis].toFixed(3):'—';
      draw(kind);
    }
    if(state.state!=='live')get('imuCadence').textContent='';
    state.orientation=model.quaternion;model.draw();changed();
  }
  function schedule(delay){clearTimeout(timer);if(receiving())timer=setTimeout(poll,delay);}
  async function poll(){
    if(!receiving()||busy)return;
    busy=true;const request=epoch,started=performance.now();
    try{
      await VrchApp.ready();await closing;
      if(request!==epoch||!receiving())return;
      if(!VrchApp.imu)throw new Error('IMU support unavailable');
      const value=await VrchApp.imu.read();
      if(request!==epoch||!receiving())return;
      if(value.state==='valid'){
        const timestamp=BigInt(value.completed_ns);
        if(origin===null||timestamp<origin){origin=timestamp;state.history=[];lastTime=null;cadenceAfter=null;gap=true;model.pause();}
        const time=Number(timestamp-origin)/1e9;
        if(lastTime!==null&&time<=lastTime)throw new Error('IMU timestamp did not advance');
        state.latest=value;state.samples++;state.state=state.enabled?'live':'off';
        if(state.calibration==='collecting'){
          calibration.push(value);
          const result=estimateImuThresholds(calibration);
          if(result){
            if(result.failed){state.calibration='failed';}
            else if(result.moving){state.calibration='moving';}
            else{state.gyroThreshold=result.gyro;state.accelThreshold=result.accel;state.calibration='done';state.history=[];origin=timestamp;lastTime=null;cadenceAfter=null;accelPlot=null;model.reset();}
            calibration=[];gap=true;model.pause();if(!state.enabled)release();
          }
          render();return;
        }
        accelPlot=filterImuAcceleration(value.accel.xyz,accelPlot,state.accelThreshold);
        state.history.push({time,gyro:[...value.gyro.xyz],accel:[...value.accel.xyz],accelPlot:[...accelPlot],break:gap});
        state.history=state.history.filter(point=>point.time>=time-60).slice(-3200);
        if(gap)model.pause();model.update(value.gyro,state.gyroThreshold);
        gap=false;lastTime=time;render();
        const recent=state.history.slice(Math.max(0,state.history.length-20,state.history.findLastIndex(p=>p.break))).filter(p=>cadenceAfter===null||p.time>cadenceAfter);
        const span=recent.length>1?recent.at(-1).time-recent[0].time:0;
        get('imuCadence').textContent=span>0?((recent.length-1)/span).toFixed(0)+' Hz':'';
      }else{
        if(state.calibration==='collecting'){cancelCalibration('failed');if(!state.enabled)release();}
        state.state=value.state==='not_ready'?(state.samples?'disconnected':'missing'):'error';state.latest=null;gap=true;model.pause();render();
      }
    }catch(error){
      if(request!==epoch||!receiving())return;
      if(state.calibration==='collecting'){cancelCalibration('failed');if(!state.enabled)release();}
      state.state=error.code==='preview_io_disabled'?'preview':'error';
      state.latest=null;gap=true;model.pause();render();
    }finally{
      busy=false;
      if(receiving())schedule(request!==epoch?0:state.state==='live'||state.calibration==='collecting'?Math.max(0,1000/state.targetHz-(performance.now()-started)):2000);
    }
  }
  function release(){if(!preview)closing=VrchApp.imu?.close().catch(()=>{})||Promise.resolve();}
  function cancelCalibration(next='idle'){calibration=[];state.calibration=next;model.pause();}
  function cancelHold(){clearTimeout(holdTimer);holdTimer=null;}
  function reset(){
    cancelCalibration();cancelHold();++epoch;clearTimeout(timer);state.history=[];state.samples=0;state.latest=null;origin=null;lastTime=null;cadenceAfter=null;accelPlot=null;gap=true;model.reset();
    if(!state.enabled)release();
    state.state=preview?'preview':state.enabled?'reading':'off';render();if(active&&state.enabled&&!preview)schedule(0);
  }
  function toggle(){
    if(preview)return;
    cancelCalibration();state.enabled=!state.enabled;++epoch;clearTimeout(timer);gap=true;model.pause();
    state.state=state.enabled?'reading':'off';render();
    if(state.enabled)schedule(0);else release();
  }
  function calibrate(){
    if(preview||!active)return;
    reset();state.calibration='collecting';render();schedule(0);
  }
  const resize=new ResizeObserver(()=>{if(active){draw('gyro');draw('accel');model.draw();}});resize.observe(get('imuPanel'));
  return {
    enter(){active=true;++epoch;gap=true;model.pause();state.state=preview?'preview':state.enabled?'reading':'off';if(state.enabled)state.latest=null;render();if(state.enabled&&!preview)schedule(0);},
    leave(){active=false;++epoch;clearTimeout(timer);cancelHold();cancelCalibration();held.clear();gap=true;model.pause();release();changed();},
    reset,
    close(){this.leave();resize.disconnect();},
    handle(event){
      if(!['E1','E2','K2','K3','K4'].includes(event.control))return false;
      if(event.type==='rotate'&&['E1','E2'].includes(event.control)){
        cancelCalibration();if(!state.enabled)release();const delta=Number(event.delta)||0;
        const name=event.control==='E1'?'gyroThreshold':'accelThreshold',max=event.control==='E1'?.5:1;
        state[name]=Math.max(0,Math.min(max,Math.round((state[name]-delta*.01)*100)/100));
        accelPlot=null;model.pause();render();return true;
      }
      if(event.type==='up'||event.type==='cancel'){
        if(event.control==='K4'){cancelHold();if(event.type==='up'&&held.has('K4')&&!longPress)reset();}
        held.delete(event.control);changed();return true;
      }
      if(event.type!=='down'||held.has(event.control))return true;
      held.add(event.control);
      if(event.control==='K2')toggle();
      if(event.control==='K3'){state.targetHz=rates[(rates.indexOf(state.targetHz)+1)%rates.length];cadenceAfter=lastTime;get('imuCadence').textContent='';if(state.state==='live')schedule(0);}
      if(event.control==='K4'){longPress=false;holdTimer=setTimeout(()=>{if(held.has('K4')){longPress=true;calibrate();}},650);}
      changed();return true;
    },
    monitor(){
      return {...Object.fromEntries(['E3','E4'].map(id=>[id,{label:'',value:'',pressed:false}])),
        E1:{label:'Gyr thresh',value:state.gyroThreshold.toFixed(2),pressed:held.has('E1')},E2:{label:'Acc thresh',value:state.accelThreshold.toFixed(2),pressed:held.has('E2')},
        K2:{label:preview?'Start':state.enabled?'Stop':'Start',value:preview?'Device':({off:'Off',reading:'Opening',live:'Live',missing:'No IMU',disconnected:'No IMU',error:'Retrying'})[state.state]||'Off',pressed:held.has('K2')},
        K3:{label:'Rate',value:state.targetHz+' Hz',pressed:held.has('K3')},K4:{label:'Reset',value:state.calibration==='collecting'?'Cal':state.calibration==='done'?'Set':'',pressed:held.has('K4')}};
    }
  };
}
