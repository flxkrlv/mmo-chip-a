# LVS — Layout vs Schematic comparison

**Branch:** `analog-re-wip`
**Engine:** `vyges-lvs` v0.1.11 (Rust, Apache 2.0)

## Current status (MVP — Jul 9)

| Feature | Status |
|---------|--------|
| vyges-lvs integrated | ✅ built from source, installed via `cargo install` |
| Backend endpoint `POST /lvs/compare` | ✅ writes temp netlists + .lvs job, spawns vyges-lvs, returns JSON + text report |
| Frontend tab "LVS" in Analog Netlist page | ✅ Alt+4, click-to-switch |
| Layout netlist auto-filled from extraction | ✅ |
| Schematic netlist paste area | ✅ |
| Compare button + loading state | ✅ |
| MATCH/MISMATCH verdict badge | ✅ |
| Direct device-diff table (filtered from vyges-lvs unbalanced classes) | ✅ only devices with truly different lines shown, cascade artifacts filtered |
| Full vyges-lvs text report | ✅ read-only textarea, scrollable |
| vyges-lvs auto-detect (PATH, ~/.cargo/bin) | ✅ |
| Error handling (ENOENT, timeout, SPICE parse error) | ✅ |

**Verdict correctness:** proven — name-independent graph isomorphism. A renamed/reordered netlist that is structurally identical returns MATCH. A single connection change returns MISMATCH.

**Diagnostic limitation:** vyges-lvs uses 1-WL graph coloring. A single connectivity change cascades through the entire connected component, causing ALL devices/nets in that component to appear in `unbalanced[]`. Our frontend filters out cascade artifacts by cross-referencing the original netlist lines — only devices whose actual text lines differ are shown.

## Omissions / limitations

- **`.GLOBAL`-anchored nets only:** vyges-lvs anchors VDD/GND to prevent global cascade. Internal signal chains still cascade fully.
- **Property diffs not shown in GUI:** vyges-lvs `property_diffs[]` is available in the JSON but not yet rendered in a dedicated table (the text report includes the `—` entries).
- **No re-run on schematic change:** user must press Compare again manually.
- **No save/load of schematic netlists:** pasted schematic is lost on page reload.
- **No mismatch navigation:** clicking a device in the diff table doesn't frame it on the die viewer or scroll to its line in the Code view.

## Plan to completion

### 1. Property diff table (1h)

Parse `property_diffs[]` from the vyges-lvs JSON and render a dedicated table:
```
Param │ Layout │ Value (L) │ Schematic │ Value (S)
w     │ Mp1    │ 840n      │ M1        │ 1.68u
```

### 2. Mismatch navigation (2h)

- Click a device name in the diff table → navigate to die viewer + focus that device.
- Click a device name → scroll to its line in the Code tab's netlist source.
- Reuse existing `onSelectDevice(path)` pattern from `InstanceOutline`.

### 3. Auto re-run on schematic change (1h)

Debounced auto-compare (300ms) when the schematic textarea content changes, so the user sees updated diagnostics without pressing Compare.

### 4. Schematic persistence (2h)

- Save the pasted schematic netlist to backend (`POST /api/dies/:dieId/lvs/schematic`).
- Load on mount; show a "last saved" timestamp.
- Allows page refresh without losing the reference netlist.

### 5. LVS sidebar / panel UX (2h)

- Make the diff table expandable: show only the first 3–5 diffs, "show all N" toggle.
- Add a filter bar: "All", "Changed", "Only in Layout", "Only in Schematic".
- Add a search box to filter devices by name.

### 6. Documentation (1h)

- Inline comments in `backend/src/api/lvs.ts` and `LVSComparePanel.tsx`.
- Usage guide in the README: how to install vyges-lvs, environment variables, demo walkthrough.

**Total remaining: ~9h**

## vyges-lvs binary

- **Binary location:** `~/.cargo/bin/vyges-lvs.exe` (2 MB)
- **Build artifacts (cargo):** `~/.cargo/git/`, `~/.cargo/registry/` — development only, ~200 MB
- **Rust toolchain:** `~/.rustup/` — development only, ~1.5 GB
- **Production deployment:** only the 2 MB binary needed; set `LVS_CLI_PATH` or ensure it's on PATH
- **Source:** `cargo install --git https://github.com/vyges-tools/lvs` (public, Apache 2.0)

## Setup on a fresh machine

### Windows

The repo includes an auto-setup script:

```powershell
scripts\setup-lvs.bat
```

It checks for vyges-lvs, installs Rust if missing, then builds vyges-lvs from source.

**Manual steps:**
1. Install Rust: `winget install Rustlang.Rustup` or https://rustup.rs
2. `cargo install --git https://github.com/vyges-tools/lvs` (3–10 min, ~1.5 GB Rust toolchain)
3. `cd backend && npm run dev` — бэкенд сам найдёт `~/.cargo/bin/vyges-lvs.exe`

**What gets downloaded:** Rust toolchain (~1.5 GB) is one-time. vyges-lvs build pulls Cargo dependencies (~200 MB). Final binary is 2 MB. To reclaim space after build: `cargo clean`.

### Linux / macOS

```bash
chmod +x scripts/setup-lvs.sh && ./scripts/setup-lvs.sh
```

The script downloads a prebuilt binary (Linux x86_64/aarch64, macOS aarch64) from GitHub releases, installs to `~/.local/bin/`. Falls back to `cargo install` if no prebuilt binary for your arch.
