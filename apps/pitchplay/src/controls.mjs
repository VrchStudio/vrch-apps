// Native range keyboard semantics, with absolute pointer positioning that also
// works for the linked pointers delivered by the Apps Preview canvas.
export function rangePointer(element) {
  let pointer = null;
  const update = event => {
    const rect = element.getBoundingClientRect(), inset = 10;
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - inset) / (rect.width - inset * 2)));
    const min = Number(element.min), max = Number(element.max), step = Number(element.step);
    const value = min + Math.round(fraction * (max - min) / step) * step;
    if (Number(element.value) === value) return;
    element.value = String(value);
    element.dispatchEvent(new Event('input', {bubbles: true}));
  };
  element.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault(); pointer = event.pointerId;
    element.focus({preventScroll: true});
    if (event.isTrusted) element.setPointerCapture(event.pointerId);
    update(event);
  });
  document.addEventListener('pointermove', event => { if (pointer === event.pointerId) update(event); });
  const release = () => { pointer = null; };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, release);
  addEventListener('blur', release);
}
