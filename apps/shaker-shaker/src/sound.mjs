import {Shaker} from './model.mjs';
class ShakerProcessor extends AudioWorkletProcessor {
 constructor(){super();this.engine=new Shaker(sampleRate);this.frames=0;this.closed=false;this.port.onmessage=({data:d})=>{if(d.type==='motion')this.engine.input(d.accel,d.gyro);if(d.type==='settings')this.engine.configure(d.value);if(d.type==='grip')this.engine.grip=d.value;if(d.type==='mute')this.engine.muted=d.value;if(d.type==='tap')this.engine.tap();if(d.type==='reset')this.engine.reset();if(d.type==='missing'){this.engine.sensor=false;this.engine.energy=0;}if(d.type==='close')this.closed=true;};}
 process(_,outputs){if(this.closed)return false;this.engine.render(outputs[0][0]);if((this.frames+=outputs[0][0].length)>=2400){this.frames=0;this.port.postMessage(this.engine.snapshot());}return true;}
}
registerProcessor('shaker-lab',ShakerProcessor);
