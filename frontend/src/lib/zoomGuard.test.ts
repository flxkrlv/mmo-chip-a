import { afterEach, describe, expect, it } from "vitest";
import { installWheelZoomGuard } from "./zoomGuard";

// Минимальная имитация EventTarget, чтобы не зависеть от jsdom.
// Учитываем capture/passive и флаг defaultPrevented, как у настоящего события.
class FakeTarget {
  private listeners = new Map<string, Array<{ fn: (e: any) => void; capture: boolean; passive: boolean }>>();

  addEventListener(type: string, fn: (e: any) => void, opts?: AddEventListenerOptions) {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture: !!opts?.capture, passive: !!opts?.passive });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (e: any) => void, opts?: AddEventListenerOptions) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((l) => !(l.fn === fn && l.capture === !!opts?.capture)),
    );
  }

  count(type: string) {
    return this.listeners.get(type)?.length ?? 0;
  }

  dispatch(type: string, init: Record<string, unknown> = {}) {
    let prevented = false;
    const event = {
      type,
      defaultPrevented: false,
      preventDefault() {
        if (!this.cancelable) return;
        prevented = true;
        this.defaultPrevented = true;
      },
      cancelable: true,
      ...init,
    };
    for (const l of this.listeners.get(type) ?? []) {
      if (l.passive) {
        // В passive-листенере preventDefault() игнорируется, как в браузере.
        const passiveEvent = { ...event, preventDefault() {} };
        l.fn(passiveEvent);
      } else {
        l.fn(event);
      }
    }
    return { prevented, event };
  }
}

describe("installWheelZoomGuard", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("cancels browser zoom for Ctrl+wheel", () => {
    const target = new FakeTarget();
    uninstall = installWheelZoomGuard(target as unknown as Window);
    const { prevented } = target.dispatch("wheel", { ctrlKey: true, deltaY: -100 });
    expect(prevented).toBe(true);
  });

  it("cancels browser zoom for Cmd+wheel (macOS)", () => {
    const target = new FakeTarget();
    uninstall = installWheelZoomGuard(target as unknown as Window);
    const { prevented } = target.dispatch("wheel", { metaKey: true, deltaY: 100 });
    expect(prevented).toBe(true);
  });

  it("does not touch plain wheel scrolling", () => {
    const target = new FakeTarget();
    uninstall = installWheelZoomGuard(target as unknown as Window);
    const { prevented } = target.dispatch("wheel", { deltaY: 120 });
    expect(prevented).toBe(false);
  });

  it("cancels Safari pinch gesture events", () => {
    const target = new FakeTarget();
    uninstall = installWheelZoomGuard(target as unknown as Window);
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
      expect(target.dispatch(type).prevented).toBe(true);
    }
  });

  it("registers wheel listener in capture phase and non-passive", () => {
    const target = new FakeTarget();
    const seen: Array<{ capture: boolean; passive: boolean }> = [];
    const orig = target.addEventListener.bind(target);
    target.addEventListener = (type: string, fn: any, opts?: any) => {
      if (type === "wheel") seen.push({ capture: !!opts?.capture, passive: !!opts?.passive });
      orig(type, fn, opts);
    };
    uninstall = installWheelZoomGuard(target as unknown as Window);
    expect(seen).toEqual([{ capture: true, passive: false }]);
  });

  it("does not stop propagation, so canvas handlers still run", () => {
    const target = new FakeTarget();
    uninstall = installWheelZoomGuard(target as unknown as Window);
    let stopped = false;
    const event = {
      type: "wheel",
      ctrlKey: true,
      defaultPrevented: false,
      cancelable: true,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
    };
    for (const l of (target as any).listeners.get("wheel")) l.fn(event);
    expect(event.defaultPrevented).toBe(true);
    expect(stopped).toBe(false);
  });

  it("does not block browser zoom when isAllowed() returns true", () => {
    const target = new FakeTarget();
    uninstall = installWheelZoomGuard(target as unknown as Window, { isAllowed: () => true });
    expect(target.dispatch("wheel", { ctrlKey: true, deltaY: -100 }).prevented).toBe(false);
    expect(target.dispatch("wheel", { metaKey: true, deltaY: 100 }).prevented).toBe(false);
    expect(target.dispatch("gesturestart").prevented).toBe(false);
  });

  it("re-reads isAllowed() on every event, so toggling takes effect without reinstall", () => {
    const target = new FakeTarget();
    let allowed = false;
    uninstall = installWheelZoomGuard(target as unknown as Window, { isAllowed: () => allowed });
    expect(target.dispatch("wheel", { ctrlKey: true }).prevented).toBe(true);
    allowed = true;
    expect(target.dispatch("wheel", { ctrlKey: true }).prevented).toBe(false);
    allowed = false;
    expect(target.dispatch("wheel", { ctrlKey: true }).prevented).toBe(true);
  });

  it("uninstall removes all listeners", () => {
    const target = new FakeTarget();
    const off = installWheelZoomGuard(target as unknown as Window);
    expect(target.count("wheel")).toBe(1);
    off();
    expect(target.count("wheel")).toBe(0);
    expect(target.count("gesturestart")).toBe(0);
  });
});
