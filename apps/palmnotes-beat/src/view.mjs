import {handIcon} from './hand.mjs';
const names=['Rest','Do','Re','Mi','Fa','Sol','La','Si'];
const poses=['release','1 finger','2 fingers','3 fingers','4 fingers','5 fingers','thumb + pinky','OK sign'];
const scales=['thumb down','fist','thumb up'];
export function createView(config) {
  const $=id=>document.getElementById(id), trace=$('trace'), ctx=trace.getContext('2d');
  const colors=['#cac6bd',...config.notes.map(note=>note.color)];
  const text=(id,value)=>{if($(id).textContent!==value)$(id).textContent=value;};
  let handKey='', chipKey='', traceKey='';
  return function paint(s,beat) {
    document.body.toggleAttribute('data-playing',!!s.playing);
    document.body.toggleAttribute('data-manual',!!s.manual);
    document.body.toggleAttribute('data-finished',!!s.finished);
    text('touch-note',s.finished?'♪':s.manual?s.played:'');
    text('title',s.title);text('tempo',s.bpm+' BPM');text('status',s.status);
    const target=s.target, n=target?.n??0;
    const key=n+s.hand;
    if(key!==handKey){handKey=key;$('hand').innerHTML=handIcon(n,s.hand);$('stage').style.setProperty('--accent',colors[n]);}
    text('name',s.finished?'Done':names[n]);
    text('pose',s.finished?'Best streak ×'+s.best:(s.hand==='left'?'Left: ':'Right: ')+(s.repeat?'close, then ':'')+poses[n]+' · '+(s.hand==='left'?'Right: ':'Left: ')+scales[(target?.oct??0)+1]);
    text('feedback',s.feedback);text('counter',s.hits+' / '+s.total+'  ·  Streak ×'+s.combo);
    const keyChips=s.cards.map(c=>[c.index,c.state,c.n,c.oct,c.duration,c.repeat,c.dense].join('/')).join('|');
    if(chipKey!==keyChips){chipKey=keyChips;
      $('chips').replaceChildren(...s.cards.map(card=>{
        const el=document.createElement('span');el.className='chip '+card.state;
        if(card.dense)el.classList.add(card.index%2?'upper':'lower');
        el.style.setProperty('--c',colors[card.n]);el.style.width=Math.min(32,Math.max(7,card.duration*10))+'%';
        el.textContent=(card.repeat?'↻':'')+(card.oct>0?'↑':card.oct<0?'↓':'')+ (card.n===6&&!card.dense?'🤙':card.n===7?'OK':card.n||'·');return el;
      }));
    }
    s.cards.forEach((card,i)=>{$('chips').children[i].style.left=(18+(card.at-beat)*36)+'%';});
    const width=Math.max(1,Math.round(trace.clientWidth)),height=Math.max(1,Math.round(trace.clientHeight));
    const nextKey=width+'/'+height+'/'+s.trace.map(p=>p.join(',')).join('|');
    if(nextKey!==traceKey){traceKey=nextKey;trace.width=width;trace.height=height;
      ctx.clearRect(0,0,width,height);let previous=null;
      for(const [pos,pitch,oct] of s.trace){
        const x=4+(width-8)*pos, y=height*.88-((pitch+7*oct+7)/21)*height*.76;
        if(previous && pos-previous.pos<.27){ctx.strokeStyle='#9c969c';ctx.beginPath();ctx.moveTo(previous.x,previous.y);ctx.lineTo(x,y);ctx.stroke();}
        ctx.fillStyle=colors[pitch];ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();previous={x,y,pos};
      }
    }
  };
}
