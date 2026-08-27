export function formatPixels(width: number, height: number): string {
  return `${width.toLocaleString()} × ${height.toLocaleString()} px`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

export function formatTileProgress(completed: number, total: number): string {
  return `tile ${completed.toLocaleString()} / ${total.toLocaleString()}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}
