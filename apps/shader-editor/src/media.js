/* Media selection through the Apps SDK; no host credentials or capture APIs. */
(() => {
  'use strict';
  const empty = key => ({kind: key === 'audio' ? 'off' : 'sample', label: key === 'audio' ? 'Off' : 'Sample'});
  class ShaderMedia {
    constructor({sdk, mount, onChange}) {
      this.sdk = sdk; this.mount = mount; this.onChange = onChange;
      this.selection = {}; this.choices = {}; this.sessions = {}; this.rows = {}; this.sources = {};
      this.mirror = null; this.enabled = false; this.count = 0;
      this.menu = VrchPagesLiveConsoleActionPopover.createActionPopoverController({document, window});
      for (const [key, label] of [['audio', 'Audio'], ['A', 'Image A'], ['B', 'Image B']]) {
        const row = document.createElement('div'); row.className = 'ui-panel__header shader-media-row';
        const name = document.createElement('span'); name.className = 'ui-control-label'; name.textContent = label;
        const actions = document.createElement('div'); actions.className = 'ui-panel__actions';
        const status = document.createElement('span'); status.className = 'scene-preset-save-state'; status.setAttribute('role', 'status');
        const button = document.createElement('button'); button.type = 'button'; button.className = 'ui-btn--sm'; button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-label', label + ' source');
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'ui-btn--sm'; retry.textContent = 'Retry'; retry.hidden = true;
        actions.append(status, button, retry); row.append(name, actions); mount.append(row);
        this.rows[key] = {row, name, button, status, retry};
        button.addEventListener('click', () => this.openMenu(key));
        retry.addEventListener('click', () => this.start(key));
      }
      this.unsubscribe = sdk.audio.onAvailable(() => {
        if (this.enabled && this.choices.audio?.kind === 'device') this.refreshAudioChoice().catch(() => {});
      });
      this.restore({});
    }
    restore(value) {
      this.stop();
      for (const key of ['audio', 'A', 'B']) {
        const choice = value?.[key];
        this.choices[key] = choice && (['device', 'camera', 'sample', 'off'].includes(choice.kind) || choice.kind === 'channel' && Number.isInteger(choice.channel) && choice.channel >= 1 && choice.channel <= 8) ? {...choice} : empty(key);
        this.render(key);
      }
    }
    render(key, message = '', error = false) {
      const row = this.rows[key];
      row.button.textContent = this.choices[key].label;
      row.status.textContent = message; row.status.hidden = !message; row.retry.hidden = !error;
    }
    async refreshAudioChoice() {
      const state = await this.sdk.audio.devices();
      if (!this.enabled || this.choices.audio.kind !== 'device') return;
      const selected = state.devices.find(item => item.id === state.selected);
      if (selected && this.choices.audio.id !== selected.id) {
        this.choices.audio = {kind: 'device', id: selected.id, label: selected.label};
        this.rows.audio.button.textContent = selected.label; this.onChange(this.choices);
      }
    }
    async openMenu(key) {
      const row = this.rows[key]; row.button.disabled = true;
      let devices = [], issue = '';
      try {
        const state = await (key === 'audio' ? this.sdk.audio.devices() : this.sdk.camera.devices());
        devices = state.devices || [];
      } catch (error) { issue = this.message(error); }
      finally { row.button.disabled = false; }
      const items = [{id: 'none', label: empty(key).label, choice: empty(key)}];
      for (const device of devices) if (device.available !== false) items.push({id: 'device:' + device.id, label: device.label, choice: {kind: key === 'audio' ? 'device' : 'camera', id: device.id, label: device.label}});
      for (let channel = 1; channel <= 8; channel++) items.push({id: 'channel:' + channel, label: 'Channel ' + channel, choice: {kind: 'channel', channel, label: 'Channel ' + channel}});
      for (const item of items) item.current = JSON.stringify(item.choice) === JSON.stringify(this.choices[key]);
      if (issue) this.render(key, issue);
      this.menu.open(row.button, items, {className: 'scene-v2-choice-popover', scrollable: true, align: 'right', onSelect: item => this.select(key, item.choice)});
    }
    async select(key, choice) {
      const selection = this.selection[key] = {};
      // The host owns the audio route; its Device menu and this control share it.
      if (key === 'audio' && choice.kind === 'device') {
        try { await this.sdk.audio.selectInput(choice.id); }
        catch (error) { this.render(key, this.message(error), true); return; }
      }
      if (this.selection[key] !== selection) return;
      this.choices[key] = {...choice}; this.onChange(this.choices); this.render(key);
      if (this.enabled) await this.start(key);
    }
    resume(mirror, definition) {
      this.mirror = mirror; this.enabled = true;
      this.count = definition?.runtime?.max_sources ?? 1;
      const tracking = definition?.analysis_requirements?.[0];
      for (const [index, key] of ['A', 'B'].entries()) {
        const kind = tracking?.source_input === index ? ({hand: 'Hand', face: 'Face', pose: 'Body'}[tracking.kind] || '') : '';
        this.rows[key].name.textContent = 'Image ' + key + (kind ? ' · ' + kind : '');
      }
      for (const key of ['audio', 'A', 'B']) {
        const visible = key === 'audio' || key === 'A' && this.count > 0 || key === 'B' && this.count > 1;
        this.rows[key].row.hidden = !visible;
        if (visible && !this.sessions[key]) void this.start(key);
        else if (!visible) this.close(key);
      }
      this.updateSources();
    }
    close(key) {
      const session = this.sessions[key]; delete this.sessions[key];
      if (session) {
        session.cancelled = true;
        void session.handle?.close().catch(() => {});
        for (const node of session.nodes || []) { try { node.stop(); node.disconnect(); } catch (_) {} }
        void session.context?.close().catch(() => {});
      }
      delete this.sources[key];
      if (key === 'audio') this.mirror?.setAudioProvider(null); else this.updateSources();
    }
    updateSources() { this.mirror?.setSources(this.sources.A, this.count > 1 ? this.sources.B : this.sources.A); }
    stop() { this.enabled = false; for (const key of ['audio', 'A', 'B']) this.close(key); }
    message(error) {
      if (error.code === 'preview_io_disabled') return 'Use on device';
      if (error.code === 'permission_required' || error.code === 'capability_not_granted' || error.code === 'capability_required' || error.name === 'NotAllowedError') return 'Allow in Device Access';
      if (error.code === 'audio_device_unavailable') return 'Input unavailable';
      if (error.code === 'interaction_required') return 'Tap Retry to start';
      if (error.code === 'connection_interrupted') return 'Disconnected';
      if (error.code === 'unsupported_environment') return 'Unavailable here';
      return 'Source unavailable';
    }
    async start(key) {
      this.close(key);
      const choice = this.choices[key]; this.render(key);
      if (!this.enabled || ['off', 'sample'].includes(choice.kind)) return;
      const session = {cancelled: false, nodes: new Set()}; this.sessions[key] = session;
      const live = () => !session.cancelled && this.enabled;
      const status = (text, error = false) => { if (live()) this.render(key, text, error); };
      const failed = error => { if (live()) { this.close(key); this.render(key, this.message(error), true); } };
      status('Connecting');
      try {
        const opened = choice.kind === 'device' ? await this.sdk.audio.openInput({channels: 1, echoCancellation: false})
          : choice.kind === 'camera' ? await this.sdk.camera.open({deviceId: choice.id, width: 640, height: 480, frameRate: 30})
          : await this.sdk.websocket.open({channel: choice.channel, format: key === 'audio' ? 'audio' : 'image'});
        if (!live()) { await opened.close(); return; }
        session.handle = opened; opened.onError(failed);
        if (key === 'audio') {
          if (opened.silent) { status('Silent in Preview'); return; }
          await this.prepareAudio(session, live);
          if (!live()) return;
          this.mirror.setAudioProvider(() => this.sample(session));
          if (choice.kind === 'device') {
            await this.refreshAudioChoice();
            opened.onData(samples => {
              if (!live()) return;
              const buffer = session.context.createBuffer(1, samples.length, 48000);
              buffer.copyToChannel(samples, 0); this.play(session, buffer, true); status('');
            });
          } else {
            this.latest(session, live, opened, async data => {
              const message = typeof data === 'string' ? JSON.parse(data) : null;
              const base64 = message?.base64_data || message?.audio?.base64;
              const bytes = base64 ? Uint8Array.from(atob(base64), char => char.charCodeAt(0)).buffer : data;
              if (!(bytes instanceof ArrayBuffer)) throw Error('Unsupported audio message');
              const decoded = await session.context.decodeAudioData(bytes.slice(0));
              if (live()) { this.play(session, decoded, false); status(''); }
            }, status);
          }
        } else {
          const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
          const draw = frame => {
            if (!live()) return;
            const width = frame.displayWidth || frame.width, height = frame.displayHeight || frame.height;
            const scale = Math.min(1, 1280 / Math.max(width, height));
            const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
            if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
            ctx.drawImage(frame, 0, 0, canvas.width, canvas.height); this.sources[key] = canvas; this.updateSources(); status('');
          };
          if (choice.kind === 'camera') opened.onFrame(draw);
          else this.latest(session, live, opened, async data => {
            if (!(data instanceof ArrayBuffer) || data.byteLength <= 8) throw Error('Unsupported image message');
            const bitmap = await createImageBitmap(new Blob([data.slice(8)]));
            try { draw(bitmap); } finally { bitmap.close(); }
          }, status);
        }
        status('Waiting for data');
      } catch (error) { failed(error); }
    }
    latest(session, live, handle, consume, status) {
      let busy = false, pending;
      handle.onMessage(data => {
        pending = data;
        if (busy) return;
        busy = true;
        void (async () => {
          try {
            while (live() && pending !== undefined) {
              const value = pending; pending = undefined;
              try { await consume(value); } catch (_) { status('Unreadable media', true); }
            }
          } finally { busy = false; pending = undefined; }
        })();
      });
    }
    async prepareAudio(session, live) {
      const context = new AudioContext({sampleRate: 48000, sinkId: {type: 'none'}}); session.context = context;
      if (context.state !== 'running') {
        void context.resume();
        // Do not hold a pending media start behind an autoplay gesture.
        await new Promise(resolve => setTimeout(resolve, 50));
        if (live() && context.state !== 'running') throw Object.assign(Error('Tap Retry to start'), {code: 'interaction_required'});
      }
      if (!live()) return;
      const analyser = context.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0;
      const mute = context.createGain(); mute.gain.value = 0; analyser.connect(mute).connect(context.destination);
      Object.assign(session, {analyser, frequency: new Uint8Array(512), time: new Uint8Array(1024), db: new Float32Array(512), previous: new Float32Array(512).fill(-Infinity), samples: new Float32Array(1024), next: 0});
    }
    play(session, buffer, continuous) {
      const context = session.context;
      if (!continuous) for (const node of session.nodes) { node.stop(); node.disconnect(); }
      if (!continuous) session.nodes.clear();
      if (session.nodes.size >= 6 && continuous) return;
      const node = context.createBufferSource(); node.buffer = buffer; node.connect(session.analyser); session.nodes.add(node);
      node.onended = () => { node.disconnect(); session.nodes.delete(node); };
      const at = continuous ? Math.max(context.currentTime + .02, Math.min(session.next, context.currentTime + .1)) : context.currentTime;
      node.start(at); session.next = at + buffer.duration;
    }
    sample(session) {
      const a = session.analyser; if (!a || session.cancelled) return null;
      a.getByteFrequencyData(session.frequency); a.getByteTimeDomainData(session.time); a.getFloatFrequencyData(session.db); a.getFloatTimeDomainData(session.samples);
      const sample = VrchImageAudio.computeSceneSignalSample(session.frequency, session.time, {sampleRate: 48000, fftSize: 1024, frequencyDecibels: session.db, previousFrequencyDecibels: session.previous, timeSamples: session.samples});
      session.previous.set(session.db); return sample;
    }
    dispose() { this.stop(); this.unsubscribe(); this.menu.close?.(); }
  }
  window.ShaderMedia = ShaderMedia;
})();
