"""Subprocess entry for the whole-die decode (`/vectorize/decode`).

The global decode of a die-sized mask takes minutes of dense CPU work
(skeletonize on tens of megapixels). Running it in a child process lets the
sidecar CANCEL it for real (terminate) when the user presses Stop — the
in-process version could not be interrupted mid-`skeletonize` and kept
burning CPU for many minutes after the client went away.

Contract: `python decode_worker.py <spec.json>` where spec holds
{"mask": <png path>, "out": <result json path>, "params": {...}}. The
worker writes the decode result (or {"error": ...}) to `out` and exits 0.
"""
from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def main() -> int:
    spec_path = sys.argv[1]
    with open(spec_path, "r", encoding="utf-8") as fh:
        spec = json.load(fh)
    out_path = spec["out"]
    try:
        import cv2
        import numpy as np

        from vectorize import VectorParams, decode_mask

        m = cv2.imread(spec["mask"], cv2.IMREAD_GRAYSCALE)
        if m is None:
            raise ValueError("could not read mask png")
        p = VectorParams(
            min_len=int(spec["params"].get("min_len", 14)),
            width_min=float(spec["params"].get("width_min", 0.0)),
            width_max=float(spec["params"].get("width_max", 0.0)),
            decoder=spec["params"].get("decoder", "runs"),
            oct_delta_px=float(spec["params"].get("oct_delta_px", 0.0)),
            oct_strict=bool(spec["params"].get("oct_strict", False)),
        )
        result = decode_mask((m > 127).astype(np.uint8), p)
        result["stats"]["coverage"] = round(float((m > 127).sum()) / m.size, 4)
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(result, fh)
        # Save-to: the sweep passes the cache dir's full.json path. Writing
        # HERE means the payload survives even if the Node backend dies
        # mid-decode (app closed / killed) — the next sweep start or block
        # read picks the cache up instead of re-decoding for 6 minutes.
        save_to = spec.get("save_to")
        if save_to:
            try:
                save_path = Path(save_to)
                save_path.parent.mkdir(parents=True, exist_ok=True)
                tmp = Path(str(save_path) + ".tmp")
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(result, fh)
                tmp.replace(save_path)
            except Exception:  # noqa: BLE001 — backend still gets the payload
                pass
        return 0
    except Exception:  # noqa: BLE001 — full traceback into the result file
        try:
            with open(out_path, "w", encoding="utf-8") as fh:
                json.dump({"error": traceback.format_exc()[-2000:]}, fh)
        except Exception:  # noqa: BLE001
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
