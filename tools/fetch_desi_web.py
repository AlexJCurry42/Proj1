#!/usr/bin/env python3
"""Pocket Planetarium — DESI cosmic-web builder (run by data-refresh.yml).

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
UA = 'PocketPlanetariumDataRefresh/1.0 (+https://github.com/AlexJCurry42/Proj1)'
TARGET_N = 400_000     # points shipped (~3.2 MB at 8 bytes each)
MIN_ROWS = 250_000     # validation gate: fewer means the query went wrong
Z_MIN, Z_MAX = 0.001, 3.5

# Planck 2018 flat ΛCDM (same constants the in-app disclosure names).
H0 = 67.36             # km/s/Mpc
OMEGA_M = 0.3153
C_KMS = 299792.458

# Candidate queries, tried in order. random_id (0–100, uniform) is Data
# Lab's built-in subsampling column; the MOD fallback covers a schema
# without it, and the EDR table covers DR1 not being loaded yet.
BASE = ("SELECT target_ra, target_dec, z, spectype FROM {table} "
        "WHERE zwarn = 0 AND spectype IN ('GALAXY', 'QSO') "
        f"AND z BETWEEN {Z_MIN} AND {Z_MAX}")
QUERIES = [
    BASE.format(table='desi_dr1.zpix') + ' AND random_id < 2.8',
    BASE.format(table='desi_dr1.zpix') + ' AND MOD(targetid, 40) = 0',
    BASE.format(table='desi_edr.zpix') + ' AND random_id < 40',
]


def tap_csv(query):
    params = urlencode({
        'REQUEST': 'doQuery', 'LANG': 'ADQL', 'FORMAT': 'csv',
        'MAXREC': str(TARGET_N * 2), 'QUERY': query
    })
    req = Request(f'{TAP_SYNC}?{params}', headers={'User-Agent': UA})
    with urlopen(req, timeout=600) as r:
        return r.read().decode('utf-8', 'replace')


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
    csv_text, last_err = None, None
    for q in QUERIES:
        try:
            t = tap_csv(q)
            # A TAP error document is XML/HTML; a result starts with a header row.
            if t[:200].lstrip().lower().startswith('target_ra'):
                csv_text = t
                print(f'query ok ({len(t)} bytes): {q[:80]}…')
                break
            last_err = f'unexpected response head: {t[:160]!r}'
            print(f'query rejected, trying next: {last_err}')
        except (HTTPError, OSError) as e:
            last_err = str(e)
            print(f'query failed, trying next: {e}')
            time.sleep(5)
    assert csv_text, f'all TAP queries failed — last error: {last_err}'

    rows = []
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
        rows.append((ra, dec, z, 1 if parts[3].strip().upper().startswith('QSO') else 0))

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

    scale = (d_max * 1.001) / 32767.0
    out = bytearray(struct.pack('<4sIf', b'DSW1', len(pts), scale))
    for x, y, zc, t in pts:
        out += struct.pack('<hhhBB', round(x / scale), round(y / scale), round(zc / scale), t, 0)

    path = 'data/desi_web.bin'
    with open(path, 'wb') as f:
        f.write(out)
    size = os.path.getsize(path)
    assert size < 4_500_000, f'{size} bytes — too big to ship'
    print(json.dumps({
        'points': len(pts), 'bytes': size, 'scale_mpc': round(scale, 5),
        'qso_fraction': round(qso_frac, 4), 'median_z': round(median_z, 3),
        'max_comoving_mpc': round(d_max, 1)
    }))


if __name__ == '__main__':
    sys.exit(main())
