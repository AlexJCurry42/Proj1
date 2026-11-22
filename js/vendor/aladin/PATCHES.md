# Local patches to the vendored Aladin Lite engine

`aladin.js` is Aladin Lite **v3.9.0-beta** (LGPL-3.0-or-later, source:
<https://github.com/cds-astro/aladin-lite>), vendored so no upstream release
can change the app unreviewed. It is NOT byte-identical to upstream. If you
re-vendor the engine, re-apply each patch below and re-run
`node tests/unit.mjs`, which checks they are present.

## 1. Usage beacon disabled (JavaScript)

The engine's startup logger posted `pageUrl` and `referrer` to
`alasky.unistra.fr/AladinLiteLogger`. The app promises "no tracking, ever",
so its URL is replaced with
`about:blank#AladinLiteLogger-disabled-by-ProjectPlanetarium`. The app also
passes `log: false`; this patch is the second lock, because that host serves
real tiles and cannot be blocked by CSP.

## 2. The void outside the sphere is pure black (WebAssembly)

Everything outside the projected sphere was painted rgb(26, 26, 26) — a
visible dark gray on OLED screens, where true black means pixels switched
off. No option controls it:

- `backgroundColor` / `setBackgroundColor()` colour the **inside** of the
  sphere (the empty sky between tiles), not the area around it. Verified:
  setting it to red turned the inside red and left the void at 26,26,26.
- The void is the WebGL clear colour, hard-coded in the WASM core as
  `gl.clearColor(0.1, 0.1, 0.1, 1.0)` (0.1 × 255 ≈ 26).

The core is embedded in `aladin.js` as a base64 `data:application/wasm` URI.
In the decoded module there is exactly one instruction sequence

    f32.const 0.1  f32.const 0.1  f32.const 0.1  f32.const 1.0  call 76

(`43 cdcccc3d` ×3, `43 0000803f`, `10 4c`), where function 76 is the import
`wbg.__wbg_clearColor_480962bfac4e1cbd` — checked against the import table,
not assumed. The three `0.1` immediates become `0.0` (`43 00000000`). An
`f32.const` immediate is always four bytes, so no size, offset or section
changes; the module still passes `WebAssembly.validate`, and the base64
string keeps its exact length.

Measured with the app in a portrait viewport, chrome hidden: void pixels
above and below the sphere went from 172,000 of 172,000 non-black to zero
(the only lit pixels left there are the Aladin attribution logo).
