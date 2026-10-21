// Shared helpers for the deskhand drag test pages. Every page records events in window.deskhand so
// tests (and curious humans) can read the result over CDP: Runtime.evaluate("window.deskhand").
window.deskhand = { events: [], offset: null, result: null };
// Screen offset of the viewport, learnt from any mouse event (screenX - clientX). Lets a test turn
// element rects (CSS px) into screen px without guessing the browser's toolbar height.
document.addEventListener(
  "mousemove",
  (e) => {
    window.deskhand.offset = [e.screenX - e.clientX, e.screenY - e.clientY];
  },
  true,
);
window.deskhandLog = (type, detail) => {
  window.deskhand.events.push({ type, detail, t: Math.round(performance.now()) });
  if (window.deskhand.events.length > 500) window.deskhand.events.shift();
};
/** Screen-space centre of an element, once offset is known. */
window.deskhandCenter = (sel) => {
  const r = document.querySelector(sel).getBoundingClientRect();
  const o = window.deskhand.offset;
  if (!o) return null;
  return [Math.round(o[0] + r.left + r.width / 2), Math.round(o[1] + r.top + r.height / 2)];
};
window.deskhandRect = (sel) => {
  const r = document.querySelector(sel).getBoundingClientRect();
  const o = window.deskhand.offset || [0, 0];
  return { x: Math.round(o[0] + r.left), y: Math.round(o[1] + r.top), w: Math.round(r.width), h: Math.round(r.height) };
};
