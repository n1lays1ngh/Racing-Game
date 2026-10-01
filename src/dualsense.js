// Real trigger resistance on a PlayStation DualSense (or DualSense Edge) controller.
//
// The browser's normal controller support can't move the adaptive triggers, so this talks to the
// controller directly over WebHID (Chrome and Edge on a computer). It needs one click to allow: the
// "Trigger resistance" button on the menu (under the controls). After that it reconnects by itself
// whenever the game loads. With any other controller or browser nothing happens here (the brake still
// feels heavier through its curve in input.js).
//
// What you feel: the brake trigger (L2) gets stiff after the first bit of travel, like a brake pedal;
// the throttle (R2) has a light, even resistance; when the wheels lock the brake trigger buzzes.
//
// Connection: with a USB cable it just works. Over Bluetooth the controller has to be switched into its
// full mode to accept trigger commands, and on some computers the browser then stops reading its
// buttons until the controller is turned off and on again, so Bluetooth is off by default
// (TRIGGERS.bluetooth). Try it: if the controls stop responding, set it back to false and restart the controller.
export const TRIGGERS = {
  enabled: true,
  brake: { start: 0.12, force: 0.8 },     // where the resistance starts (0–1 of the travel) and how strong (0–1)
  throttle: { start: 0, force: 0.18 },
  lockBuzz: true,                          // brake trigger buzzes while the wheels are locked
  bluetooth: false,                        // also over Bluetooth (see above)
};

const SONY = 0x054c, MODELS = [0x0ce6, 0x0df2];   // DualSense, DualSense Edge
let dev = null, bt = false, seq = 0, current = '', button = null;

// Trigger effects: 11 bytes each (the rest stay 0).
const resist = ({ start, force }) => [0x01, Math.round(start * 255), Math.round(force * 255)]; // steady resistance from `start`
const buzz = (freq, strength) => [0x06, freq, strength, 0];                                  // vibration
const none = () => [0x05];                                                                    // off

let table = null;
function crc32(bytes) {
  table ??= Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Output report: only the two trigger-effect blocks are marked as changed, so lights, rumble and the
// rest of the controller are left alone.
function send(right, left) {
  if (!dev) return;
  const c = new Uint8Array(47);
  c[0] = 0x04 | 0x08;                      // change: right trigger effect, left trigger effect
  c.set(right, 10); c.set(left, 21);
  let job;
  if (!bt) { const d = new Uint8Array(62); d.set(c); job = dev.sendReport(0x02, d); } // USB: the block, then padding
  else {                                   // Bluetooth: sequence number, tag, the same block, checksum
    const d = new Uint8Array(77);
    d[0] = (seq++ & 0x0f) << 4; d[1] = 0x10; d.set(c, 2);
    const crc = crc32([0xa2, 0x31, ...d.subarray(0, 73)]);
    d.set([crc & 255, (crc >>> 8) & 255, (crc >>> 16) & 255, crc >>> 24], 73);
    job = dev.sendReport(0x31, d);
  }
  job.catch((err) => console.warn('DualSense: trigger effect not sent', err));
}

function apply(state) {
  if (state === current) return;
  current = state;
  if (!TRIGGERS.enabled || state === 'off') return send(none(), none());
  send(resist(TRIGGERS.throttle), state === 'lock' ? buzz(28, 220) : resist(TRIGGERS.brake));
}

// Called every frame by input.js's padFeedback().
export function triggerFeedback({ lock = false, speed = 0 }) {
  if (!dev) return;
  apply(TRIGGERS.lockBuzz && lock && speed > 8 ? 'lock' : 'race');
}

async function open(device) {
  if (!device || !MODELS.includes(device.productId)) return false;
  bt = device.collections.some((col) => col.outputReports?.some((r) => r.reportId === 0x31));
  if (bt && !TRIGGERS.bluetooth) { label('Trigger resistance: connect the DualSense with a USB cable'); return false; }
  if (!device.opened) await device.open();
  dev = device; current = '';
  apply('race');
  label('Trigger resistance on (DualSense)');
  return true;
}

function label(text) { if (button) { button.textContent = text; button.disabled = !!dev; } }

// The menu button (needs a click: browsers only let a page talk to a device the player has picked).
function addButton() {
  const keys = document.querySelector('.keys');
  if (!keys || button) return;
  button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Trigger resistance (DualSense): connect';
  Object.assign(button.style, { flexBasis: '100%', marginTop: '4px', padding: '6px 10px', font: 'inherit', fontSize: '12px', fontWeight: '700',
    color: '#cfe3ff', background: 'rgba(80,120,200,0.18)', border: '1px solid rgba(140,170,230,0.35)', borderRadius: '6px', cursor: 'pointer', textAlign: 'left' });
  button.addEventListener('click', async () => {
    try {
      const [d] = await navigator.hid.requestDevice({ filters: MODELS.map((productId) => ({ vendorId: SONY, productId })) });
      if (d) await open(d);
    } catch (err) { console.warn('DualSense: not connected', err); }
  });
  keys.appendChild(button);
}

if (typeof navigator !== 'undefined' && navigator.hid) {
  const start = async () => {
    addButton();
    for (const d of await navigator.hid.getDevices()) if (await open(d).catch(() => false)) break; // allowed before
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  navigator.hid.addEventListener('connect', (e) => { if (!dev) open(e.device).catch(() => {}); });
  navigator.hid.addEventListener('disconnect', (e) => { if (e.device === dev) { dev = null; label('Trigger resistance (DualSense): connect'); } });
  window.addEventListener('beforeunload', () => { if (dev) { current = ''; apply('off'); } });
}