/**
 * SchematicViewPanel.tsx — Renders analog schematics via @spice-ts/ui SchematicView.
 *
 * Supports:
 *   - Flat mode: one big schematic of all devices
 *   - Hierarchical mode: sidebar of subcircuit regions, each renders independently
 */

import { useEffect, useMemo, useState } from "react";
import type { DieAnnotations, FloorplanRegion, SpiceConfig } from "shared";
import {
  SpiceSchematicPrototype,
} from "./SpiceSchematicPrototype";
import { generateSpiceTSViews, type SpiceTSResult } from "../../lib/schematic/spiceTSFormat";

interface Props {
  annotations: DieAnnotations;
  moduleName: string;
  hierarchical: boolean;
  spiceConfig?: SpiceConfig;
  floorplanRegions?: FloorplanRegion[];
  /** Currently selected region id (controlled from parent for persistence) */
  selectedRegion?: string | null;
  /** Called when user clicks a region button */
  onSelectRegion?: (regionId: string | null) => void;
}

export function SchematicViewPanel({
  annotations,
  moduleName,
  hierarchical,
  spiceConfig,
  floorplanRegions,
  selectedRegion: selectedRegionProp,
  onSelectRegion,
}: Props) {
  const views = useMemo(
    () => generateSpiceTSViews(annotations, moduleName, spiceConfig, hierarchical ? floorplanRegions : undefined),
    [annotations, moduleName, spiceConfig, hierarchical, floorplanRegions],
  );

  // Current region selection (controlled or internal)
  const regionIds = useMemo(() => [...views.perRegion.keys()], [views.perRegion]);
  const [internalRegion, setInternalRegion] = useState<string | null>(
    regionIds[0] ?? null,
  );
  const activeRegion = selectedRegionProp ?? internalRegion;

  // Sync internal when regions change
  useEffect(() => {
    if (regionIds.length > 0 && !regionIds.includes(activeRegion ?? '')) {
      const next = regionIds[0];
      setInternalRegion(next);
      onSelectRegion?.(next);
    }
  }, [regionIds.join(',')]);

  const handleSelectRegion = (id: string) => {
    setInternalRegion(id);
    onSelectRegion?.(id);
  };

  const current: SpiceTSResult | null = useMemo(() => {
    if (hierarchical && activeRegion) {
      return views.perRegion.get(activeRegion)?.result ?? null;
    }
    return views.flat;
  }, [hierarchical, activeRegion, views]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Hierarchical region sidebar */}
      {hierarchical && regionIds.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 4,
            padding: "6px 8px",
            background: "var(--l1)",
            borderBottom: "1px solid var(--l2)",
            overflow: "auto",
            flexShrink: 0,
            flexWrap: "wrap",
          }}
        >
          {regionIds.map((id) => {
            const reg = views.perRegion.get(id)!;
            const active = id === activeRegion;
            return (
              <button
                key={id}
                type="button"
                className={"btn sm" + (active ? " on" : "")}
                onClick={() => handleSelectRegion(id)}
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <span>{reg.name}</span>
                <span style={{ fontSize: 9, opacity: 0.6 }}>
                  {reg.result.totalDevices} devices
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Schematic canvas */}
      <div
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          position: "relative",
        }}
      >
        {current ? (
          <SpiceSchematicPrototype netlist={current.netlist} height={800} />
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--ink3)",
              fontStyle: "italic",
              fontSize: 12,
            }}
          >
            {regionIds.length > 0
              ? "Select a region"
              : "No analog devices found"}
          </div>
        )}
      </div>
    </div>
  );
}
