/**
 * Pointer-interaction contract for the tiled canvas. The canvas owns pointer
 * capture, world conversion, and the click-vs-drag threshold; the consumer
 * decides what a gesture means by returning an `Interaction` from
 * `onPointerDown`.
 */

export interface PointerModifiers {
  shift: boolean;
  alt: boolean;
  meta: boolean;
  ctrl: boolean;
}

/** Pointer event data passed into `onPointerDown`, screen + world. */
export interface PointerEventData {
  worldPoint: { x: number; y: number };
  screenPoint: { x: number; y: number };
  button: number;
  modifiers: PointerModifiers;
}

/** Drag event data passed into a `DragHandler`'s callbacks. */
export interface DragEventData {
  worldPoint: { x: number; y: number };
  /** World coord captured at pointer-down. */
  startWorld: { x: number; y: number };
  screenPoint: { x: number; y: number };
  modifiers: PointerModifiers;
}

export interface DragHandler {
  /** Fires once the pointer crosses the click threshold. Use to start
   *  expensive visualizations (e.g. marquee overlay). */
  onDragStart?: (e: DragEventData) => void;
  /** Fires on each pointer move after `onDragStart`. */
  onDragMove?: (e: DragEventData) => void;
  /** Fires on pointer up. `dragged` is true if the threshold was crossed. */
  onPointerUp: (e: DragEventData & { dragged: boolean }) => void;
  /** Pointer cancellation (e.g. browser-initiated capture release). */
  onCancel?: () => void;
}

/**
 * Returned from `onPointerDown` to control this gesture.
 *
 *  - `"pan"`       — built-in pan; if pointer goes up without crossing the
 *                    click threshold, `onCanvasClick` fires.
 *  - `"ignore"`    — swallow the event; nothing happens on move/up.
 *  - `DragHandler` — consumer handles the gesture. Canvas calls your callbacks
 *                    and does not pan. `onCanvasClick` is suppressed.
 */
export type Interaction = "pan" | "ignore" | DragHandler;
