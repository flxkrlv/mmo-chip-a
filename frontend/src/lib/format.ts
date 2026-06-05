export function formatPixels(width: number, height: number): string {
  return `${width.toLocaleString()} × ${height.toLocaleString()} px`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

export function formatTileProgress(completed: number, total: number): string {
  return `tile ${completed.toLocaleString()} / ${total.toLocaleString()}`;
}
