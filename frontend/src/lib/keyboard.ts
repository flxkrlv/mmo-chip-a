/**
 * True when a keyboard event originated from an editable field (text input,
 * textarea, or contentEditable). Global window-level shortcut handlers use
 * this to bail so typing into a field never triggers canvas shortcuts.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable)
  );
}
