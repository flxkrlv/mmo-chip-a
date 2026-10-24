/**
 * Браузерный зум колесом/тачпадом (Ctrl/Cmd + wheel, pinch): по умолчанию отключён.
 *
 * - Ctrl/Cmd + "+" / "-" / "0" НЕ трогаем: клавиатурный зум остаётся.
 * - Внутренний зум канвасов не ломается: мы только вызываем preventDefault()
 *   и НЕ вызываем stopPropagation(), поэтому обработчики компонентов работают как раньше.
 * - Capture-фаза нужна потому, что часть компонентов (например MultiOverlayPanel)
 *   останавливает всплытие wheel-события, и bubble-обработчик на window до него не дойдёт.
 * - passive: false обязателен: Chrome делает wheel-листенеры на window passive по умолчанию,
 *   и в passive-листенере preventDefault() игнорируется.
 * - isAllowed() вызывается на каждом событии. Если вернул true, браузерный зум не блокируется
 *   (поведение по умолчанию браузера). По умолчанию зум заблокирован.
 */

const GESTURE_EVENTS = ["gesturestart", "gesturechange", "gestureend"] as const;

export interface WheelZoomGuardOptions {
  /** true = разрешить браузерный зум Ctrl/Cmd+wheel и pinch. По умолчанию false (зум заблокирован). */
  isAllowed?: () => boolean;
}

export function installWheelZoomGuard(
  target: Window = window,
  options: WheelZoomGuardOptions = {},
): () => void {
  const isAllowed = options.isAllowed ?? (() => false);

  const onWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (isAllowed()) return;
    e.preventDefault();
  };

  // Safari на macOS присылает pinch как gesture*-события, а не как wheel.
  const onGesture = (e: Event) => {
    if (isAllowed()) return;
    e.preventDefault();
  };

  const opts: AddEventListenerOptions = { capture: true, passive: false };
  target.addEventListener("wheel", onWheel, opts);
  for (const type of GESTURE_EVENTS) {
    target.addEventListener(type, onGesture, opts);
  }

  return () => {
    target.removeEventListener("wheel", onWheel, opts);
    for (const type of GESTURE_EVENTS) {
      target.removeEventListener(type, onGesture, opts);
    }
  };
}
