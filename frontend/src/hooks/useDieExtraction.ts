import { useEffect, useRef, useState } from "react";
import type { AnalogDevice, DieAnnotations } from "shared";
import { collectDieWideChunked } from "../api/dieWideAnalog";
import { applyAnalogOverrides } from "../api/analogNetlist";
import { CellTypeDeviceCache } from "../lib/extraction/deviceCache";
import { useExtractionProgress } from "../state/extractionProgress";
import { useRegistryVersion } from "../state/deviceRegistry";
import { useSession, DEFAULT_METAL_STACK } from "../state/session";

interface DieExtractionResult {
  devices: AnalogDevice[];
  netNames: Map<number, string>;
  unconnectedCount: number;
  warnings: string[];
  netIdMap: Map<string, number>;
}

const emptyResult: DieExtractionResult = {
  devices: [],
  netNames: new Map(),
  unconnectedCount: 0,
  warnings: [],
  netIdMap: new Map(),
};

export function useDieExtraction(
  annotations: DieAnnotations | undefined,
): DieExtractionResult {
  const cacheRef = useRef<CellTypeDeviceCache | null>(null);
  if (cacheRef.current === null) {
    cacheRef.current = new CellTypeDeviceCache();
  }

  const regVer = useRegistryVersion((s) => s.v);
  const { setProgress, setLastExtraction, reset } = useExtractionProgress();
  const [result, setResult] = useState<DieExtractionResult>(emptyResult);
  const runIdRef = useRef(0);

  useEffect(() => {
    if (!annotations) {
      setResult(emptyResult);
      reset();
      return;
    }

    const thisRun = ++runIdRef.current;
    const ctrl = new AbortController();
    const umPerPx = annotations.umPerPx ?? 1;
    const ctCount = annotations.cellTypes?.length ?? 0;
    const startTime = performance.now();

    const metalStack = useSession.getState().metalStack ?? DEFAULT_METAL_STACK;
    collectDieWideChunked(
      annotations,
      umPerPx,
      undefined,
      cacheRef.current!,
      { signal: ctrl.signal, chunkSize: 10 },
      metalStack.metals[0]?.layer,
    )
      .then((r) => {
        if (thisRun !== runIdRef.current) return;
        const elapsed = performance.now() - startTime;
        applyAnalogOverrides(r.devices);
        const unconnectedCount = r.devices.reduce(
          (sum, d) => sum + d.terminals.filter((t) => t.netId >= 2000).length,
          0,
        );
        setResult({
          devices: r.devices,
          netNames: r.namedNets,
          unconnectedCount,
          warnings: r.warnings,
          netIdMap: r.netIdMap,
        });
        setLastExtraction(Math.round(elapsed), ctCount, elapsed < 5);
      })
      .catch((e: any) => {
        if (thisRun !== runIdRef.current) return;
        reset();
        if (e.name !== "AbortError" && e.name !== "DOMException") throw e;
      });

    return () => {
      ctrl.abort();
    };
  }, [annotations, regVer, setProgress, setLastExtraction, reset]);

  return result;
}
