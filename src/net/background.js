// Browsers stop animation frames in a background tab. In an online room that would freeze the race
// for everyone (the host runs the AI and the timing), so while you're in a room a tiny worker keeps
// the game ticking 30 times a second whenever the tab is hidden. Nothing is drawn meanwhile.
let worker = null;

export function keepTicking(tick) {
  if (worker) return;
  const src = 'setInterval(() => postMessage(0), 33);';
  worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  worker.onmessage = () => { if (document.hidden) tick(performance.now()); };
}

export function stopTicking() {
  worker?.terminate();
  worker = null;
}

