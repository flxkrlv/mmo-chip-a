import { describe, expect, it, vi } from "vitest";

// In-memory stand-in for the backend `analog-devices.json` endpoint.
const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  fail: new Set<string>(),
}));

vi.mock("../api/client", () => ({
  apiGet: vi.fn(async (path: string) => {
    if (h.fail.has(path)) throw new Error("read failed");
    const raw = h.store.get(path);
    return raw ? JSON.parse(raw) : null;
  }),
  apiPost: vi.fn(async (path: string, body: unknown) => {
    h.store.set(path, JSON.stringify(body));
    return { ok: true };
  }),
}));

import {
  collectUsedNameNumbers,
  flushProjectDeviceNames,
  getProjectDeviceNames,
  isProjectNamesLoaded,
  nextFreeInstanceName,
  setActiveProject,
  setProjectDeviceName,
  syncLiveProjectDevices,
  validateProjectDeviceName,
} from "./analogDeviceNames";

async function openProject(dieId: string, devices: Record<string, string>) {
  h.store.set(
    `/api/dies/${dieId}/analog-devices`,
    JSON.stringify({ version: 1, devices }),
  );
  setActiveProject(dieId);
  await vi.waitFor(() => expect(isProjectNamesLoaded()).toBe(true));
}

/** Next auto-name for `prefix`, as the pipeline would compute it. */
function nextAuto(prefix: string): string {
  const used = collectUsedNameNumbers(getProjectDeviceNames());
  return nextFreeInstanceName(prefix, used[prefix] ?? new Set<number>());
}

describe("analog device names — freeing deleted devices", () => {
  it("frees a deleted device's name while keeping live names fixed", async () => {
    await openProject("die-free", { "a@1": "M1", "b@2": "M2", "c@3": "M3" });

    syncLiveProjectDevices(new Set(["a@1", "c@3"]));

    expect(getProjectDeviceNames()).toEqual({ "a@1": "M1", "c@3": "M3" });
    // Manual rename into the freed name is now allowed.
    expect(validateProjectDeviceName("a@1", "M2")).toBeNull();
    // Automatic naming reuses the freed slot.
    expect(nextAuto("M")).toBe("M2");
  });

  it("still rejects a name held by a live device", async () => {
    await openProject("die-dup", { "a@1": "M1", "b@2": "M2" });

    syncLiveProjectDevices(new Set(["a@1", "b@2"]));

    expect(validateProjectDeviceName("a@1", "M2")).not.toBeNull();
    expect(getProjectDeviceNames()).toEqual({ "a@1": "M1", "b@2": "M2" });
  });

  it("allocates the smallest free number per prefix", async () => {
    await openProject("die-gap", { "a@1": "M1", "b@2": "M3", "c@3": "R2" });

    syncLiveProjectDevices(new Set(["a@1", "b@2", "c@3"]));

    expect(nextAuto("M")).toBe("M2");
    expect(nextAuto("R")).toBe("R1");
    expect(nextAuto("C")).toBe("C1");
  });

  it("persists the pruned store", async () => {
    await openProject("die-save", { "a@1": "M1", "b@2": "M2" });

    syncLiveProjectDevices(new Set(["a@1"]));
    flushProjectDeviceNames();

    await vi.waitFor(() => {
      const raw = h.store.get("/api/dies/die-save/analog-devices");
      expect(raw && JSON.parse(raw).devices).toEqual({ "a@1": "M1" });
    });
  });

  it("does not free names before the store has loaded", () => {
    setActiveProject("die-pending");
    setProjectDeviceName("x@9", "M9");

    expect(isProjectNamesLoaded()).toBe(false);
    syncLiveProjectDevices(new Set(["y@1"]));
    expect(getProjectDeviceNames()).toEqual({ "x@9": "M9" });

    setActiveProject(null);
  });

  it("never clobbers stored names when the backend read fails", async () => {
    const apiPath = "/api/dies/die-fail/analog-devices";
    h.store.set(apiPath, JSON.stringify({ version: 1, devices: { "a@1": "M1" } }));
    h.fail.add(apiPath);

    setActiveProject("die-fail");
    await new Promise((resolve) => setTimeout(resolve, 30));

    // A failed read must not be treated as "loaded with zero names".
    expect(isProjectNamesLoaded()).toBe(false);
    // No auto-name and no rename can be persisted while unloaded...
    syncLiveProjectDevices(new Set(["b@2"]));
    setProjectDeviceName("b@2", "M2");
    flushProjectDeviceNames();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // ...so the file on disk still holds the original names.
    expect(JSON.parse(h.store.get(apiPath)!).devices).toEqual({ "a@1": "M1" });

    h.fail.delete(apiPath);
    setActiveProject(null);
  });
});
