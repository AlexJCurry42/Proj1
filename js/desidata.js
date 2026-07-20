// Pocket Planetarium — the DESI cosmic-web binary format (data/desi_web.bin,
// written by the data pipeline). A subsample of the DESI DR1 redshift
// catalog: every point is a REAL spectroscopically measured galaxy or
// quasar, positioned in comoving space (flat Planck-2018 ΛCDM turns each
// redshift into a distance in the pipeline — the browser only unpacks).
//
// Layout (little-endian), designed to stay a ~3 MB lazy download:
//   bytes 0–3   magic "DSW1"
//   bytes 4–7   uint32 point count N
//   bytes 8–11  float32 scale — megaparsecs per int16 unit
//   then N records of 8 bytes: int16 x, y, z (comoving Mpc / scale,
//   Earth at the origin, +z toward the north celestial pole),
//   uint8 type (0 = galaxy, 1 = quasar), uint8 reserved.
//
// Kept DOM-free so the unit suite can exercise the parser in plain Node.

export const DESI_MAGIC = 'DSW1';
export const DESI_RECORD_BYTES = 8;
export const DESI_HEADER_BYTES = 12;

/**
 * Parse a desi_web.bin ArrayBuffer → { count, scaleMpc, xyz: Float32Array
 * (3 per point, in Mpc), type: Uint8Array }. Throws on anything malformed —
 * the caller treats that the same as a missing file.
 */
export function parseDesiWeb(buffer) {
  const dv = new DataView(buffer);
  if (buffer.byteLength < DESI_HEADER_BYTES) throw new Error('truncated header');
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== DESI_MAGIC) throw new Error(`bad magic "${magic}"`);
  const count = dv.getUint32(4, true);
  const scaleMpc = dv.getFloat32(8, true);
  if (!Number.isFinite(scaleMpc) || scaleMpc <= 0) throw new Error('bad scale');
  if (buffer.byteLength !== DESI_HEADER_BYTES + count * DESI_RECORD_BYTES) {
    throw new Error(`length mismatch: ${buffer.byteLength} bytes for ${count} points`);
  }
  const xyz = new Float32Array(count * 3);
  const type = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const o = DESI_HEADER_BYTES + i * DESI_RECORD_BYTES;
    xyz[i * 3] = dv.getInt16(o, true) * scaleMpc;
    xyz[i * 3 + 1] = dv.getInt16(o + 2, true) * scaleMpc;
    xyz[i * 3 + 2] = dv.getInt16(o + 4, true) * scaleMpc;
    type[i] = dv.getUint8(o + 6);
  }
  return { count, scaleMpc, xyz, type };
}
