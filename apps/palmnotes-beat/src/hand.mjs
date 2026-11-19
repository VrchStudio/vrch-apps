// A palm with independently folded fingers, matching the poses in the Guide.
export function handIcon(n, side) {
  const fingers=[[31,19,11,42],[44,9,12,53],[58,14,11,48],[71,29,10,35]];
  const raised = n === 6 ? [3] : n === 7 ? [1,2,3] : [0,1,2,3].slice(0,Math.min(n,4));
  const digits=fingers.map(([x,y,w,h],i)=>raised.includes(i)
    ? '<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="5.5"/>'
    : '<rect x="'+x+'" y="'+(n===7?43:48)+'" width="'+w+'" height="14" rx="5" stroke="#22222b" stroke-width="1.6"/>');
  const thumb = n===5||n===6 ? '<path d="M37 64 15 43q-7-5-10 1-1 3 3 9l18 24z"/>' : n===7 ? '<path d="M33 70Q5 55 26 42q10-6 15 5" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>' : '<path d="M28 63q-8-16 1-15l17 9q6 4 2 9z" stroke="#22222b" stroke-width="1.6"/>';
  return '<svg viewBox="0 0 96 100" aria-hidden="true"><g fill="currentColor" transform="'+(side==='right'?'translate(96 0) scale(-1 1)':'')+'"><path d="M29 52q24-9 52 0v16q0 23-17 27H45Q26 86 26 66z"/>'+digits.join('')+thumb+'</g></svg>';
}
