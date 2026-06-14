import { useEffect, useRef } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { LibraryPage } from "./routes/LibraryPage";
import { DieViewerPage } from "./routes/DieViewerPage";
import { MergeCellsPage } from "./routes/MergeCellsPage";
import { RECellPage } from "./routes/RECellPage";
import { CodePage } from "./routes/CodePage";
import { AnalogNetlistPage } from "./routes/AnalogNetlistPage";
import { NAV_HOTKEYS } from "./lib/hotkeys";
import { useSession } from "./state/session";

/**
 * Tab navigation routes for the number hotkeys (1–5).
 * Mirrors TopBar.tsx's PHASE_TABS layout.
 */
const TAB_ROUTES: Array<{ path: string; die: "none" | "param" | "query" }> = [
  { path: "/", die: "none" },
  { path: "/die", die: "param" },
  { path: "/merge", die: "query" },
  { path: "/re", die: "query" },
  { path: "/code", die: "query" },
  { path: "/analog-netlist", die: "query" },
];

function tabTarget(index: number, dieId: string | null): string {
  const tab = TAB_ROUTES[index];
  if (!tab) return "/";
  if (tab.die === "none" || !dieId) return tab.path;
  if (tab.die === "param") return `/die/${encodeURIComponent(dieId)}`;
  return `${tab.path}?die=${encodeURIComponent(dieId)}`;
}

function NavigationHotkeys() {
  const navigate = useNavigate();
  const dieId = useSession((s) => s.dieId);
  const dieIdRef = useRef(dieId);
  dieIdRef.current = dieId;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const idx = NAV_HOTKEYS[e.key];
      if (idx == null) return;
      e.preventDefault();
      navigate(tabTarget(idx, dieIdRef.current));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return null;
}

export default function App() {
  return (
    <>
      <NavigationHotkeys />
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/die" element={<DieViewerPage />} />
        <Route path="/die/:dieId" element={<DieViewerPage />} />
        <Route path="/merge" element={<MergeCellsPage />} />
        <Route path="/re" element={<RECellPage />} />
        <Route path="/code" element={<CodePage />} />
        <Route path="/analog-netlist" element={<AnalogNetlistPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
