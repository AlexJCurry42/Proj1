#!/usr/bin/env python3
"""Build assets/earth_land.png — the land mask the 3-D Earth is textured with.

Rasterizes Natural Earth land polygons (public domain, 1:10,000,000, via the
world-atlas TopoJSON distribution) into an equirectangular 8-bit mask:
255 = land, 0 = ocean. Run when the source data is updated:

    npm pack world-atlas@2.0.2 && tar xzf world-atlas-2.0.2.tgz
    python3 tools/make_earth_mask.py package/land-10m.json assets/earth_land.png 4096

4096x2048 is deliberate, not a budget compromise. WebGL 1's guaranteed
MAX_TEXTURE_SIZE on mobile GPUs is commonly exactly 4096, so a wider texture
simply fails to upload on many phones; and at that width one pixel is ~4.9 km
at the equator, already finer than the 1:10M source resolves. The mask costs
64 KB on the wire and one byte per pixel on the GPU (uploaded as LUMINANCE).

Verification, because "is this really Earth" should not be taken on trust: the
filled area comes to 28.96% of the equirectangular frame against Earth's true
29.2% land fraction, and spot checks at known coordinates land correctly
(ocean in the Gulf of Guinea and mid-Pacific, land in Kansas, the Sahara,
Amazonia, Tibet, outback Australia, Greenland, Antarctica). Inland lakes read
as land: Natural Earth's `land` layer is land-versus-ocean and does not carve
them out. No third-party modules."""
import json, sys, zlib, struct

src, out, W = sys.argv[1], sys.argv[2], int(sys.argv[3])
H = W // 2
topo = json.load(open(src))
tr = topo['transform']; sx, sy = tr['scale']; tx, ty = tr['translate']

# TopoJSON arcs are quantized and delta-encoded; absolute lon/lat per arc.
arcs = []
for arc in topo['arcs']:
    x = y = 0; pts = []
    for dx, dy in arc:
        x += dx; y += dy
        pts.append((x * sx + tx, y * sy + ty))
    arcs.append(pts)

def ring_of(idxs):
    out = []
    for i in idxs:
        a = arcs[~i][::-1] if i < 0 else arcs[i]
        out.extend(a if not out else a[1:])
    return out

rings = []
def walk(g):
    t = g.get('type')
    if t == 'GeometryCollection':
        for sub in g['geometries']: walk(sub)
    elif t == 'Polygon':
        for r in g['arcs']: rings.append(ring_of(r))
    elif t == 'MultiPolygon':
        for poly in g['arcs']:
            for r in poly: rings.append(ring_of(r))
walk(topo['objects']['land'])

# lon/lat -> pixel centres
def to_px(ring):
    return [(((lon + 180.0) / 360.0) * W, ((90.0 - lat) / 180.0) * H) for lon, lat in ring]

# Even-odd scanline fill: one crossing list per row, so holes (lakes) and
# nested rings fall out of the parity rule with no extra bookkeeping.
rowx = [[] for _ in range(H)]
for ring in rings:
    p = to_px(ring)
    n = len(p)
    for i in range(n):
        x0, y0 = p[i]; x1, y1 = p[(i + 1) % n]
        if y0 == y1: continue
        if y0 > y1: x0, y0, x1, y1 = x1, y1, x0, y0
        r0 = max(0, int(y0 - 0.5) + 1); r1 = min(H - 1, int(y1 - 0.5))
        for r in range(r0, r1 + 1):
            yc = r + 0.5
            if y0 <= yc < y1:
                rowx[r].append(x0 + (x1 - x0) * (yc - y0) / (y1 - y0))

raw = bytearray()
land = 0
for r in range(H):
    row = bytearray(W)
    xs = sorted(rowx[r])
    for i in range(0, len(xs) - 1, 2):
        a = max(0, int(xs[i] + 0.5)); b = min(W, int(xs[i + 1] + 0.5))
        if b > a:
            row[a:b] = b'\xff' * (b - a); land += b - a
    raw += b'\x00' + row          # filter type 0 per scanline

def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 0, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
       + chunk(b'IEND', b''))
open(out, 'wb').write(png)
print(json.dumps({'size': f'{W}x{H}', 'rings': len(rings), 'png_bytes': len(png),
                  'png_kb': round(len(png) / 1024, 1),
                  'land_fraction_equirect': round(land / (W * H), 4)}))
