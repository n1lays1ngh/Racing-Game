// Is this a phone (or tablet)? Worked out once, when the page loads. Everything else under src/mobile/ only runs when
// it says yes (main.js loads it with a dynamic import, so a desktop browser never even downloads it).
//
//   IS_MOBILE   true on phones and tablets: touch is the main input (no mouse or trackpad), or the browser says it's a
//               mobile device. A touch-screen laptop has a trackpad, so it stays a desktop.
//
// To try it either way:  ?mobile  at the end of the address forces the phone version, ?desktop the desktop one.
// (Node, for the headless sim: false.)
function detect() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('desktop')) return false;
    if (q.has('mobile')) return true;
  } catch { /* no location: carry on */ }
  const ua = navigator.userAgent || '';
  if (navigator.userAgentData?.mobile === true) return true;                // Chrome, Edge on a phone
  if (/Android|iPhone|iPod|Mobile Safari|Windows Phone/i.test(ua)) return true;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return true; // (iPads say they're Macs)
  const mq = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;
  return mq('(pointer: coarse)') && !mq('(any-pointer: fine)');             // touch only: no mouse, no trackpad
}

export const IS_MOBILE = detect();
export const IS_IOS = IS_MOBILE && typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));