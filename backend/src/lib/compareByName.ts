/**
 * compareByName.ts — Name-based LVS comparator.
 *
 * Algorithm B (Net Signature): builds per-net adjacency signatures
 * from device connections, groups nets by signature, compares multisets.
 * Devices matched by NAME (case-insensitive). Net names are independent.
 */

interface ParsedDevice {
  name: string;
  modelType: string;
  terminals: string[];
  raw: string;
}

const SYMMETRIC_PREFIXES = new Set(["R", "C", "L"]);

function isOrdered(name: string): boolean {
  // Q=BJT, M=MOS, D=Diode, J=JFET — terminal order matters
  return !SYMMETRIC_PREFIXES.has(name[0]?.toUpperCase() ?? "");
}

function expectedTerminalCount(name: string): number | null {
  const p = name[0]?.toUpperCase() ?? "";
  const map: Record<string, number> = {
    R: 2, C: 2, L: 2,
    D: 2,
    Q: 3,
    M: 4,  // D G S B (bulk may be absent, but take all available)
    J: 3,
  };
  return map[p] ?? null;
}

function knownModelKeyword(s: string): boolean {
  return /^(npn|pnp|nmos|pmos|resistor|capacitor|inductor|diode|zener|ndiod|bjt|mos|jfet|res|cap|ind)$/i.test(s);
}

function isDeviceLine(trimmed: string): boolean {
  if (!trimmed) return false;
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
  if (/^\.?(SUBCKT|ENDS|GLOBAL|PARAM|subckt|ends|global|param)\b/i.test(trimmed)) return false;
  if (/^(parameters|simulator)\b/i.test(trimmed)) return false;
  return /^[A-Za-z_]\w+\s/.test(trimmed);
}

function inferModelType(name: string, explicitModel: string): string {
  if (explicitModel) return explicitModel;
  const prefix = name[0]?.toUpperCase() ?? "";
  const map: Record<string, string> = {
    R: "resistor", C: "capacitor", L: "inductor",
    Q: "bjt", M: "mos", D: "diode", J: "jfet",
  };
  return map[prefix] ?? "unknown";
}

function parseTerminalsCDL(rest: string, expectedCount: number | null): { terminals: string[]; afterTerms: string } {
  const parts = rest.trim().split(/\s+/).filter(Boolean);

  if (expectedCount !== null) {
    // Take first N tokens as terminals
    const terminals = parts.slice(0, expectedCount);
    const afterTerms = parts.slice(expectedCount).join(" ");
    return { terminals, afterTerms };
  }

  // Fallback: collect until we hit a value or known model keyword
  const terminals: string[] = [];
  let afterIdx = parts.length;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    // Value starts with digit or contains =
    if (/^[0-9eE.+\-]/.test(p[0] ?? "") || p.includes("=")) {
      afterIdx = i;
      break;
    }
    // Known model keyword — it's not a terminal
    if (knownModelKeyword(p)) {
      afterIdx = i;
      break;
    }
    terminals.push(p);
  }

  return {
    terminals,
    afterTerms: parts.slice(afterIdx).join(" "),
  };
}

function parseTerminals(rest: string, deviceName: string): { terminals: string[]; afterTerms: string } {
  // Spectre: (n1 n2 n3) rest...
  const parenMatch = rest.match(/^\(([^)]+)\)\s*(.*)/);
  if (parenMatch) {
    const terminals = parenMatch[1].split(/\s+/).filter(Boolean);
    const afterTerms = parenMatch[2].trim();
    return { terminals, afterTerms };
  }
  // CDL positional: use expected count from device prefix
  return parseTerminalsCDL(rest, expectedTerminalCount(deviceName));
}

function parseDevices(netlist: string): ParsedDevice[] {
  const devices: ParsedDevice[] = [];

  for (const raw of netlist.split("\n")) {
    const trimmed = raw.trim();
    if (!isDeviceLine(trimmed)) continue;

    const nameMatch = trimmed.match(/^([A-Za-z_]\w*)\s+/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const rest = trimmed.slice(nameMatch[0].length);

    const { terminals, afterTerms } = parseTerminals(rest, name);

    // Extract model type: first alphabetic known-model token in afterTerms
    const mtMatch = afterTerms.match(/^([A-Za-z]\w*)/);
    const explicitModel = (mtMatch && knownModelKeyword(mtMatch[1])) ? mtMatch[1] : "";
    const modelType = inferModelType(name, explicitModel);

    devices.push({ name, modelType, terminals, raw: trimmed });
  }

  return devices;
}

export interface NameBasedResult {
  matched: boolean;
  a_devices: number;
  b_devices: number;
  a_nets: number;
  b_nets: number;
  unbalanced: Array<{
    what: "device" | "net";
    a_count: number;
    b_count: number;
    a: string[];
    b: string[];
  }>;
  property_diffs: Array<{
    kind: string;
    a_device: string;
    b_device: string;
    param: string;
    a_value: number;
    b_value: number;
  }>;
  details: {
    mismatchedDevices: Array<{
      name: string;
      reason: "type" | "connection" | "param";
      layout: { modelType: string; terminals: string[] };
      schematic: { modelType: string; terminals: string[] };
    }>;
    netMap: Record<string, string>;
  };
}

function buildNetSignatures(
  devices: ParsedDevice[],
): Map<string, string[]> {
  const netSigs = new Map<string, Set<string>>();

  for (const dev of devices) {
    const ordered = isOrdered(dev.name);
    for (let i = 0; i < dev.terminals.length; i++) {
      const net = dev.terminals[i];
      if (!netSigs.has(net)) netSigs.set(net, new Set());
      const termKey = ordered ? `${i}` : "*";
      const sig = `${dev.name.toLowerCase()}:${termKey}`;
      netSigs.get(net)!.add(sig);
    }
  }

  const result = new Map<string, string[]>();
  for (const [net, sigs] of netSigs) {
    result.set(net, [...sigs].sort());
  }
  return result;
}

function groupBySignature(netSigs: Map<string, string[]>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [net, sigs] of netSigs) {
    const key = sigs.join(",");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(net);
  }
  return groups;
}

export function compareByName(
  layoutNetlist: string,
  schematicNetlist: string,
): NameBasedResult {
  const lDevices = parseDevices(layoutNetlist);
  const sDevices = parseDevices(schematicNetlist);

  const lMap = new Map<string, ParsedDevice>();
  const sMap = new Map<string, ParsedDevice>();
  for (const d of lDevices) lMap.set(d.name.toLowerCase(), d);
  for (const d of sDevices) sMap.set(d.name.toLowerCase(), d);

  // 1. Build net signatures
  const lSigs = buildNetSignatures(lDevices);
  const sSigs = buildNetSignatures(sDevices);

  // 2. Group nets by signature
  const lGroups = groupBySignature(lSigs);
  const sGroups = groupBySignature(sSigs);

  // 3. Build net mapping from matching signatures
  const netMap: Record<string, string> = {};
  const allSigKeys = new Set([...lGroups.keys(), ...sGroups.keys()]);
  const unbalancedNets: NameBasedResult["unbalanced"] = [];

  for (const sig of allSigKeys) {
    const lNets = lGroups.get(sig) ?? [];
    const sNets = sGroups.get(sig) ?? [];
    if (lNets.length !== sNets.length) {
      unbalancedNets.push({
        what: "net",
        a_count: lNets.length,
        b_count: sNets.length,
        a: lNets,
        b: sNets,
      });
      continue;
    }
    for (let i = 0; i < lNets.length; i++) {
      netMap[lNets[i]] = sNets[i];
    }
  }

  // 4. Compare devices by name
  const allNames = new Set([...lMap.keys(), ...sMap.keys()]);
  const mismatchedDevices: NameBasedResult["details"]["mismatchedDevices"] = [];
  const unbalancedDevices: NameBasedResult["unbalanced"] = [];
  const propertyDiffs: NameBasedResult["property_diffs"] = [];

  for (const name of allNames) {
    const lDev = lMap.get(name);
    const sDev = sMap.get(name);

    if (!lDev) {
      unbalancedDevices.push({ what: "device", a_count: 0, b_count: 1, a: [], b: [name] });
      continue;
    }
    if (!sDev) {
      unbalancedDevices.push({ what: "device", a_count: 1, b_count: 0, a: [name], b: [] });
      continue;
    }

    // Type check
    const lType = lDev.modelType.toLowerCase();
    const sType = sDev.modelType.toLowerCase();
    if (lType !== sType) {
      mismatchedDevices.push({
        name,
        reason: "type",
        layout: { modelType: lDev.modelType, terminals: lDev.terminals },
        schematic: { modelType: sDev.modelType, terminals: sDev.terminals },
      });
      continue;
    }

    // Connection check via net mapping (name-independent).
    // All devices (ordered + symmetric) use the same mapped comparison.
    // Net mapping handles renamed nets. Exclusive-net swaps are graph-isomorphic
    // (Q6: net2110↔net2111 is the same circuit) — name-independent by design.
    const lTerms = lDev.terminals;
    const sTerms = sDev.terminals;
    const mappedTerms = lTerms.map((t) => netMap[t] ?? t);
    const ordered = isOrdered(lDev.name);

    let termsMatch: boolean;
    if (ordered) {
      termsMatch =
        mappedTerms.length === sTerms.length &&
        mappedTerms.every((t, i) => t === sTerms[i]);
    } else {
      const sortedMapped = [...mappedTerms].sort();
      const sortedS = [...sTerms].sort();
      termsMatch =
        sortedMapped.length === sortedS.length &&
        sortedMapped.every((t, i) => t === sortedS[i]);
    }

    if (!termsMatch) {
      mismatchedDevices.push({
        name,
        reason: "connection",
        layout: { modelType: lDev.modelType, terminals: lTerms },
        schematic: { modelType: sDev.modelType, terminals: sTerms },
      });
    }

    // Param check: only when topology already matches
    if (termsMatch) {
      const lParams = lDev.raw.replace(/^[A-Za-z_]\w+\s+/, "").replace(/\([^)]*\)/, "").trim();
      const sParams = sDev.raw.replace(/^[A-Za-z_]\w+\s+/, "").replace(/\([^)]*\)/, "").trim();
      if (lParams && sParams && lParams !== sParams) {
        const lVal = parseFloat(
          lParams.split(/\s+/).find((t) => /[0-9]/.test(t))?.replace(/^[A-Za-z]+\s*/, "").replace(/.*=/, "") ?? ""
        );
        const sVal = parseFloat(
          sParams.split(/\s+/).find((t) => /[0-9]/.test(t))?.replace(/^[A-Za-z]+\s*/, "").replace(/.*=/, "") ?? ""
        );
        if (!isNaN(lVal) && !isNaN(sVal) && lVal !== sVal) {
          propertyDiffs.push({
            kind: lDev.modelType,
            a_device: lDev.name,
            b_device: sDev.name,
            param: "value",
            a_value: lVal,
            b_value: sVal,
          });
          mismatchedDevices.push({
            name,
            reason: "param",
            layout: { modelType: lDev.modelType, terminals: lDev.terminals },
            schematic: { modelType: sDev.modelType, terminals: sDev.terminals },
          });
        }
      }
    }
  }

  const allUnbalanced = [...unbalancedNets, ...unbalancedDevices];
  // matched = no unbalanced devices/nets AND no type/connection mismatches
  // (param-only mismatches still count as matched topology)
  const hardMismatches = mismatchedDevices.filter((d) => d.reason !== "param");
  const matched = allUnbalanced.length === 0 && hardMismatches.length === 0;

  return {
    matched,
    a_devices: lDevices.length,
    b_devices: sDevices.length,
    a_nets: lSigs.size,
    b_nets: sSigs.size,
    unbalanced: allUnbalanced,
    property_diffs: propertyDiffs,
    details: {
      mismatchedDevices,
      netMap,
    },
  };
}
