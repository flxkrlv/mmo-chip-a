import { ToolDivider } from "../shell/SubBar";
import { useIcPackageStore, type IcPackageTool } from "../../state/icPackage";

interface ToolbarProps {
  /** Click handler for "Apply to Die Viewer pins" — write package pin names
   *  back to annotations.pins[]. */
  onApplyToDieViewer: () => void;
  /** Disable Apply when no named bonds exist. */
  applyDisabled: boolean;
  /** Optional right-aligned extra content (status, layer selector). */
  right?: React.ReactNode;
}

const TOOLS: Array<{ kind: IcPackageTool; icon: string; label: string }> = [
  { kind: "pan", icon: "✥", label: "Pan / zoom — drag canvas, scroll to zoom" },
  { kind: "name", icon: "Aa", label: "Name — click a package pin to set its name" },
  { kind: "bond", icon: "↔", label: "Bond — click pin, then click die pad" },
];

export function IcPackageToolbar({ onApplyToDieViewer, applyDisabled, right }: ToolbarProps) {
  const tool = useIcPackageStore((s) => s.tool);
  const setTool = useIcPackageStore((s) => s.setTool);
  return (
    <div
      style={{
        height: 38,
        borderBottom: "1px solid var(--l2)",
        background: "var(--card)",
        display: "flex",
        alignItems: "center",
        padding: "0 8px",
        gap: 4,
        flex: "0 0 auto",
      }}
    >
      <span className="u" style={{ fontSize: 10, color: "var(--ink3)", margin: "0 4px 0 2px" }}>
        tools
      </span>
      {TOOLS.map((t) => (
        <button
          key={t.kind}
          type="button"
          title={t.label}
          onClick={() => setTool(t.kind)}
          className={"chip" + (tool === t.kind ? " on" : "")}
          style={{
            minWidth: 28,
            height: 24,
            cursor: "pointer",
            fontWeight: 600,
            fontSize: 12,
            justifyContent: "center",
          }}
        >
          {t.icon}
        </button>
      ))}
      <ToolDivider />
      <button
        type="button"
        className="chip"
        onClick={onApplyToDieViewer}
        disabled={applyDisabled}
        title="Copy package pin names to die viewer pads (annotations.pins[].name)"
        style={{
          fontSize: 11,
          cursor: applyDisabled ? "default" : "pointer",
          opacity: applyDisabled ? 0.5 : 1,
        }}
      >
        Apply to Die Viewer pins
      </button>
      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}
