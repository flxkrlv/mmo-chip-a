import { describe, expect, it, vi } from "vitest";

// In-memory stand-in for the backend `analog-devices.json` endpoint.
const h = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("../api/client", () => ({
  apiGet: vi.fn(async (path: string) => {
    const raw = h.store.get(path);
    return raw ? JSON.parse(raw) : null;
  }),
  apiPost: vi.fn(async (path: string, body: unknown) => {
    h.store.set(path, JSON.stringify(body));
    return { ok: true };
  }),
}));

import { assignStableInstanceNames } from "./dieWideAnalog";
import {
  getProjectDeviceNames,
  isProjectNamesLoaded,
  setActiveProject,
} from "../state/analogDeviceNames";

function dev(instanceId: string, kind = "mos"): any {
  return {
    instanceName: "",
    kind,
    _instanceId: instanceId,
    _uuid: instanceId,
    _cellLevelKey: instanceId,
  };
}

async function openProject(dieId: string, devices: Record<string, string>) {
  h.store.set(
    `/api/dies/${dieId}/analog-devices`,
    JSON.stringify({ version: 1, devices }),
  );
  setActiveProject(dieId);
  await vi.waitFor(() => expect(isProjectNamesLoaded()).toBe(true));
}

describe("assignStableInstanceNames — deleted devices free their names", () => {
  it("keeps live names, drops a deleted device and reuses its name", async () => {
    await openProject("die-a", { "t@a": "M1", "t@b": "M2", "t@c": "M3" });

    const devices = [dev("t@a"), dev("t@c"), dev("t@d")];
    assignStableInstanceNames(devices);

    expect(devices.map((d) => d.instanceName)).toEqual(["M1", "M3", "M2"]);
    expect(getProjectDeviceNames()).toEqual({
      "t@a": "M1",
      "t@c": "M3",
      "t@d": "M2",
    });
  });

  it("leaves all names untouched when every device is still present", async () => {
    await openProject("die-b", { "t@a": "M1", "t@b": "M2" });

    const devices = [dev("t@a"), dev("t@b")];
    assignStableInstanceNames(devices);

    expect(getProjectDeviceNames()).toEqual({ "t@a": "M1", "t@b": "M2" });
  });

  it("frees every name when all devices are gone", async () => {
    await openProject("die-c", { "t@a": "M1", "t@b": "M2" });

    assignStableInstanceNames([]);

    expect(getProjectDeviceNames()).toEqual({});
  });
});
