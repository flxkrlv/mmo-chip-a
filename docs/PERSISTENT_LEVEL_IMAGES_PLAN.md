# Deferred Plan: Persistent Overlay Level Images

> **Status:** Deferred. The current shared tiled-overlay system is functional and uses lazy tile generation from the original image. This document describes the next large cold-latency optimization only; it is not required for project export/import.

## Problem addressed

On a cold request at an intermediate zoom, the server can still need to decode a very large overlay original before extracting and resizing a small tile. This is the remaining source of variable first-sharp-tile latency after scheduling and tile-local invalidation improvements.

## Proposed model

For each shared overlay source in `overlay-images/<dieId>/<sourceId>/`, persist downsampled source images beside `manifest.json` and `original.*`:

```text
overlay-images/<dieId>/<sourceId>/
  manifest.json
  original.png | original.jpg | original.webp
  levels/
    level-1.jpg | level-1.png
    level-2.jpg | level-2.png
    ...
  tiles/                         # still derived, disposable cache
```

Each cold tile is cropped from the closest suitable persistent level instead of repeatedly decoding the full original. The full-resolution original remains necessary only for the most detailed level.

## Design constraints

| Requirement | Decision |
|---|---|
| Ownership | Sources remain shared per die; personal layer settings remain browser-local. |
| Export/import | Project archives continue to include only manifest plus original. Persistent levels and `tiles/` are regenerated on the target server. |
| Alpha | Preserve alpha-capable formats such as PNG for alpha sources; use JPEG/WebP for opaque levels. |
| Upload UX | Upload returns after manifest/original creation. Persistent levels build in bounded background work. |
| Interruptions | Generation must be resumable and safe to retry after server restart. |
| Current responsiveness | Interactive visible tile requests remain higher priority than background level creation. |

## Suggested rollout

1. Extend the manifest with an optional persistent-level version/status field.
2. Add a bounded resumable level builder, initiated after upload and import.
3. Use the nearest ready persistent level in tile extraction, falling back to original if absent.
4. Measure cold tile p50/p95 before and after on the actual LAN hardware.
5. Add cache cleanup/regeneration tooling only after production measurements confirm the storage/latency trade-off.

## Expected outcome

This change should reduce cold intermediate-zoom latency and server decode pressure for very large overlay originals. It does not replace the existing viewport priority queue, progressive coarse preview, tile-local invalidation, or shared project-bundle contract; it complements them.
