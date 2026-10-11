/**
 * Глобально отменяет браузерный зум колесом/тачпадом (Ctrl/Cmd + wheel, pinch).
 *
 * - Ctrl/Cmd + "+" / "-" / "0" НЕ трогаем: клавиатурный зум остаётся.
 * - Внутренний зум канвасов не ломается: мы только вызываем preventDefault()
 *   и НЕ вызываем stopPropagation(), поэтому обработчики компонентов работают как раньше.
 * - Capture-фаза нужна потому, что часть компонентов (например MultiOverlayPanel)
 *   останавливает всплытие wheel-события, и bubble-обработчик на window до него не дойдёт.
 * - passive: false обязателен: Chrome делает wheel-листенеры на window passive по умолчанию,
 *   и в passive-листенере preventDefault() игнорируется.
 */

const GESTURE_EVENTS = ["gesturestart", "gesturechange", "gestureend"] as const;

export function installWheelZoomGuard(target: Window = window): () => void {
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  };

  // Safari на macOS присылает pinch как gesture*-события, а не как wheel.
  const onGesture = (e: Event) => e.preventDefault();

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
