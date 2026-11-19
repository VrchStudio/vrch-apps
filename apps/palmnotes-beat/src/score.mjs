export function readScore(score) {
  if (typeof score?.title !== 'string' || !score.title.trim() || score.title.length > 80 ||
      !Number.isFinite(score.bpm) || score.bpm < 30 || score.bpm > 180 ||
      !Array.isArray(score.notes) || !score.notes.length || score.notes.length > 4096)
    throw Error('Check the title, tempo (30–180 BPM) and notes.');
  let beats = 0;
  const notes = score.notes.map((row, i) => {
    if (!Array.isArray(row) || row.length < 2 || row.length > 3) throw Error('Note '+(i+1)+' needs pitch and duration.');
    const [n, duration, oct = 0] = row;
    if (!Number.isInteger(n) || n < 0 || n > 7 || !Number.isFinite(duration) || duration <= 0 || duration > 64 || ![-1,0,1].includes(oct))
      throw Error('Note '+(i+1)+' has an invalid pitch, duration or octave.');
    const note = {n, oct, at: beats, duration, index:i};
    beats += duration;
    return note;
  });
  const total = notes.filter(note => note.n).length;
  if (!total) throw Error('Include at least one playable note.');
  return {title:score.title.trim(), bpm:score.bpm, bar:score.bar===2?2:4, notes, beats, total};
}

export class Round {
  constructor(score, bpm, start, follow=false) {
    this.follow=follow; this.score = score; this.beatMs = 60000/bpm; this.start = start;
    this.cursor = 0; this.hits = 0; this.combo = 0; this.best = 0;
    this.results = new Map(); this.feedback = ''; this.feedbackAt = -Infinity;
  }
  beat(now) {
    const elapsed=(now-this.start)/this.beatMs;
    const next=this.score.notes[this.cursor];
    return this.follow && next?.n && !this.results.has(this.cursor) ? Math.min(elapsed,next.at) : elapsed;
  }
  limit(index, direction) {
    const notes = this.score.notes, other = notes[index+direction];
    const gap = other ? Math.abs(other.at-notes[index].at)*this.beatMs/2 : Infinity;
    return Math.min(direction < 0 ? 220 : 320, gap);
  }
  advance(at) {
    const notes = this.score.notes;
    while (this.cursor < notes.length) {
      const i = this.cursor, note = notes[i];
      if (this.follow && this.results.has(i)) {this.cursor++;continue;}
      if (this.follow && note.n) break;
      if (this.follow && !note.n) {
        if (at < this.start+(note.at+note.duration)*this.beatMs) break;
        this.cursor++;
        continue;
      }
      if (at <= this.start+note.at*this.beatMs+this.limit(i,1)) break;
      if (note.n && !this.results.has(i)) {
        this.combo=0; this.results.set(i,false); this.feedback='Miss'; this.feedbackAt=at;
      }
      this.cursor++;
    }
  }
  strike(n, oct, onset, now) {
    this.advance(onset);
    const notes=this.score.notes;
    for (let i=this.cursor; i<notes.length; i++) {
      const note=notes[i], error=onset-this.start-note.at*this.beatMs;
      if(this.follow && !note.n && onset < this.start+(note.at+note.duration)*this.beatMs) break;
      if(!this.follow && error < -this.limit(i,-1)) break;
      if(!note.n || this.results.has(i) || (!this.follow && error>this.limit(i,1))) continue;
      if(note.n!==n || note.oct!==oct) {this.feedback='Try again';this.feedbackAt=now;return;}
      if(this.follow)this.start+=error;
      this.results.set(i,true); this.hits++; this.combo++; this.best=Math.max(this.best,this.combo);
      this.feedback=this.combo%5===0?this.combo+' in a row!':Math.abs(error)<=120?'Perfect!':'Hit'; this.feedbackAt=now; return;
    }
  }
  done(now) { return now >= this.start+this.score.beats*this.beatMs && this.cursor >= this.score.notes.length; }
}
