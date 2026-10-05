import { describe, expect, it } from "vitest";
import type { IOPin } from "shared";
import { padCountByPin, pastePinActions, pinClips, renamePinActions, selectedPins } from "./pinClipboard";

const pads: IOPin[] = [
  { id: "a", x: 10, y: 20, pin: 5, name: "VDD" },
  { id: "b", x: 300, y: 20, pin: 7, name: "OUT" }
];

describe("pad copy / paste", () => {
  it("pastes copies with the same number and name at a new place", () => {
    const clips = pinClips(selectedPins(pads, new Set(["pin:a", "cell:x"])), 10, 20);
    expect(clips).toEqual([{ pin: 5, name: "VDD", offsetX: 0, offsetY: 0 }]);
    const [action] = pastePinActions(clips, { x: 500.4, y: 80 });
    expect(action.kind).toBe("addPin");
    if (action.kind !== "addPin") return;
    expect(action.pin).toMatchObject({ x: 500, y: 80, pin: 5, name: "VDD" });
    expect(action.pin.id).not.toBe("a");
  });

  it("keeps relative placement for several pads", () => {
    const clips = pinClips(pads, 10, 20);
    const placed = pastePinActions(clips, { x: 0, y: 0 }).map((a) => (a.kind === "addPin" ? [a.pin.x, a.pin.y] : null));
    expect(placed).toEqual([[0, 0], [290, 0]]);
  });

  it("renaming renames every pad of that pin, nothing else", () => {
    const withCopy = [...pads, { id: "c", x: 10, y: 900, pin: 5, name: "VDD" }];
    const actions = renamePinActions(withCopy, 5, "VCC");
    expect(actions.map((a) => (a.kind === "upsertPin" ? [a.pin.id, a.pin.name] : null))).toEqual([
      ["a", "VCC"],
      ["c", "VCC"]
    ]);
    expect(padCountByPin(withCopy).get(5)).toBe(2);
  });
});
