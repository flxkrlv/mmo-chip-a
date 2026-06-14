import { Navigate, Route, Routes } from "react-router-dom";
import { LibraryPage } from "./routes/LibraryPage";
import { DieViewerPage } from "./routes/DieViewerPage";
import { MergeCellsPage } from "./routes/MergeCellsPage";
import { RECellPage } from "./routes/RECellPage";
import { CodePage } from "./routes/CodePage";
import { AnalogNetlistPage } from "./routes/AnalogNetlistPage";

export default function App() {
  return (
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
  );
}
