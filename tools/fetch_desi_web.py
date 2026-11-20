#!/usr/bin/env python3
"""Project Planetarium — DESI cosmic-web builder (run by data-refresh.yml).

Draws a uniform random subsample of the DESI Data Release 1 redshift
catalog (galaxies and quasars with reliable redshifts) from NOIRLab's
Astro Data Lab TAP service, converts each redshift to a comoving position
(flat Planck-2018 ΛCDM), and packs the result into the compact binary the
3-D mode streams (data/desi_web.bin — format documented in
js/desidata.js, which this file must stay in lockstep with).

Every point in the output is a REAL spectroscopic measurement; the only
modeling is redshift → distance, disclosed in-app.
"""

import json
import math
import os
import random
import struct
import sys
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

TAP_SYNC = 'https://datalab.noirlab.edu/tap/sync'
UA = 'ProjectPlanetariumDataRefresh/1.0 (+https://github.com/AlexJCurry42/Proj1)'
# The map is meant to BE the DESI map, not a token sample of it. At the
# packed rate (~3.6 B/pt, and better as density rises) three million points
# land around 10 MB — a lazy, service-worker-cached download for a mode the
# user opts into, in exchange for ~7.5x the structure the old 400 k showed.
TARGET_N = 3_000_000
MIN_ROWS = 1_200_000   # validation gate: fewer means the query went wrong
POS_BITS = 14          # lattice bits per axis; see js/desidata.js on why
Z_MIN, Z_MAX = 0.001, 3.5

# Planck 2018 flat ΛCDM (same constants the in-app disclosure names).
H0 = 67.36             # km/s/Mpc
OMEGA_M = 0.3153
C_KMS = 299792.458

def tap_csv(query, maxrec):
    # FORMAT is TAP 1.0, RESPONSEFORMAT is TAP 1.1 — send both so either
    # generation of service honors the CSV request.
    params = urlencode({
        'REQUEST': 'doQuery', 'LANG': 'ADQL',
        'FORMAT': 'csv', 'RESPONSEFORMAT': 'csv',
        'MAXREC': str(maxrec), 'QUERY': query
    })
    req = Request(f'{TAP_SYNC}?{params}', headers={'User-Agent': UA})
    with urlopen(req, timeout=600) as r:
        # Bound the read against a compromised TAP endpoint. The sample is
        # collected in bands of ~200 k rows (~8 MB each), so this ceiling is
        # far above any legitimate response and still fails closed — nothing
        # is committed on abort.
        body = r.read(120_000_000 + 1)
        if len(body) > 120_000_000:
            raise OSError('TAP response exceeded the size ceiling')
        return body.decode('utf-8', 'replace')


def tap_error_text(votable):
    """A TAP service reports query errors as a VOTable regardless of the
    requested format — surface the actual message, not just 'was XML'."""
    import re
    m = re.search(r'<INFO[^>]*QUERY_STATUS[^>]*value="ERROR"[^>]*>(.*?)</INFO>',
                  votable, re.S | re.I)
    if m:
        return ' '.join(m.group(1).split())[:400]
    m = re.search(r'<INFO[^>]*QUERY_STATUS[^>]*value="([A-Z]+)"', votable, re.I)
    return f'VOTable QUERY_STATUS={m.group(1) if m else "?"} (head: {votable[:300]!r})'


def discover_schema():
    """Ask TAP_SCHEMA which DESI zpix table exists and what its relevant
    columns are actually called — guessed names are why blind queries die."""
    cols_csv = tap_csv(
        "SELECT table_name, column_name FROM TAP_SCHEMA.columns "
        "WHERE table_name IN ('desi_dr1.zpix', 'desi_edr.zpix')", 5000)
    if not cols_csv.lstrip().lower().startswith('table_name'):
        raise RuntimeError(f'TAP_SCHEMA lookup failed: {tap_error_text(cols_csv)}')
    by_table = {}
    for line in cols_csv.splitlines()[1:]:
        parts = [p.strip().lower() for p in line.split(',')]
        if len(parts) == 2:
            by_table.setdefault(parts[0], set()).add(parts[1])
    for table in ('desi_dr1.zpix', 'desi_edr.zpix'):
        cols = by_table.get(table)
        if not cols:
            continue
        ra = next((c for c in ('target_ra', 'mean_fiber_ra', 'ra') if c in cols), None)
        dec = next((c for c in ('target_dec', 'mean_fiber_dec', 'dec') if c in cols), None)
        if ra and dec and 'z' in cols and 'zwarn' in cols and 'spectype' in cols:
            return {'table': table, 'ra': ra, 'dec': dec,
                    'random_id': 'random_id' in cols, 'targetid': 'targetid' in cols}
    raise RuntimeError(f'no usable zpix table in TAP_SCHEMA (saw: {sorted(by_table)})')


def base_query(s):
    return (f"SELECT {s['ra']}, {s['dec']}, z, spectype FROM {s['table']} "
            "WHERE zwarn = 0 AND spectype IN ('GALAXY', 'QSO') "
            f"AND z BETWEEN {Z_MIN} AND {Z_MAX}")


def parse_rows(csv_text, into):
    """CSV → (ra, dec, z, is_qso), skipping anything that does not parse."""
    for line in csv_text.splitlines()[1:]:
        parts = line.split(',')
        if len(parts) != 4:
            continue
        try:
            ra, dec, z = float(parts[0]), float(parts[1]), float(parts[2])
        except ValueError:
            continue
        if not (0 <= ra < 360 and -90 <= dec <= 90 and Z_MIN <= z <= Z_MAX):
            continue
        into.append((ra, dec, z, 1 if parts[3].strip().upper().startswith('QSO') else 0))


def fetch_rows(s):
    """Millions of rows do not come back in one response — a single query for
    the whole sample is both over the service's practical limit and over our
    own size ceiling. random_id (0–100, uniform) is Data Lab's built-in
    sampling column, so walk it in BANDS: each is an independent, retryable
    request, and every band is itself a uniform sample of the sky. Without
    random_id, fall back to the old single-shot behaviour."""
    base = base_query(s)
    rows = []
    if s['random_id']:
        band = 1.5
        lo = 0.0
        while lo < 100.0 and len(rows) < TARGET_N:
            hi = min(100.0, lo + band)
            q = f'{base} AND random_id >= {lo:.4f} AND random_id < {hi:.4f}'
            got = len(rows)
            for attempt in range(3):
                try:
                    t = tap_csv(q, 2_000_000)
                    if not t[:200].lstrip().lower().startswith(s['ra']):
                        print(f'  band [{lo:.2f},{hi:.2f}) rejected: {tap_error_text(t)}')
                        break
                    parse_rows(t, rows)
                    break
                except (HTTPError, OSError) as e:
                    print(f'  band [{lo:.2f},{hi:.2f}) attempt {attempt + 1} failed: {e}')
                    time.sleep(5 * (attempt + 1))
            print(f'  band [{lo:.2f},{hi:.2f}) → +{len(rows) - got} rows (total {len(rows)})')
            lo = hi
        if rows:
            return rows
    for q in ([base + ' AND MOD(targetid, 8) = 0'] if s['targetid'] else []) + [base]:
        try:
            # Fallback path only: one request cannot carry the full target,
            # so take what a single response can hold rather than ask for a
            # body that would trip the ceiling above.
            t = tap_csv(q, 1_500_000)
            if t[:200].lstrip().lower().startswith(s['ra']):
                parse_rows(t, rows)
                return rows
            print(f'query rejected: {tap_error_text(t)}')
        except (HTTPError, OSError) as e:
            print(f'query failed: {e}')
            time.sleep(5)
    return rows


def _spread_table(bits):
    """value → its bits spaced three apart, so a Morton key is one OR of
    three lookups instead of a per-bit loop over millions of points."""
    tab = [0] * (1 << bits)
    for v in range(1 << bits):
        k = 0
        for i in range(bits):
            k |= ((v >> i) & 1) << (3 * i)
        tab[v] = k
    return tab


def pack_v2(pts, bits=POS_BITS):
    """Quantize → Morton sort → delta → zigzag varint → type bitset.
    Mirrors js/desidata.js; the two must change together."""
    lo = min(min(p[0], p[1], p[2]) for p in pts)
    hi = max(max(p[0], p[1], p[2]) for p in pts)
    levels = (1 << bits) - 1
    step = (hi - lo) / levels
    # Quantize with the SAME float32 values the header will carry. The
    # browser reconstructs from those, so quantizing here in float64 and
    # storing a rounded copy makes the two disagree for points sitting on a
    # lattice boundary — 457 of 400 000 in the round-trip check.
    step = struct.unpack('<f', struct.pack('<f', step))[0]
    lo = struct.unpack('<f', struct.pack('<f', lo))[0]
    inv = 1.0 / step
    spread = _spread_table(bits)

    keyed = []
    for x, y, z, t in pts:
        qx = int((x - lo) * inv + 0.5)
        qy = int((y - lo) * inv + 0.5)
        qz = int((z - lo) * inv + 0.5)
        qx = 0 if qx < 0 else (levels if qx > levels else qx)
        qy = 0 if qy < 0 else (levels if qy > levels else qy)
        qz = 0 if qz < 0 else (levels if qz > levels else qz)
        keyed.append((spread[qx] | (spread[qy] << 1) | (spread[qz] << 2), qx, qy, qz, t))
    keyed.sort(key=lambda r: r[0])

    body = bytearray()
    px = py = pz = 0
    for _, qx, qy, qz, _t in keyed:
        for cur, prev in ((qx, px), (qy, py), (qz, pz)):
            v = cur - prev
            u = (v << 1) ^ (v >> 63)
            while u >= 0x80:
                body.append((u & 0x7f) | 0x80)
                u >>= 7
            body.append(u)
        px, py, pz = qx, qy, qz

    bits_out = bytearray((len(keyed) + 7) // 8)
    for i, rec in enumerate(keyed):
        if rec[4]:
            bits_out[i >> 3] |= 1 << (i & 7)

    head = struct.pack('<4sIffffI', b'DSW2', len(keyed), lo, lo, lo, step, len(body))
    return head + bytes(body) + bytes(bits_out), step, lo


def comoving_interpolator():
    """D_C(z) in Mpc via a cumulative trapezoid on a fine grid."""
    dz = 0.0005
    n = int(Z_MAX / dz) + 4
    e_inv = [1.0 / math.sqrt(OMEGA_M * (1 + i * dz) ** 3 + (1 - OMEGA_M)) for i in range(n)]
    cum = [0.0] * n
    for i in range(1, n):
        cum[i] = cum[i - 1] + 0.5 * (e_inv[i - 1] + e_inv[i]) * dz
    k = C_KMS / H0
    def dist(z):
        x = z / dz
        i = min(int(x), n - 2)
        return k * (cum[i] + (cum[i + 1] - cum[i]) * (x - i))
    return dist


def main():
    schema = discover_schema()
    print(f'schema: {schema}')
    rows = fetch_rows(schema)
    assert len(rows) >= MIN_ROWS, f'only {len(rows)} usable rows'

    qso_frac = sum(r[3] for r in rows) / len(rows)
    assert 0.02 <= qso_frac <= 0.45, f'implausible quasar fraction {qso_frac:.3f}'
    zs = sorted(r[2] for r in rows)
    median_z = zs[len(zs) // 2]
    assert 0.2 <= median_z <= 1.8, f'implausible median z {median_z:.2f}'

    if len(rows) > TARGET_N:
        rows = random.Random(42).sample(rows, TARGET_N)  # deterministic subsample

    dist = comoving_interpolator()
    pts = []
    d_max = 0.0
    for ra, dec, z, t in rows:
        d = dist(z)
        d_max = max(d_max, d)
        a, b = math.radians(ra), math.radians(dec)
        pts.append((d * math.cos(b) * math.cos(a), d * math.cos(b) * math.sin(a), d * math.sin(b), t))

    blob, step, origin = pack_v2(pts)
    path = 'data/desi_web.bin'
    with open(path, 'wb') as f:
        f.write(blob)
    size = os.path.getsize(path)
    # Ceiling sized for the packed format at the target count, with headroom.
    # It still fails closed: nothing is committed if the file comes out fat.
    assert size < 18_000_000, f'{size} bytes — too big to ship'
    print(json.dumps({
        'points': len(pts), 'bytes': size, 'bytes_per_point': round(size / len(pts), 3),
        'lattice_step_mpc': round(step, 4), 'origin_mpc': round(origin, 1),
        'qso_fraction': round(qso_frac, 4), 'median_z': round(median_z, 3),
        'max_comoving_mpc': round(d_max, 1)
    }))


if __name__ == '__main__':
    sys.exit(main())
