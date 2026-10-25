import {
  PROCESS_GROUP_NAMES,
  PROCESS_LAYERS,
  SUBSTRATE_NAMES,
  isGroupLinked,
  processCandidateLayers,
  processPreset,
  type ProcessConfig,
  type ProcessGroup,
  type ProcessKind
} from "shared";
import { useActionDispatcher } from "../../api/actions";
import { useAnnotations } from "../../api/annotations";
import { Ic } from "../../icons";
import { buildFlipAction, toggleGroupLink } from "../../lib/process";
import { useSession } from "../../state/session";

/**
 * Per-die silicon process: which layers below metal 1 the die has (offered as
 * wire layers), the polarity flip toggle (P-sub ⇄ N-sub: N-well ⇄ P-well,
 * N+ ⇄ P+ …, relabelling everything drawn on them) and a link per layer
 * group that takes that group out of the flip. All changes are undoable.
 */

function useProcess() {
  const dieId = useSession((s) => s.dieId) ?? "";
  const { data: annotations } = useAnnotations(dieId || undefined);
  const dispatcher = useActionDispatcher(dieId);
  const process = annotations?.process ?? null;
  const setProcess = (next: ProcessConfig | null) =>
    void dispatcher.dispatch({ kind: "setProcess", process: next, prevProcess: process });
  const flip = () => {
    const action = annotations && buildFlipAction(annotations);
    if (action) void dispatcher.dispatch(action);
  };
  return { dieId, process, setProcess, flip };
}

const substrateLabel = (process: ProcessConfig) => (process.substrate === "p" ? "P-sub" : "N-sub");

/** Compact flip toggle for the wire tool's option bar. */
export function ProcessFlipChip() {
  const { process, flip } = useProcess();
  if (!process) return null;
  const unlinked = (process.unlinked ?? []).map((g) => PROCESS_GROUP_NAMES[g]);
  return (
    <button
      type="button"
      className="chip"
      style={{ cursor: "pointer" }}
      title={
        `Flip polarity: ${SUBSTRATE_NAMES[process.substrate]} → ${SUBSTRATE_NAMES[process.substrate === "p" ? "n" : "p"]}. ` +
        "Relabels wires, contacts and floorplan tags on linked layers (one undo step)." +
        (unlinked.length ? ` Not linked: ${unlinked.join(", ")}.` : "")
      }
      onClick={flip}
    >
      {substrateLabel(process)} ⇄
    </button>
  );
}

/** "Process" section of the Net settings popover. */
export function ProcessSettings() {
  const { dieId, process, setProcess, flip } = useProcess();
  if (!dieId) return null;

  const groups: ProcessGroup[] = process
    ? [
        "substrate",
        ...new Set(
          process.layers
            .map((l) => PROCESS_LAYERS[l].group)
            .filter((g): g is Exclude<ProcessGroup, "substrate"> => g !== null)
        )
      ]
    : [];

  return (
    <div>
      <div className="row" style={{ gap: 8, margin: "12px 0 8px", alignItems: "center" }}>
        <span className="u">Process</span>
        <select
          style={{
            marginLeft: "auto",
            fontSize: 10,
            background: "var(--l2)",
            color: "var(--ink)",
            border: "1px solid var(--l3)",
            borderRadius: 4,
            padding: "2px 4px"
          }}
          value={process?.kind ?? "none"}
          onChange={(e) => {
            const kind = e.target.value as ProcessKind | "none";
            setProcess(kind === "none" ? null : processPreset(kind, process?.substrate ?? "p"));
          }}
        >
          <option value="none">Metals only</option>
          <option value="cmos">CMOS</option>
          <option value="bipolar">Bipolar</option>
        </select>
      </div>

      {process && (
        <>
          <div className="row" style={{ gap: 6, alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 11 }}>{SUBSTRATE_NAMES[process.substrate]}</span>
            <button
              type="button"
              className="btn sm"
              style={{ marginLeft: "auto" }}
              title="Flip polarity of every linked layer group (and what's drawn on it)"
              onClick={flip}
            >
              {substrateLabel(process)} ⇄ {process.substrate === "p" ? "N-sub" : "P-sub"}
            </button>
          </div>

          <div style={{ fontSize: 10, color: "var(--ink3)", marginBottom: 4 }}>
            Layers on this die — <span style={{ opacity: 0.8 }}>{Ic.link}</span> = follows the flip
          </div>
          {groups.map((group) => {
            const linked = isGroupLinked(process, group);
            const layers = processCandidateLayers(process.kind).filter(
              (l) => (PROCESS_LAYERS[l].group ?? null) === (group === "substrate" ? "__" : group)
            );
            return (
              <div key={group} className="row" style={{ gap: 6, alignItems: "center", fontSize: 11, marginBottom: 4 }}>
                <button
                  type="button"
                  className="btn sm plain"
                  disabled={group === "substrate"}
                  style={{ padding: "0 4px", minWidth: 0, opacity: linked ? 1 : 0.35 }}
                  title={
                    group === "substrate"
                      ? "The substrate is what the toggle flips"
                      : linked
                        ? `${PROCESS_GROUP_NAMES[group]} flips with the toggle — click to keep it as drawn`
                        : `${PROCESS_GROUP_NAMES[group]} is kept as drawn — click to link it to the toggle`
                  }
                  onClick={() => setProcess(toggleGroupLink(process, group))}
                >
                  {Ic.link}
                </button>
                <span style={{ width: 70, color: "var(--ink2)" }}>{PROCESS_GROUP_NAMES[group]}</span>
                {group === "substrate" ? (
                  <span>{SUBSTRATE_NAMES[process.substrate]}</span>
                ) : (
                  <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {layers.map((layer) => (
                      <LayerCheck key={layer} process={process} layer={layer} onChange={setProcess} />
                    ))}
                  </span>
                )}
              </div>
            );
          })}
          <div className="row" style={{ gap: 6, flexWrap: "wrap", fontSize: 11, marginTop: 2 }}>
            {processCandidateLayers(process.kind)
              .filter((l) => {
                const group = PROCESS_LAYERS[l].group;
                return group === null || !groups.includes(group);
              })
              .map((layer) => (
                <LayerCheck key={layer} process={process} layer={layer} onChange={setProcess} />
              ))}
          </div>
          <div style={{ fontSize: 9, color: "var(--ink3)", lineHeight: 1.4, marginTop: 6 }}>
            Checked layers become wire layers below metal 1. CT_* vias contact poly / diffusion / base to metal 1;
            TAP_* vias tap wells, epi and isolation through same-type diffusion.
          </div>
        </>
      )}
    </div>
  );
}

function LayerCheck({
  process,
  layer,
  onChange
}: {
  process: ProcessConfig;
  layer: ProcessConfig["layers"][number];
  onChange: (next: ProcessConfig) => void;
}) {
  const on = process.layers.includes(layer);
  const order = processCandidateLayers(process.kind);
  return (
    <label className="check" title={PROCESS_LAYERS[layer].name} style={{ gap: 3 }}>
      <input
        type="checkbox"
        checked={on}
        onChange={() =>
          onChange({
            ...process,
            layers: on
              ? process.layers.filter((l) => l !== layer)
              : order.filter((l) => l === layer || process.layers.includes(l))
          })
        }
      />
      <span style={{ borderBottom: `2px solid ${PROCESS_LAYERS[layer].color}` }}>{PROCESS_LAYERS[layer].short}</span>
    </label>
  );
}
