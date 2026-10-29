// Audio reactivity helpers for image viewers
(function(){
    // Audio enum codes (used by UI and shaders):
    // Band ranges: Low = first 10% bins (bass), Mid = 10%–40% bins (vocals), High = 40%–100% bins (treble)
    // motionTrigger: bitmask of bands driving motion (low/mid/high)
    // motionMode:    0 none, 1 pulse, 2 wave, 3 scatter, 4 glitch shake
    // motionAxis:    which axis to apply displacement (z/x/y/radial)
    // colorTrigger:  bitmask of bands driving colour (low/mid/high)
    // colorMode:     0 none, 1 twinkle, 2 glow, 3 hue shift, 4 glitch RGB, 5 invert, 99 custom (placeholder)
    const AUDIO_ENUMS = {
        motionTrigger: { low: 1, mid: 2, high: 4 },
        motionMode:    { none: 0, pulse: 1, wave: 2, scatter: 3, glitch: 4, custom: 99 },
        motionAxis:    { z: 0, x: 1, y: 2, radial: 3 },
        colorTrigger:  { low: 1, mid: 2, high: 4 },
        colorMode:     { none: 0, twinkle: 1, glow: 2, hue: 3, glitch: 4, invert: 5, custom: 99 }
    };

    const AUDIO_FEATURE_V2 = Object.freeze({
        contractVersion: 2,
        fftSize: 1024,
        lowHz: Object.freeze([40, 250]),
        midHz: Object.freeze([250, 2500]),
        highHz: Object.freeze([2500, 12000]),
        spectrumBands: 64,
        spectrumHz: Object.freeze([40, 12000])
    });

    function legacyFrequencyBins(bins){
        if (bins.length <= 256) return bins;
        const output = new Float32Array(256);
        const scale = bins.length / output.length;
        for(let index=0; index<output.length; index++){
            const start = Math.floor(index*scale);
            const end = Math.max(start+1, Math.floor((index+1)*scale));
            let sum=0;
            for(let sourceIndex=start; sourceIndex<Math.min(bins.length,end); sourceIndex++) sum+=bins[sourceIndex];
            output[index]=sum/Math.max(1,Math.min(bins.length,end)-start);
        }
        return output;
    }

    function bandPower(bins, sampleRate, fftSize, range){
        const hzPerBin = sampleRate/fftSize;
        const start = Math.max(1,Math.ceil(range[0]/hzPerBin));
        const end = Math.min(bins.length,Math.ceil(Math.min(range[1],sampleRate/2)/hzPerBin));
        let squareSum=0;
        for(let index=start; index<end; index++){
            const value=bins[index];
            squareSum+=value*value;
        }
        return squareSum;
    }

    // Log-spaced band levels in dB for spectrum visuals. Bands narrower than
    // one FFT bin interpolate the amplitude at their centre frequency.
    function spectrumBands(linearBins, sampleRate, fftSize){
        const count=AUDIO_FEATURE_V2.spectrumBands, low=AUDIO_FEATURE_V2.spectrumHz[0];
        const top=Math.min(AUDIO_FEATURE_V2.spectrumHz[1],sampleRate/2), hzPerBin=sampleRate/fftSize, span=Math.log(top/low);
        const output=new Float32Array(count);
        if(linearBins.length<2) return output.fill(-160);
        for(let band=0; band<count; band++){
            const start=low*Math.exp(span*band/count)/hzPerBin, end=low*Math.exp(span*(band+1)/count)/hzPerBin;
            let power=0, bins=0;
            for(let index=Math.ceil(start); index<end && index<linearBins.length; index++){ power+=linearBins[index]*linearBins[index]; bins++; }
            if(!bins){
                const centre=Math.sqrt(start*end), index=Math.min(linearBins.length-2,Math.floor(centre)), fraction=centre-index;
                const amplitude=linearBins[index]*(1-fraction)+linearBins[index+1]*fraction;
                power=amplitude*amplitude; bins=1;
            }
            output[band]=power>0 ? Math.max(-160,10*Math.log10(power/bins)) : -160;
        }
        return output;
    }

    function computeSceneSignalSample(frequencyBytes, timeBytes, options){
        const config = options || {};
        const bins = frequencyBytes && frequencyBytes.length ? frequencyBytes : new Uint8Array(0);
        const binCount = bins.length;
        const legacyBins = legacyFrequencyBins(bins);
        const legacyBinCount = legacyBins.length;
        const lowBound = Math.max(1, Math.floor(legacyBinCount*0.1));
        const midBound = Math.max(lowBound+1, Math.floor(legacyBinCount*0.4));
        let lowSum=0, midSum=0, highSum=0, magnitudeSum=0, centroidSum=0;
        for(let i=0;i<legacyBinCount;i++){
            const value = legacyBins[i]/255;
            if (i<lowBound) lowSum+=value;
            else if (i<midBound) midSum+=value;
            else highSum+=value;
            magnitudeSum+=value;
            centroidSum+=value*i;
        }
        let squareSum=0;
        const time = timeBytes && timeBytes.length ? timeBytes : new Uint8Array(0);
        for(let i=0;i<time.length;i++){
            const centered=(time[i]-128)/128;
            squareSum+=centered*centered;
        }
        const sampleRate = Number(config.sampleRate)>0 ? Number(config.sampleRate) : 48000;
        const fftSize = Number(config.fftSize)>0 ? Number(config.fftSize) : Math.max(2,binCount*2);
        // Analyser frequency bytes encode a dB interval, not linear amplitudes.
        // Keep the legacy byte means above; v2 uses unclipped linear amplitudes
        // for colour/flux and time-domain RMS for absolute level and gating.
        const minDb = Number.isFinite(config.minDecibels) ? config.minDecibels : -100;
        const maxDb = Number.isFinite(config.maxDecibels) && config.maxDecibels>minDb ? config.maxDecibels : -30;
        const amplitude = value => value>0 ? Math.pow(10,(minDb+(maxDb-minDb)*value/255)/20) : 0;
        const frequencyDb = config.frequencyDecibels;
        const previousDb = config.previousFrequencyDecibels;
        const fromDb = value => Number.isFinite(value) ? Math.pow(10,value/20) : 0;
        const linearBins = new Float64Array(binCount);
        for(let index=0; index<binCount; index++) linearBins[index]=frequencyDb && frequencyDb.length===binCount ? fromDb(frequencyDb[index]) : amplitude(bins[index]);
        const bandPowers = [AUDIO_FEATURE_V2.lowHz,AUDIO_FEATURE_V2.midHz,AUDIO_FEATURE_V2.highHz]
            .map(range=>bandPower(linearBins,sampleRate,fftSize,range));
        const bandPowerTotal=bandPowers.reduce((sum,value)=>sum+value,0);
        const timeSamples=config.timeSamples;
        let v2SquareSum=0;
        if(timeSamples && timeSamples.length){
            for(let index=0; index<timeSamples.length; index++) v2SquareSum+=timeSamples[index]*timeSamples[index];
        }
        const v2Energy=timeSamples && timeSamples.length ? Math.sqrt(v2SquareSum/timeSamples.length) : (time.length ? Math.sqrt(squareSum/time.length) : 0);
        const bandLevels=bandPowers.map(power=>bandPowerTotal>0 ? v2Energy*Math.sqrt(power/bandPowerTotal) : 0);
        const [v2Low,v2Mid,v2High]=bandLevels;
        const v2BandTotal=v2Low+v2Mid+v2High;
        const maxHz=Math.min(AUDIO_FEATURE_V2.highHz[1],sampleRate/2);
        const hzPerBin=sampleRate/fftSize;
        let v2PowerSum=0, v2FrequencySum=0, v2FluxSum=0, v2MagnitudeSum=0;
        const previous=config.previousFrequencyBytes;
        for(let index=1; index<binCount; index++){
            const hz=index*hzPerBin;
            if(hz<AUDIO_FEATURE_V2.lowHz[0] || hz>maxHz) continue;
            const magnitude=linearBins[index];
            const power=magnitude*magnitude;
            v2PowerSum+=power;
            v2FrequencySum+=power*hz;
            v2MagnitudeSum+=magnitude;
            if(previousDb && previousDb.length===binCount){
                v2FluxSum+=Math.max(0,magnitude-fromDb(previousDb[index]));
            } else if(previous && previous.length===binCount){
                v2FluxSum+=Math.max(0,magnitude-amplitude(previous[index]));
            }
        }
        const v2Brightness=v2PowerSum>0 && maxHz>AUDIO_FEATURE_V2.lowHz[0]
            ? Math.max(0,Math.min(1,(v2FrequencySum/v2PowerSum-AUDIO_FEATURE_V2.lowHz[0])/(maxHz-AUDIO_FEATURE_V2.lowHz[0])))
            : 0;
        return {
            raw_low: legacyBinCount ? lowSum/lowBound : 0,
            raw_mid: legacyBinCount ? midSum/Math.max(1,midBound-lowBound) : 0,
            raw_high: legacyBinCount ? highSum/Math.max(1,legacyBinCount-midBound) : 0,
            rms: time.length ? Math.sqrt(squareSum/time.length) : 0,
            centroid: magnitudeSum>0 && legacyBinCount>1 ? centroidSum/magnitudeSum/(legacyBinCount-1) : 0,
            v2_raw_energy: v2Energy,
            v2_raw_low: v2Low,
            v2_raw_mid: v2Mid,
            v2_raw_high: v2High,
            v2_low_share: v2BandTotal>0 ? v2Low/v2BandTotal : 0,
            v2_mid_share: v2BandTotal>0 ? v2Mid/v2BandTotal : 0,
            v2_high_share: v2BandTotal>0 ? v2High/v2BandTotal : 0,
            v2_brightness: v2Brightness,
            v2_flux: v2MagnitudeSum>0 ? v2FluxSum/v2MagnitudeSum : 0,
            v2_spectrum: spectrumBands(linearBins,sampleRate,fftSize)
        };
    }

    class AudioController {
        constructor(){
            this.audioContext = null;
            this.analyser = null;
            this.dataArray = null;
            this.timeDataArray = null;
            this.source = null;
            this.isActive = false;
            this.currentDeviceId = 'default';
            this.lastError = null;
            this.bands = this._emptyBands();
            this.previousFrequencyData = null;
            this.frequencyDecibels = null;
            this.timeSamples = null;
            this.previousFrequencyDecibels = null;
            this._startPromise = null;
        }
        _emptyBands(){
            return {
                low:0, mid:0, high:0,
                raw_low:0, raw_mid:0, raw_high:0,
                rms:0, centroid:0,
                v2_raw_energy:0, v2_raw_low:0, v2_raw_mid:0, v2_raw_high:0,
                v2_low_share:0, v2_mid_share:0, v2_high_share:0,
                v2_brightness:0, v2_flux:0, v2_spectrum:null
            };
        }
        async getDevices(){
            try {
                const permissionStream = await navigator.mediaDevices.getUserMedia({ audio:true });
                permissionStream.getTracks().forEach(track => track.stop());
            } catch(_){}
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.filter(d=>d.kind==='audioinput');
        }
        async start(deviceId='default'){
            if (this._startPromise) {
                try { await this._startPromise; } catch(_){}
                return this.isActive;
            }
            await this.stop();
            this.lastError = null;
            this._startPromise = (async()=>{
                const ctx = new (window.AudioContext||window.webkitAudioContext)();
                try {
                    const analyser = ctx.createAnalyser();
                    analyser.fftSize = AUDIO_FEATURE_V2.fftSize;
                    analyser.smoothingTimeConstant = 0;
                    const dataArray = new Uint8Array(analyser.frequencyBinCount);
                    const timeDataArray = new Uint8Array(analyser.fftSize);
                    const constraints = { audio:{ deviceId: deviceId!=='default' ? { exact:deviceId } : undefined } };
                    const stream = await navigator.mediaDevices.getUserMedia(constraints);
                    // if another start replaced context, abort this one
                    if (this.audioContext && this.audioContext !== ctx) {
                        try { stream.getTracks().forEach(t=>t.stop()); } catch(_){}
                        try { ctx.close(); } catch(_){}
                        return false;
                    }
                    this.audioContext = ctx;
                    this.analyser = analyser;
                    this.dataArray = dataArray;
                    this.timeDataArray = timeDataArray;
                    this.source = this.audioContext.createMediaStreamSource(stream);
                    this.source.connect(this.analyser);
                    // Ensure context is running (may require user gesture on mobile)
                    try { if (this.audioContext.state !== 'running') await this.audioContext.resume(); } catch(_){}
                    this.isActive = this.audioContext.state === 'running';
                    this.currentDeviceId = deviceId;
                    if (!this.isActive) {
                        console.warn('[AudioController] audioContext not running (awaiting user gesture?)');
                    }
                    return this.isActive;
                } catch(err){
                    if (err && err.name === 'NotAllowedError') console.warn('[AudioController] microphone permission denied', err);
                    else console.error('[AudioController] start failed', err);
                    this.lastError = err;
                    this.isActive = false;
                    try { ctx.close(); } catch(_){}
                    return false;
                } finally {
                    this._startPromise = null;
                }
            })();
            return this._startPromise;
        }
        async stop(){
            if (this.source){
                try { this.source.disconnect(); } catch(_){}
                if (this.source.mediaStream){
                    try { this.source.mediaStream.getTracks().forEach(t=>t.stop()); } catch(_){}
                }
                this.source = null;
            }
            if (this.audioContext){
                try { await this.audioContext.close(); } catch(_){}
                this.audioContext = null;
            }
            this.analyser = null;
            this.dataArray = null;
            this.timeDataArray = null;
            this.previousFrequencyData = null;
            this.frequencyDecibels = null;
            this.timeSamples = null;
            this.previousFrequencyDecibels = null;
            this.isActive = false;
            this.bands = this._emptyBands();
        }
        update(){
            if (!this.isActive || !this.analyser){
                this.bands.low*=0.9; this.bands.mid*=0.9; this.bands.high*=0.9;
                this.bands.raw_low=0; this.bands.raw_mid=0; this.bands.raw_high=0; this.bands.rms=0; this.bands.centroid=0;
                this.bands.v2_raw_energy=0; this.bands.v2_raw_low=0; this.bands.v2_raw_mid=0; this.bands.v2_raw_high=0;
                this.bands.v2_low_share=0; this.bands.v2_mid_share=0; this.bands.v2_high_share=0;
                this.bands.v2_brightness=0; this.bands.v2_flux=0; this.bands.v2_spectrum=null;
                return this.bands;
            }
            this.analyser.getByteFrequencyData(this.dataArray);
            this.analyser.getByteTimeDomainData(this.timeDataArray);
            if(!this.frequencyDecibels || this.frequencyDecibels.length!==this.dataArray.length) this.frequencyDecibels=new Float32Array(this.dataArray.length);
            if(!this.timeSamples || this.timeSamples.length!==this.analyser.fftSize) this.timeSamples=new Float32Array(this.analyser.fftSize);
            this.analyser.getFloatFrequencyData(this.frequencyDecibels);
            this.analyser.getFloatTimeDomainData(this.timeSamples);
            const sample = computeSceneSignalSample(this.dataArray, this.timeDataArray, {
                sampleRate: this.audioContext && this.audioContext.sampleRate,
                fftSize: this.analyser.fftSize,
                minDecibels: this.analyser.minDecibels,
                maxDecibels: this.analyser.maxDecibels,
                frequencyDecibels: this.frequencyDecibels,
                timeSamples: this.timeSamples,
                previousFrequencyDecibels: this.previousFrequencyDecibels,
                previousFrequencyBytes: this.previousFrequencyData
            });
            if(!this.previousFrequencyData || this.previousFrequencyData.length!==this.dataArray.length) this.previousFrequencyData=new Uint8Array(this.dataArray.length);
            this.previousFrequencyData.set(this.dataArray);
            if(!this.previousFrequencyDecibels || this.previousFrequencyDecibels.length!==this.dataArray.length) this.previousFrequencyDecibels=new Float32Array(this.dataArray.length);
            this.previousFrequencyDecibels.set(this.frequencyDecibels);
            const tLow = sample.raw_low;
            const tMid = sample.raw_mid;
            const tHigh = sample.raw_high;
            const attack=0.9, decay=0.15;
            this.bands.low += (tLow - this.bands.low)*(tLow>this.bands.low?attack:decay);
            this.bands.mid += (tMid - this.bands.mid)*(tMid>this.bands.mid?attack:decay);
            this.bands.high+= (tHigh- this.bands.high)*(tHigh>this.bands.high?attack:decay);
            // Apply noise floor to suppress quiet background noise
            const floor = (this.noiseFloor || 0.01);
            this.bands.low = Math.max(0, this.bands.low - floor);
            this.bands.mid = Math.max(0, this.bands.mid - floor);
            this.bands.high = Math.max(0, this.bands.high - floor);
            this.bands.raw_low=sample.raw_low; this.bands.raw_mid=sample.raw_mid; this.bands.raw_high=sample.raw_high;
            Object.assign(this.bands,sample);
            return this.bands;
        }
    }

    const api = {
        AudioController,
        AUDIO_ENUMS,
        AUDIO_FEATURE_V2,
        computeSceneSignalSample
    };
    if (typeof window !== 'undefined') window.VrchImageAudio = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})();
