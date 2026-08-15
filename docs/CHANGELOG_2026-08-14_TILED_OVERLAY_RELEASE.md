# Tiled Overlay Architecture Update

> **Scope:** This document records the tiled-overlay implementation introduced with the `v1.4-alpha` renderer baseline and its subsequent LAN/team-sharing and project-bundle updates.

## Purpose

The legacy static overlay path decoded complete client-side images and became unusable for very large source files. The current system renders only viewport-relevant source tiles on Canvas 2D and supports an arbitrary ordered stack of overlay layers.

## Current storage and ownership model

| Concern | Current behavior |
|---|---|
| Overlay source images | Shared by the LAN team for each `dieId` under `overlay-images/<dieId>/<sourceId>/`. |
| Layer visibility, opacity, order, offsets | Personal browser preferences; changing them does not alter the shared source or another user's view. |
| ML/CV source choice | The browser supplies its top visible tiled source; the job keeps this source id as a snapshot. |
| Merge Cells / RE Cell | Server-side small static crops are generated from the selected shared tiled overlay. |
| Legacy static overlays | Retained only for backwards compatibility; new overlay uploads use the tiled path. |

## Rendering pipeline

| Capability | Implementation |
|---|---|
| Progressive display | Coarse pyramid tiles stay visible until sharper tiles arrive, avoiding black frames. |
| Targeting | Tile requests are center-first and assigned a viewport epoch so a new pan/zoom outranks stale queued work. |
| Server work | Cold generation is bounded by a priority scheduler, coalesces duplicate requests, and exposes cache/queue/generation timing headers. |
| Client work | Source tiles are cached per overlay source; hidden layers do not draw or request viewport tiles. |
| Repaint granularity | A loaded overlay source tile invalidates only its translated world rect, matching the Base Image tile-local repaint model rather than invalidating the full viewport. |
| Resource lifecycle | Removed overlay instances release cached images, scratch canvas, and callbacks through `dispose()`. |
| Status visibility | The lower status bar reports visible target-tile readiness, loading state, coarse-preview state, and render-wave timing. |

## Project export and import

A full project bundle transfers **primary assets, not derived cache**.

```text
overlay-images/
  <source-id>/
    manifest.json
    original.png | original.jpg | original.webp
```

Generated `tiles/z/x/y.*` are excluded from export and rejected during import. The exporter writes a portable manifest without a host-specific absolute `originalPath`. The importer validates archive paths and strict overlay entry names, restores the original, rewrites `manifest.originalPath` for the target server, and schedules background generation of coarse levels 0-1. All other tiles are regenerated lazily by the normal tile endpoint.

## Validation status

The implementation is covered by full frontend/backend build checks and backend tests. The focused project-I/O tests verify that export includes manifest plus original but not generated tiles, that the manifest is portable, and that derived tile entries are rejected on import.

## Key files

| Area | Files |
|---|---|
| Shared overlay storage and tile generation | `backend/src/api/overlayImages.ts` |
| ML/CV source resolution and jobs | `backend/src/api/ml.ts`, `backend/src/ml/jobs.ts` |
| Static crop previews | `backend/src/api/tiles.ts` |
| Compact project bundles | `backend/src/api/projectIO.ts`, `backend/src/projectIO.test.ts` |
| Layer state and top-visible selection | `frontend/src/state/overlayLayers.ts` |
| Multilayer renderer | `frontend/src/renderer/layers/OverlayImageLayer.ts` |
| Viewer status and layer lifecycle | `frontend/src/routes/DieViewerPage.tsx` |
| Layer upload GUI | `frontend/src/components/dieViewer/OutlineTree.tsx` |

## Russian summary

Система использует общий для LAN-команды tiled storage на уровне die и персональные browser settings слоёв. Рендерер остаётся progressive и viewport-driven: видимые tiles загружаются с приоритетом, coarse preview исключает чёрные кадры, а arrival одного source tile перерисовывает только его область. Project export переносит manifest и original каждого overlay без производных tiles; import безопасно перепривязывает пути и заново строит cache по требованию.

## Personal layer organization

Overlay layers now support **per-user drag-and-drop ordering** in the Outline tree. The chosen order is persisted in browser preferences and does not alter the shared team manifest or any other user's view.

Layer display names can be changed with a **double-click inline rename**. Names are stored per user, default to the original filename, and support Unicode text including Cyrillic characters. Visibility, opacity, offsets, order, and display names remain personal settings, while ML/CV continues to select the top visible layer for the current user.

