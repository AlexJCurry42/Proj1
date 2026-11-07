// Project Planetarium — the DESI cosmic-web binary format (data/desi_web.bin,
// written by tools/fetch_desi_web.py). Every point is a REAL spectroscopically
// measured galaxy or quasar, placed in comoving space (flat Planck-2018 ΛCDM
// turns each redshift into a distance in the pipeline — the browser only
// unpacks). Two versions are understood:
//
// DSW2 (current) — built for MILLIONS of points. Three things make that fit:
//   · Quantization to a 14-bit lattice per axis (~0.85 Mpc cells over the
//     survey volume). That sounds lossy and is not: peculiar velocities smear
//     a galaxy's redshift-derived distance by several Mpc, so finer steps
//     would only be storing noise more precisely.
//   · Morton (Z-order) sorting, so consecutive points are spatial neighbours.
//   · Delta + zigzag varint between them, which then costs ~1 byte per axis.
//   Measured on the real catalog: 8.00 B/pt (DSW1) → 3.65 B/pt, and the rate
//   IMPROVES with density because neighbours get closer.
//
//   bytes  0–3   magic "DSW2"
//   bytes  4–7   uint32 count N
//   bytes  8–19  float32 originX, originY, originZ — lattice corner, Mpc
//   bytes 20–23  float32 step — Mpc per lattice unit
//   bytes 24–27  uint32 posBytes — length of the varint block
//   then         posBytes of varints: 3 per point (dx, dy, dz), zigzagged
//                deltas against the previous point in Morton order
//   then         ceil(N/8) bytes: bit i set = point i is a quasar
//
// DSW1 (legacy, still deployed until the pipeline reruns) — 8 bytes per
// point: int16 x, y, z in units of `scale`, uint8 type, uint8 reserved.
//
// Both parse to the SAME shape, deliberately quantized rather than float:
// { count, origin, step, q: Int16Array(3N), type: Uint8Array(N) }. The GPU
// consumes `q` directly as a SHORT attribute and rebuilds world position as
// origin + q * step in the vertex shader, which keeps a 3-million-point map
// at 6 bytes per point on the GPU instead of 12, and never materializes a
// float array the size of the whole catalog.
//
// Kept DOM-free so the unit suite can exercise it in plain Node.

export const DESI_MAGIC = 'DSW1';        // legacy
export const DESI_MAGIC_V2 = 'DSW2';
export const DESI_RECORD_BYTES = 8;      // legacy
export const DESI_HEADER_BYTES = 12;     // legacy
export const DESI_V2_HEADER_BYTES = 28;

function magicOf(dv) {
  return String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
}

/**
 * Parse a desi_web.bin ArrayBuffer (either version).
 * @returns {{count:number, origin:Float64Array, step:number,
 *            q:Int16Array, type:Uint8Array, version:number}}
 * Throws on anything malformed — the caller treats that as a missing file.
 */
export function parseDesiWeb(buffer) {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 12) throw new Error('truncated header');
  const magic = magicOf(dv);
  if (magic === DESI_MAGIC_V2) return parseV2(buffer, dv);
  if (magic === DESI_MAGIC) return parseV1(buffer, dv);
  throw new Error(`bad magic "${magic}"`);
}

function parseV1(buffer, dv) {
  const count = dv.getUint32(4, true);
  const scaleMpc = dv.getFloat32(8, true);
  if (!Number.isFinite(scaleMpc) || scaleMpc <= 0) throw new Error('bad scale');
  if (buffer.byteLength !== DESI_HEADER_BYTES + count * DESI_RECORD_BYTES) {
    throw new Error(`length mismatch: ${buffer.byteLength} bytes for ${count} points`);
  }
  const q = new Int16Array(count * 3);
  const type = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const o = DESI_HEADER_BYTES + i * DESI_RECORD_BYTES;
    q[i * 3] = dv.getInt16(o, true);
    q[i * 3 + 1] = dv.getInt16(o + 2, true);
    q[i * 3 + 2] = dv.getInt16(o + 4, true);
    type[i] = dv.getUint8(o + 6);
  }
  return { count, origin: Float64Array.from([0, 0, 0]), step: scaleMpc, q, type, version: 1 };
}

function parseV2(buffer, dv) {
  const count = dv.getUint32(4, true);
  const origin = Float64Array.from([dv.getFloat32(8, true), dv.getFloat32(12, true), dv.getFloat32(16, true)]);
  const step = dv.getFloat32(20, true);
  const posBytes = dv.getUint32(24, true);
  if (!Number.isFinite(step) || step <= 0) throw new Error('bad step');
  if (!origin.every(Number.isFinite)) throw new Error('bad origin');
  const bitsetBytes = Math.ceil(count / 8);
  if (buffer.byteLength !== DESI_V2_HEADER_BYTES + posBytes + bitsetBytes) {
    throw new Error(`length mismatch: ${buffer.byteLength} bytes for ${count} points`);
  }
  const bytes = new Uint8Array(buffer, DESI_V2_HEADER_BYTES, posBytes);
  const q = new Int16Array(count * 3);
  let p = 0, x = 0, y = 0, z = 0;
  for (let i = 0; i < count; i++) {
    // Three zigzag varints per point, inlined: at ~9 million varints for a
    // 3 M-point map, a helper call per value is the whole decode budget.
    for (let a = 0; a < 3; a++) {
      let shift = 0, u = 0, b = 0;
      do {
        if (p >= posBytes) throw new Error('varint block overran');
        b = bytes[p++];
        u += (b & 0x7f) * (shift ? 2 ** shift : 1);
        shift += 7;
        if (shift > 35) throw new Error('varint too long');
      } while (b & 0x80);
      const d = (u >>> 1) ^ -(u & 1);   // un-zigzag
      if (a === 0) { x += d; q[i * 3] = x; }
      else if (a === 1) { y += d; q[i * 3 + 1] = y; }
      else { z += d; q[i * 3 + 2] = z; }
    }
  }
  if (p !== posBytes) throw new Error(`varint block had ${posBytes - p} trailing bytes`);
  const bits = new Uint8Array(buffer, DESI_V2_HEADER_BYTES + posBytes, bitsetBytes);
  const type = new Uint8Array(count);
  for (let i = 0; i < count; i++) type[i] = (bits[i >> 3] >> (i & 7)) & 1;
  return { count, origin, step, q, type, version: 2 };
}
