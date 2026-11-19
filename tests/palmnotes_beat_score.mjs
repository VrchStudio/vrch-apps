import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readScore,Round} from '../apps/palmnotes-beat/src/score.mjs';

const library=JSON.parse(readFileSync(new URL('../apps/palmnotes-beat/src/scores.json',import.meta.url)));
assert.equal(library.length,7);
for(const source of library) {
  const score=readScore(source), round=new Round(score,score.bpm,4000);
  for(const note of score.notes){
    const at=round.start+note.at*round.beatMs;
    if(note.n)round.strike(note.n,note.oct,at,at+100);
  }
  const end=round.start+score.beats*round.beatMs+400;
  round.advance(end);
  assert.equal(round.hits,score.total,score.title);
  assert.equal(round.best,score.total,score.title);
  assert.ok(round.done(end),score.title);
}
const short=readScore({title:'重复音、休止与低 Sol',bpm:60,notes:[[1,1],[1,1],[0,1],[5,1,-1]]});
const round=new Round(short,60,1000);
round.strike(2,0,955,1070);
assert.equal(round.hits,0);
round.strike(1,0,1050,1160);
round.strike(1,0,1060,1170);
assert.equal(round.hits,1);
round.advance(2400);
assert.equal(round.combo,0);
round.strike(5,0,4000,4110);
round.strike(5,-1,4055,4165);
assert.equal(round.hits,2);
assert.equal(round.best,1);
assert.throws(()=>readScore({title:'错谱',bpm:60,notes:[[9,1]]}));
assert.throws(()=>readScore({title:'空谱',bpm:60,notes:[[0,1]]}));
console.log('七首完整旋律、连续同音、错音补判、漏音、休止、八度和格式检查通过。');

const follow=new Round(short,60,2000,true);
follow.advance(8000);
assert.equal(follow.beat(8000),0);
follow.strike(2,0,8000,8100);
assert.equal(follow.hits,0);
follow.strike(1,0,8200,8300);
follow.strike(1,0,8500,8600);
assert.equal(follow.hits,2,'A separate fast repeat can advance the guided score.');
follow.strike(5,-1,8600,8700);
assert.equal(follow.hits,2,'A rest still has time in a guided score.');
follow.strike(5,-1,9900,10000);
assert.equal(follow.hits,2,'Keep the full rest before accepting the following note.');
follow.strike(5,-1,10500,10600);
assert.equal(follow.hits,3);
follow.advance(12000);
assert.ok(follow.done(12000));
