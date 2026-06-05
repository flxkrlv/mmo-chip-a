import { useEffect, useRef } from "react";
import type { ForcedDiffusionType, ShapeLabel } from "shared";
import { DiffTypeItem, LabelItem } from "./ShapeContextMenu";

/**
 * Right-click context menu for the right-panel rows. Smaller than
 * `ShapeContextMenu` (no Duplicate/Copy/Paste/Delete — those don't
 * apply to inferred entities) and tightly scoped per row kind:
 *
 *   - net row     → set / clear the net's role label (VDD / GND /
 *                   I/O / Input / Output). The page resolves the
 *                   net id to a representative member shape and
 *                   writes `label` there; extraction's net pass
 *                   propagates it back.
 *   - diffusion   → set / clear the body's forcedType (P / N).
 *
 * Reuses the existing `LabelItem` and `DiffTypeItem` so the row
 * menu's submenus look identical to the canvas one — same check-
 * mark behaviour, same "click an active item to toggle off" rule.
 */

export type RowContextMenuState =
  | {
      kind: "net";
      x: number;
      y: number;
      netId: number;
      currentLabel: ShapeLabel | null;
    }
  | {
      kind: "diffusion";
      x: number;
      y: number;
      diffusionShapeId: string;
      currentForcedType: ForcedDiffusionType | null;
    };

interface Props {
  menu: RowContextMenuState;
  onClose: () => void;
  /** Set / clear a net's role label (writes through to a
   *  representative shape in the page's handler). */
  onSetNetLabel: (netId: number, label: ShapeLabel | null) => void;
  /** Set / clear a diffusion's forced P/N type. */
  onSetDiffusionForcedType: (
    diffShapeId: string,
    type: ForcedDiffusionType | null,
  ) => void;
}

const MENU_W = 200;

export function RowContextMenu({
  menu,
  onClose,
  onSetNetLabel,
  onSetDiffusionForcedType,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Dismissal: click-outside / Escape / scroll close the menu. Same
  // pattern as the existing canvas menus.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDocClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      ref={ref}
      className="menu"
      style={{
        position: "fixed",
        left: menu.x,
        top: menu.y,
        zIndex: 1000,
        minWidth: MENU_W,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.kind === "net" && (
        <>
          <div className="menu-section">Net label</div>
          <LabelItem
            label="Label as VDD"
            target="vcc"
            current={menu.currentLabel}
            onPick={(l) => run(() => onSetNetLabel(menu.netId, l))()}
          />
          <LabelItem
            label="Label as GND"
            target="gnd"
            current={menu.currentLabel}
            onPick={(l) => run(() => onSetNetLabel(menu.netId, l))()}
          />
          <LabelItem
            label="Label as Chip I/O"
            target="io"
            current={menu.currentLabel}
            onPick={(l) => run(() => onSetNetLabel(menu.netId, l))()}
          />
          <LabelItem
            label="Label as Input"
            target="input"
            current={menu.currentLabel}
            onPick={(l) => run(() => onSetNetLabel(menu.netId, l))()}
          />
          <LabelItem
            label="Label as Output"
            target="output"
            current={menu.currentLabel}
            onPick={(l) => run(() => onSetNetLabel(menu.netId, l))()}
          />
          {menu.currentLabel !== null && (
            <button
              className="menu-item"
              onClick={run(() => onSetNetLabel(menu.netId, null))}
            >
              Clear label
            </button>
          )}
        </>
      )}
      {menu.kind === "diffusion" && (
        <>
          <div className="menu-section">Diffusion type</div>
          <DiffTypeItem
            label="Force P-type (VDD body)"
            target="p"
            current={menu.currentForcedType}
            onPick={(t) =>
              run(() => onSetDiffusionForcedType(menu.diffusionShapeId, t))()
            }
          />
          <DiffTypeItem
            label="Force N-type (GND body)"
            target="n"
            current={menu.currentForcedType}
            onPick={(t) =>
              run(() => onSetDiffusionForcedType(menu.diffusionShapeId, t))()
            }
          />
          {menu.currentForcedType !== null && (
            <button
              className="menu-item"
              onClick={run(() =>
                onSetDiffusionForcedType(menu.diffusionShapeId, null),
              )}
            >
              Clear (auto-infer)
            </button>
          )}
        </>
      )}
    </div>
  );
}
