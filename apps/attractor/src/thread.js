// thread.js: follows one point of a flow a long way, so the picture can draw the flow as a single line wound into
// its figure, the way these figures are usually shown.
//
// picture.js steps points on the graphics chip, where every point is on its own. A line needs the points in order
// along one path, which only stepping one after another gives: that is done here, in a compiled copy of the
// formula's expressions as formulas.js writes them. The path always starts from the same place near the middle of
// the view, so the same letters always give the same line, and a small change of a letter bends the near part of
// the line gently (the far part moves a lot, as it must for these formulas).
(() => {
  'use strict';
  const CALLS = {sin: 'Math.sin', cos: 'Math.cos', tan: 'Math.tan', abs: 'Math.abs', sign: 'Math.sign', sqrt: 'Math.sqrt', exp: 'Math.exp',
    log: 'Math.log', floor: 'Math.floor', pow: 'Math.pow', min: 'Math.min', max: 'Math.max', atan: 'T.atan', mod: 'T.mod', fract: 'T.fract'};
  const HELP = {atan: (y, x) => x === undefined ? Math.atan(y) : Math.atan2(y, x), mod: (x, y) => x - y * Math.floor(x / y), fract: x => x - Math.floor(x)};
  const START = 0.137;   // the path starts this share of the view from its middle, a little more each way
  const FAR = 16;        // a point this many views from the middle is lost

  // One expression in JavaScript. Only numbers, + - * /, brackets, commas, the functions above and the names given
  // are let through.
  function translate(text, names) {
    const out = [], word = /\s*(\d*\.?\d+(?:[eE][-+]?\d+)?|[A-Za-z_][A-Za-z0-9_.]*|[-+*\/(),])/y;
    let at = 0;
    while (at < text.length) {
      if (/^\s*$/.test(text.slice(at))) break;
      word.lastIndex = at;
      const m = word.exec(text);
      if (!m) throw new Error('cannot read "' + text.slice(at, at + 12) + '"');
      at = word.lastIndex;
      const t = m[1];
      if (/^[\d.]/.test(t) || /^[-+*\/(),]$/.test(t)) out.push(t);
      else if (CALLS[t]) out.push(CALLS[t]);
      else if (names[t]) out.push(names[t]);
      else throw new Error('unknown name ' + t);
    }
    return out.join(' ');
  }
  // The three parts of 'vec3(x, y, z)'.
  function parts(text) {
    const m = /^\s*vec3\s*\(([\s\S]*)\)\s*$/.exec(text);
    if (!m) throw new Error('a flow is a vec3');
    const list = [];
    let depth = 0, from = 0;
    for (let i = 0; i < m[1].length; i++) {
      const ch = m[1][i];
      if (ch === '(') depth++; else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) { list.push(m[1].slice(from, i)); from = i + 1; }
    }
    list.push(m[1].slice(from));
    if (list.length !== 3) throw new Error('a flow has three parts');
    return list;
  }
  // The flow's rate of change as a function (x, y, z, a, b, c, d, out). It is compiled once by adding a script to
  // the page; where a page does not allow that, there is no function and the flow is drawn as before.
  const rules = new Map();
  let made = 0;
  function rule(formula) {
    if (rules.has(formula.id)) return rules.get(formula.id);
    let result = null;
    try {
      const names = {'p.x': 'x', 'p.y': 'y', 'p.z': 'z', a: 'a', b: 'b', c: 'c', d: 'd'}, lines = [];
      for (const helper of formula.with || []) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=([\s\S]+)$/.exec(helper);
        if (!m) throw new Error('a helper is "name = expression"');
        lines.push('var h_' + m[1] + ' = ' + translate(m[2], names) + ';');
        names[m[1]] = 'h_' + m[1];
      }
      parts(formula.flow).forEach((part, i) => lines.push('o[' + i + '] = ' + translate(part, names) + ';'));
      const slot = '__flow' + (++made), script = document.createElement('script');
      window.__threadHelp = HELP;
      script.textContent = '(function(T){window.' + slot + '=function(x,y,z,a,b,c,d,o){' + lines.join('') + '};})(window.__threadHelp);';
      document.head.appendChild(script); script.remove();
      if (typeof window[slot] === 'function') { result = window[slot]; delete window[slot]; }
    } catch (error) { console.warn('thread', formula.id, error); }
    rules.set(formula.id, result);
    return result;
  }
  // Where each strand starts, as shares of START each way: the first, then the same turned through the three
  // directions and mirrored, which finds the twins of a figure that has several alike.
  const STARTS = [[1, 2, 3], [2, 3, 1], [3, 1, 2], [-1, -2, -3], [-2, -3, -1], [-3, -1, -2]].map(v => v.map(n => n / 3));
  // A job that writes "count" points into "out" (x, y, z each): "strands" paths of equal length, one after another,
  // each with its points "span" of the flow's time apart. run(ms) works for about that long and answers 'more',
  // 'done', or 'lost' when a path leaves the view for good.
  function path(formula, letters, count, span, out, strands = 1) {
    const f = rule(formula);
    if (!f) return null;
    const [a, b, c, d] = letters, view = formula.view, centre = [0, 1, 2].map(i => (formula.centre || [])[i] || 0);
    const steps = Math.max(1, Math.ceil(span / formula.dt)), h = span / steps, lost = (FAR * view) ** 2;
    const k1 = [0, 0, 0], k2 = [0, 0, 0], k3 = [0, 0, 0], k4 = [0, 0, 0];
    const each = Math.ceil(count / strands);
    let x = 0, y = 0, z = 0, i = 0;
    return {
      run(ms) {
        const until = performance.now() + ms;
        while (i < count) {
          if (i % each === 0) { const from = STARTS[(i / each) % STARTS.length]; x = centre[0] + START * view * from[0]; y = centre[1] + START * view * from[1]; z = centre[2] + START * view * from[2]; }
          for (let n = Math.min(count, i + 512, (Math.floor(i / each) + 1) * each); i < n; i++) {
            out[3 * i] = x; out[3 * i + 1] = y; out[3 * i + 2] = z;
            for (let s = 0; s < steps; s++) {
              f(x, y, z, a, b, c, d, k1);
              f(x + 0.5 * h * k1[0], y + 0.5 * h * k1[1], z + 0.5 * h * k1[2], a, b, c, d, k2);
              f(x + 0.5 * h * k2[0], y + 0.5 * h * k2[1], z + 0.5 * h * k2[2], a, b, c, d, k3);
              f(x + h * k3[0], y + h * k3[1], z + h * k3[2], a, b, c, d, k4);
              x += h / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
              y += h / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
              z += h / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
            }
          }
          const away = (x - centre[0]) ** 2 + (y - centre[1]) ** 2 + (z - centre[2]) ** 2;
          if (!(away < lost)) return 'lost';
          if (performance.now() >= until) return i < count ? 'more' : 'done';
        }
        return 'done';
      },
    };
  }
  window.Thread = {rule, path};
})();
