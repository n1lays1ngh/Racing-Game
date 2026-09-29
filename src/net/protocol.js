// Binary car packets for online races (small, so ten players at 20–30 updates a second is cheap).
//   SNAP – host → everyone: every car on the grid
//   CAR  – player → host: their own car
// Header: type (u8) · race number (u8) · car count or car index (u8) · spare (u8) · host clock in ms (f64)
export const SNAP = 1, CAR = 2;
export const VERSION = 1; // bump when packets or messages change, so old and new pages don't mix
const HEAD = 12, CAR_BYTES = 44;
const NONE = -1; // "no time yet" for lap times

function writeCar(dv, o, car) {
  const s = car.state;
  dv.setFloat32(o, s.x, true); dv.setFloat32(o + 4, s.z, true); dv.setFloat32(o + 8, s.h, true);
  dv.setFloat32(o + 12, s.vx, true); dv.setFloat32(o + 16, s.vz, true);
  dv.setFloat32(o + 20, s.yawRate, true); dv.setFloat32(o + 24, s.steer, true);
  dv.setUint8(o + 28, Math.round(Math.min(1, Math.max(0, s.throttle ?? 0)) * 255));
  dv.setUint8(o + 29, Math.round(Math.min(1, Math.max(0, s.brake ?? 0)) * 255));
  dv.setInt8(o + 30, Math.max(-128, Math.min(127, car.lapsDone)));
  dv.setUint8(o + 31, (car.dnf ? 1 : 0) | (car.finishTime != null ? 2 : 0));
  dv.setFloat32(o + 32, car.lastLap ?? NONE, true);
  dv.setFloat32(o + 36, car.bestLap ?? NONE, true);
  dv.setFloat32(o + 40, car.finishTime ?? NONE, true);
}

function readCar(dv, o, idx) {
  const t = (k) => { const v = dv.getFloat32(o + k, true); return v < 0 ? null : v; };
  const flags = dv.getUint8(o + 31);
  return {
    idx,
    x: dv.getFloat32(o, true), z: dv.getFloat32(o + 4, true), h: dv.getFloat32(o + 8, true),
    vx: dv.getFloat32(o + 12, true), vz: dv.getFloat32(o + 16, true),
    yawRate: dv.getFloat32(o + 20, true), steer: dv.getFloat32(o + 24, true),
    throttle: dv.getUint8(o + 28) / 255, brake: dv.getUint8(o + 29) / 255,
    lapsDone: dv.getInt8(o + 30), dnf: !!(flags & 1),
    lastLap: t(32), bestLap: t(36), finishTime: (flags & 2) ? t(40) : null,
  };
}

function header(dv, type, raceNo, n, time) {
  dv.setUint8(0, type); dv.setUint8(1, raceNo & 255); dv.setUint8(2, n); dv.setUint8(3, 0);
  dv.setFloat64(4, time, true);
}

export function packSnapshot(cars, raceNo, time) {
  const buf = new ArrayBuffer(HEAD + cars.length * CAR_BYTES), dv = new DataView(buf);
  header(dv, SNAP, raceNo, cars.length, time);
  cars.forEach((c, i) => writeCar(dv, HEAD + i * CAR_BYTES, c));
  return buf;
}

export function packCar(car, index, raceNo, time) {
  const buf = new ArrayBuffer(HEAD + CAR_BYTES), dv = new DataView(buf);
  header(dv, CAR, raceNo, index, time);
  writeCar(dv, HEAD, car);
  return buf;
}

export function unpack(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < HEAD) return null;
  const dv = new DataView(buf), type = dv.getUint8(0), n = dv.getUint8(2);
  const p = { type, raceNo: dv.getUint8(1), time: dv.getFloat64(4, true), cars: [] };
  if (type === SNAP && buf.byteLength >= HEAD + n * CAR_BYTES) for (let i = 0; i < n; i++) p.cars.push(readCar(dv, HEAD + i * CAR_BYTES, i));
  else if (type === CAR && buf.byteLength >= HEAD + CAR_BYTES) p.cars.push(readCar(dv, HEAD, n));
  else return null;
  return p;
}
