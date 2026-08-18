# Vendor patches

## xterm-addon-image-dpr.patch

`public/vendor/xterm-addon-image.js` is NOT the stock npm build — it is
`xterm-addon-image@0.5.0` (the release pairing with the vendored `xterm@5.3.0`)
rebuilt with a local DPR patch. The stock addon renders its image layer at CSS
resolution, which retina displays upscale — every image comes out blurry, and
its `createImageBitmap` resizes use Chrome's default "low" quality. Upstream
(including the current `@xterm/addon-image`) has no devicePixelRatio handling.

The patch (marked `HERD PATCH (DPR)` in the source):
- image-layer canvas gets a device-pixel backing store with a CSS-sized layout box
- all draw/clear coordinates run in device pixels
- IIP decode resizes to exactly cssSize×dpr with `resizeQuality: 'high'`
  (deliberately NOT capped at the source's natural size: the exact dpr ratio
  is what lets `draw()`'s rescale early-exit keep `spec.actual === spec.orig`;
  a natural-size cap forces a runtime rescale to those same dimensions and
  retains both buffers). The storage records CSS layout dims separately,
  scaling `origCellSize` by the bitmap/CSS ratio so the renderer's
  bitmap-pixels-per-cell invariant stays exact
- `_rescaleImage` compares cell sizes with a 0.05px tolerance — decode
  rounding and fractional dpr (browser zoom) leave float noise that must not
  trigger a full-image rescale
- `imageSmoothingQuality: 'high'` on rescale/draw contexts

Known behaviors, accepted:
- **sixel** images keep 1x storage (single-arg `addImage`) but `draw()` now
  targets device cells, so they get one runtime upscale ×dpr into
  `spec.actual` — smoother edges, no extra detail, ~4×+1× the pixels of the
  stock build against the storage limit
- an image decoded while the window is on a 1x display stays 1x if the window
  later moves to a retina screen (the source blob is released after decode;
  there is no re-decode path) — re-print the image to fix
- the eviction placeholder pattern is generated at 1x and cached across dpr
  changes; renders slightly coarse on retina (cosmetic, evicted images only)

Addon hard limits (unchanged from stock): `iipSizeLimit` 20MB file,
`pixelLimit` 16Mpx — frames over either are dropped SILENTLY. `~/.local/bin/
imgcat` pre-shrinks such sources and warns.

### Rebuild recipe

```sh
curl -sSL -o addon.tgz https://registry.npmjs.org/xterm-addon-image/-/xterm-addon-image-0.5.0.tgz
tar xzf addon.tgz            # unpacks to package/
cd package
patch -p1 -d . < ../xterm-addon-image-dpr.patch   # applies to out/*.js (paths: out/...)
npm install --ignore-scripts sixel@0.16.0 inwasm  # runtime deps (devDeps upstream)
npx esbuild out/ImageAddon.js --bundle --format=iife --global-name=ImageAddon \
  --minify --outfile=xterm-addon-image.js
cp xterm-addon-image.js <repo>/public/vendor/xterm-addon-image.js
```

Note: the patch was generated against `package/out/` compiled JS (the published
tarball has no TypeScript sources; the 0.5.0 gitHead commit was never pushed to
the public repo). Verify after build: the bundle should contain
`devicePixelRatio` and `resizeQuality`.
