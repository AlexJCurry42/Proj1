// Project Planetarium — the dark-matter field behind the cosmic web.
//
// HONESTY FIRST: nobody has photographed dark matter. What this builds is
// the standard thing a redshift survey can honestly say about it — the
// density field TRACED BY the galaxies. Galaxies form inside dark-matter
// halos and sit where the halos are, and matter is ~85% dark, so the
// filaments and nodes the galaxies outline are the dark matter's skeleton.
// This is an inference from real measured positions, not a measurement of
// dark matter itself, and the in-app legend says exactly that.
//
// The one correction that decides whether this is science or decoration:
// DESI is flux-limited, so raw galaxy counts fall off with distance no
// matter what is really out there. Binning counts alone would draw a bright
// blob around Earth fading to nothing — the survey's selection function,
// not structure. So each cell is divided by the mean density of its RADIAL
// SHELL, turning counts into a density CONTRAST (over/under-dense relative
// to typical at that distance). Contrast is what traces the web.
//
// Kept DOM- and WebGL-free so the unit suite can exercise it in plain Node.

/**
 * Build a smoothed density-contrast field from comoving galaxy positions.
 *
 * @param {Float32Array} xyz  3 floats per point (Mpc), Earth at the origin
 * @param {number} count      number of points
 * @param {object} [opts]
 * @param {number} [opts.grid=56]    cells per axis over the bounding cube
 * @param {number} [opts.smooth=3]   separable box-blur passes (~Gaussian)
 * @param {number} [opts.floor=0.20] keep cells at/above this normalized value
 * @param {number} [opts.shells=48]  radial shells for the selection divide-out
 * @param {number} [opts.quantile=0.99] contrast quantile mapped to full white
 * @returns {{pos:Float32Array, dens:Float32Array, n:number, cell:number}}
 *   pos: 3 floats per surviving cell (its center, Mpc)
 *   dens: 0..1 normalized density contrast, 1 = densest
 *   n: surviving cell count, cell: cell edge length in Mpc
 */
export function buildDensityField(xyz, count, opts = {}) {
  const grid = Math.max(8, Math.floor(opts.grid ?? 56));
  const smooth = Math.max(0, Math.floor(opts.smooth ?? 3));
  // 0.20 keeps the faint purple threads while dropping the ~22k dimmest
  // cells, which cost fill-rate on a phone and add nothing visible.
  const floor = opts.floor ?? 0.20;
  const shells = Math.max(4, Math.floor(opts.shells ?? 48));
  if (!count || !xyz || xyz.length < count * 3) {
    return { pos: new Float32Array(0), dens: new Float32Array(0), n: 0, cell: 0 };
  }

  // ---- bounds → one cube, so cells stay isotropic (a stretched cell would
  // smear filaments along whichever axis the survey happens to be widest) --
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < count * 3; i++) {
    const v = xyz[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = Math.max(hi - lo, 1e-6);
  const cell = span / grid;
  const G2 = grid * grid, N = G2 * grid;
  const at = (x, y, z) => (z * G2 + y * grid + x);

  // ---- cloud-in-cell binning: each galaxy is spread over the 8 cells it
  // sits between, by trilinear weight. Nearest-cell binning aliases the web
  // into blocky steps at this resolution. ----
  const f = new Float32Array(N);
  for (let i = 0; i < count; i++) {
    const gx = (xyz[i * 3] - lo) / cell - 0.5;
    const gy = (xyz[i * 3 + 1] - lo) / cell - 0.5;
    const gz = (xyz[i * 3 + 2] - lo) / cell - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy), z0 = Math.floor(gz);
    const fx = gx - x0, fy = gy - y0, fz = gz - z0;
    for (let dz = 0; dz < 2; dz++) {
      const z = z0 + dz; if (z < 0 || z >= grid) continue;
      const wz = dz ? fz : 1 - fz;
      for (let dy = 0; dy < 2; dy++) {
        const y = y0 + dy; if (y < 0 || y >= grid) continue;
        const wy = dy ? fy : 1 - fy;
        for (let dx = 0; dx < 2; dx++) {
          const x = x0 + dx; if (x < 0 || x >= grid) continue;
          f[at(x, y, z)] += (dx ? fx : 1 - fx) * wy * wz;
        }
      }
    }
  }

  // ---- separable box blur, repeated: three passes approximate a Gaussian
  // closely and cost a fraction of a true kernel. ----
  const tmp = new Float32Array(N);
  const blurAxis = (src, dst, stride, len, outer) => {
    for (let o = 0; o < outer; o++) {
      const base = axisBase(o, stride, len, grid, G2);
      for (let i = 0; i < len; i++) {
        const a = src[base + Math.max(0, i - 1) * stride];
        const b = src[base + i * stride];
        const c = src[base + Math.min(len - 1, i + 1) * stride];
        dst[base + i * stride] = (a + b + c) / 3;
      }
    }
  };
  for (let p = 0; p < smooth; p++) {
    blurAxis(f, tmp, 1, grid, G2);        // x
    blurAxis(tmp, f, grid, grid, G2);     // y
    blurAxis(f, tmp, G2, grid, G2);       // z
    f.set(tmp);
  }

  // ---- divide out the radial selection function ----
  // Mean density per shell, over cells that contain ANY signal (empty cells
  // outside the survey cone must not drag a shell's mean toward zero and
  // manufacture contrast where there is simply no coverage).
  const half = span / 2, cx = lo + half;
  const maxR = Math.sqrt(3) * half;
  const shellSum = new Float64Array(shells), shellCnt = new Float64Array(shells);
  const rOf = new Float32Array(N);
  for (let z = 0; z < grid; z++) {
    const pz = lo + (z + 0.5) * cell - cx;
    for (let y = 0; y < grid; y++) {
      const py = lo + (y + 0.5) * cell - cx;
      for (let x = 0; x < grid; x++) {
        const px = lo + (x + 0.5) * cell - cx;
        const i = at(x, y, z);
        const r = Math.sqrt(px * px + py * py + pz * pz);
        rOf[i] = r;
        if (f[i] > 0) {
          const s = Math.min(shells - 1, Math.floor((r / maxR) * shells));
          shellSum[s] += f[i];
          shellCnt[s] += 1;
        }
      }
    }
  }
  const shellMean = new Float64Array(shells);
  for (let s = 0; s < shells; s++) shellMean[s] = shellCnt[s] > 0 ? shellSum[s] / shellCnt[s] : 0;

  // ---- counts → contrast, then normalize to 0..1 ----
  const contrast = new Float32Array(N);
  const nz = [];
  for (let i = 0; i < N; i++) {
    if (f[i] <= 0) continue;
    const s = Math.min(shells - 1, Math.floor((rOf[i] / maxR) * shells));
    const m = shellMean[s];
    if (!(m > 0)) continue;
    // Overdensity only: underdense voids carry no light in this rendering.
    const c = f[i] / m - 1;
    if (c > 0) { contrast[i] = c; nz.push(c); }
  }
  if (!nz.length) return { pos: new Float32Array(0), dens: new Float32Array(0), n: 0, cell };

  // Normalize against a high QUANTILE, not the maximum. The contrast
  // distribution is extremely skewed — one rare node is several times the
  // next — so dividing by the peak squashed 91% of cells into the bottom
  // fifth of the range (measured), and a ramp that should sweep purple →
  // pink → yellow → white rendered as almost uniform purple. Against p99
  // the median lands mid-ramp and the densest ~1% clamp to white, which is
  // both the standard treatment for density maps and the honest one: the
  // brightest cells really are the rare extreme, not the typical cell.
  nz.sort((a, b) => a - b);
  const norm = nz[Math.min(nz.length - 1, Math.floor(nz.length * (opts.quantile ?? 0.99)))];
  if (!(norm > 0)) return { pos: new Float32Array(0), dens: new Float32Array(0), n: 0, cell };
  for (let i = 0; i < N; i++) {
    if (contrast[i] > 0) contrast[i] = Math.min(1, contrast[i] / norm);
  }

  // ---- emit the cells worth drawing ----
  let n = 0;
  for (let i = 0; i < N; i++) if (contrast[i] >= floor) n++;
  const pos = new Float32Array(n * 3), dens = new Float32Array(n);
  let k = 0;
  for (let z = 0; z < grid; z++) {
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        const i = at(x, y, z);
        const d = contrast[i];
        if (d < floor) continue;
        pos[k * 3] = lo + (x + 0.5) * cell;
        pos[k * 3 + 1] = lo + (y + 0.5) * cell;
        pos[k * 3 + 2] = lo + (z + 0.5) * cell;
        dens[k] = d;
        k++;
      }
    }
  }
  return { pos, dens, n, cell };
}

// Start index of the 1-D line through the volume that `blurAxis` walks.
// Split out because the three axes index the same flat array differently.
function axisBase(o, stride, len, grid, G2) {
  if (stride === 1) return o * grid;                       // rows along x
  if (stride === grid) return (o / grid | 0) * G2 + (o % grid); // columns along y
  return o;                                                 // pillars along z
}
