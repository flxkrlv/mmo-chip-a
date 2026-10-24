/**
 * The bottom status line must never change its height: it sits in a flex
 * column right under the canvas, so a second line of text would shrink the
 * canvas and make it flicker. The line therefore never wraps - when the
 * text does not fit it scrolls like a ticker instead.
 *
 * The helpers here hold the two decisions the component makes: does the
 * text overflow, and how long does one pass take.
 */

/** How fast the text scrolls when it does not fit [px/s]. */
export const MARQUEE_PX_PER_SECOND = 55;

/** The shortest pass of the ticker, no matter how short the text is [s]. */
export const MARQUEE_MIN_SECONDS = 4;

/** The horizontal padding of the status line, both sides together [px]. */
export const STATUS_BAR_PADDING_X = 24;

/** Does the text need more room than the line has? */
export function marqueeNeeded(contentWidth: number, viewWidth: number): boolean {
  return contentWidth > viewWidth + 1;
}

/**
 * How long one full pass of the text takes [s]. The distance is the whole
 * content: the line scrolls by one copy of itself, so the tail comes in
 * from the right while the head leaves on the left.
 */
export function marqueeDuration(
  contentWidth: number,
  pxPerSecond: number = MARQUEE_PX_PER_SECOND
): number {
  if (!(contentWidth > 0) || !(pxPerSecond > 0)) return 0;
  return Math.max(MARQUEE_MIN_SECONDS, contentWidth / pxPerSecond);
}
