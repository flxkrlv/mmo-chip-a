/**
 * dieWideAnalog.ts — Die-wide analog device collection and export.
 *
 * Collects all analog devices across every cell type on a die,
 * matches terminals to die-level wires via segment-rectangle intersection,
 * and generates CDL/Spectre.
 */

import type {
  AnalogDevice, AnnotationNet, Cell, CellType,
  DeviceKind, DieAnnotations, LayerShape, SpiceConfig,
} from "shared";
import { extractMarkedDevices } from "../lib/extraction/simpleAnalog";
import { generateSpiceNetlist } from "../lib/export/spice";

// ── Geometry helpers ─────────────────────────────────────────────

function shapeBounds(s: LayerShape): {x:number;y:number;width:number;height:number} | null {
  switch (s.kind) {
    case "rect": return { x: s.x, y: s.y, width: s.width, height: s.height };
    case "point": return { x: s.x - s.size/2, y: s.y - s.size/2, width: s.size, height: s.size };
    case "circle": return { x: s.x - s.radius, y: s.y - s.radius, width: s.radius*2, height: s.radius*2 };
    case "polygon": {
      if (s.points.length === 0) return null;
      let mx = Infinity, my = Infinity, Mx = -Infinity, My = -Infinity;
      for (const p of s.points) { if (p.x<mx)mx=p.x; if(p.x>Mx)Mx=p.x; if(p.y<my)my=p.y; if(p.y>My)My=p.y; }
      return { x: mx, y: my, width: Mx-mx, height: My-my };
    }
    case "line": {
      return { x: Math.min(s.x1,s.x2), y: Math.min(s.y1,s.y2), width: Math.abs(s.x2-s.x1), height: Math.abs(s.y2-s.y1) };
    }
    default: return null;
  }
}

function centerOfShape(s: LayerShape): {x:number;y:number}|null {
  switch (s.kind) {
    case "rect": return { x: s.x + s.width/2, y: s.y + s.height/2 };
    case "point": return { x: s.x, y: s.y };
    case "circle": return { x: s.x, y: s.y };
    case "polygon": {
      if (s.points.length===0) return null;
      let sx=0,sy=0; for(const p of s.points){sx+=p.x;sy+=p.y;}
      return {x:sx/s.points.length, y:sy/s.points.length};
    }
    case "line": return { x: (s.x1+s.x2)/2, y: (s.y1+s.y2)/2 };
    default: return null;
  }
}

function rectsOverlap(ax1:number,ay1:number,ax2:number,ay2:number,
                       bx1:number,by1:number,bx2:number,by2:number): boolean {
  return ax1<bx2 && ax2>bx1 && ay1<by2 && ay2>by1;
}

/** Line segment vs axis-aligned rectangle intersection test. */
function segmentIntersectsRect(
  x1:number, y1:number, x2:number, y2:number,
  rx:number, ry:number, rw:number, rh:number,
): boolean {
  const rmxx = rx + rw, rmyy = ry + rh;
  if (x1>=rx && x1<=rmxx && y1>=ry && y1<=rmyy) return true;
  if (x2>=rx && x2<=rmxx && y2>=ry && y2<=rmyy) return true;
  const chk = (ex1:number,ey1:number,ex2:number,ey2:number) => {
    const dcx=x2-x1,dcy=y2-y1, dex=ex2-ex1,dey=ey2-ey1;
    const d=dcx*dey-dcy*dex;
    if (Math.abs(d)<1e-9) return false;
    return (t=>t>=0&&t<=1)(((ex1-x1)*dey-(ey1-y1)*dex)/d) &&
           (u=>u>=0&&u<=1)(((ex1-x1)*dcy-(ey1-y1)*dcx)/d);
  };
  return chk(rx,ry,rmxx,ry)||chk(rmxx,ry,rmxx,rmyy)||chk(rmxx,rmyy,rx,rmyy)||chk(rx,rmyy,rx,ry);
}

// ── Wire-to-terminal matching ────────────────────────────────────

/** Find the die-level wire whose segments intersect a terminal's bounding box. */
function matchWireToTerminal(
  nets: AnnotationNet[],
  termRect: {x:number;y:number;w:number;h:number},
  netIdMap: Map<string,number>,
  nextId: {v:number},
): number|null {
  for (const net of nets) {
    for (const edge of net.edges) {
      const a = net.nodes.find(n=>n.id===edge.from);
      const b = net.nodes.find(n=>n.id===edge.to);
      if (!a||!b) continue;
      if (segmentIntersectsRect(a.x,a.y,b.x,b.y, termRect.x,termRect.y,termRect.w,termRect.h)) {
        if (!netIdMap.has(net.id)) netIdMap.set(net.id, nextId.v++);
        return netIdMap.get(net.id)!;
      }
    }
  }
  return null;
}

// ── Terminal layer mapping ───────────────────────────────────────

function terminalLayersOf(kind: DeviceKind, name: string): string[] {
  switch (kind) {
    case "bjt_npn": case "bjt_pnp":
      return {C:["collector"], B:["base","bulk"], E:["emitter"]}[name]??[];
    case "mos":
      return {D:["drain"], G:["gate"], S:["source"], B:["bulk"]}[name]??[];
    default:
      return ["contact"];
  }
}

// ── Main collection ──────────────────────────────────────────────

export function extractAnalogDevicesFromCellType(
  cellType: CellType, umPerPx: number,
): AnalogDevice[] {
  return extractMarkedDevices(cellType.layers, cellType.id, umPerPx);
}

export function collectDieWideAnalogDevices(
  annotations: DieAnnotations,
  umPerPx: number = 1.0,
  _spiceConfig?: SpiceConfig,
): AnalogDevice[] {
  const ann = annotations as DieAnnotations;
  const allDevices: AnalogDevice[] = [];
  const nets = ann.nets ?? [];

  const cells = ann.cells ?? [];
  const instancesByCt = new Map<string, Cell[]>();
  for (const cell of cells) {
    const list = instancesByCt.get(cell.cellTypeId) ?? [];
    list.push(cell);
    instancesByCt.set(cell.cellTypeId, list);
  }

  const netIdMap = new Map<string, number>();
  const nextNetId = { v: 100 };

  const counters: Record<string,number> = {};
  const pref: Record<string,string> = {
    bjt_npn:"Q",bjt_pnp:"Q",mos:"M",resistor:"R",capacitor:"C",diode:"D",
    jfet_n:"J",jfet_p:"J",unknown:"X",
  };

  for (const ct of ann.cellTypes) {
    const instanceList = instancesByCt.get(ct.id)??[];
    if (instanceList.length===0) continue;

    let ctDevices: AnalogDevice[];
    try { ctDevices = extractMarkedDevices(ct.layers, ct.id, umPerPx); }
    catch(e) { console.warn(`extractMarkedDevices("${ct.name}") failed:`,e); continue; }
    if (ctDevices.length===0) continue;

    for (let inst=0; inst<instanceList.length; inst++) {
      const instCell = instanceList[inst];
      for (const dev of ctDevices) {
        const prefx = pref[dev.kind]??"X";
        counters[prefx] = (counters[prefx]??0) + 1;
        const instName = `${prefx}${counters[prefx]}`;
        const cx = instCell?.x??0, cy = instCell?.y??0;

        const worldBbox = dev.bbox
          ? { ...dev.bbox, x: dev.bbox.x+cx, y: dev.bbox.y+cy }
          : dev.bbox;

        // ── Contact labels ─────────────────────────────────
        const termPoints: Array<{x:number;y:number;name:string}> = [];
        const allContacts = (ct.layers?.contact??[]) as LayerShape[];
        for (const t of dev.terminals) {
          for (const ln of terminalLayersOf(dev.kind, t.name)) {
            const shps = ct.layers?.[ln as keyof typeof ct.layers] as LayerShape[]|undefined;
            if (!shps) continue;
            for (const ts of shps) {
              const tb = shapeBounds(ts); if (!tb) continue;
              for (const cs of allContacts) {
                const cb = shapeBounds(cs); if (!cb) continue;
                if (rectsOverlap(tb.x,tb.y,tb.x+tb.width,tb.y+tb.height, cb.x,cb.y,cb.x+cb.width,cb.y+cb.height)) {
                  const cc = centerOfShape(cs as any);
                  if (cc) termPoints.push({x:cx+cc.x, y:cy+cc.y, name:t.name});
                }
              }
            }
          }
        }

        // ── Terminal regions for wire intersection ────────
        const termRects: Array<{x:number;y:number;w:number;h:number}|null> =
          dev.terminals.map(()=>null);
        for (let ti=0; ti<dev.terminals.length; ti++) {
          let mx=Infinity,my=Infinity,Mx=-Infinity,My=-Infinity;
          for (const ln of terminalLayersOf(dev.kind, dev.terminals[ti].name)) {
            const shps = ct.layers?.[ln as keyof typeof ct.layers] as LayerShape[]|undefined;
            if (!shps) continue;
            for (const s of shps) {
              const b = shapeBounds(s); if (!b) continue;
              if (b.x<mx)mx=b.x; if(b.x+b.width>Mx)Mx=b.x+b.width;
              if (b.y<my)my=b.y; if(b.y+b.height>My)My=b.y+b.height;
            }
          }
          if (mx<Infinity) termRects[ti] = {x:cx+mx, y:cy+my, w:Mx-mx, h:My-my};
        }

        // ── Wire matching via intersection ────────────────
        const matchedTerms = dev.terminals.map((t,ti)=>{
          if (t.netId<0) {
            const fresh = 2000 + allDevices.length*10 + ti;
            return {...t, netId: fresh};
          }
          const tr = termRects[ti];
          if (tr) {
            const wid = matchWireToTerminal(nets, tr, netIdMap, nextNetId);
            if (wid!=null) return {...t, netId: wid};
          }
          const fresh = 2000 + allDevices.length*10 + ti;
          return {...t, netId: fresh};
        });

        allDevices.push({
          ...dev,
          instanceName: instName, terminals: matchedTerms, bbox: worldBbox,
          _termPoints: termPoints
        } as AnalogDevice & { _termPoints: typeof termPoints });
      }
    }
  }

  return allDevices;
}

// ── Export pipeline ──────────────────────────────────────────────

export function detectAndExportDieWide(
  annotations: DieAnnotations,
  moduleName: string,
  dialect: "cdl"|"spectre"|"hspice" = "cdl",
  spiceConfig?: SpiceConfig,
) {
  const devices = collectDieWideAnalogDevices(annotations, spiceConfig?.umPerPx??1.0, spiceConfig);
  const result = generateSpiceNetlist(devices, moduleName, spiceConfig??{}, dialect);
  return { devices, text: result.text, byKind: result.byKind, totalDevices: result.totalDevices, warnings: result.warnings };
}
