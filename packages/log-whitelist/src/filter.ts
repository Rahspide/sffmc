export interface FilterResult {
  kept: string[];
  dropped: number;
}

/**
 * Keep a line if it matches any whitelist pattern AND doesn't match any blacklist pattern.
 */
export function shouldKeep(line: string, whitelist: RegExp[]): boolean {
  return whitelist.some((re) => re.test(line));
}

export function shouldDrop(line: string, blacklist: RegExp[]): boolean {
  return blacklist.some((re) => re.test(line));
}

/**
 * Filter lines through whitelist and blacklist.
 * Returns kept lines and dropped count.
 */
export function filterLines(
  lines: string[],
  whitelist: RegExp[],
  blacklist: RegExp[],
  maxKeptLines: number,
  truncateMarker: string,
): FilterResult {
  const kept: string[] = [];

  for (const line of lines) {
    if (shouldDrop(line, blacklist)) continue;
    if (shouldKeep(line, whitelist)) {
      if (kept.length >= maxKeptLines) {
        kept.push(truncateMarker.replace("N", String(lines.length - maxKeptLines)));
        break;
      }
      kept.push(line);
    }
  }

  return {
    kept,
    dropped: lines.length - kept.length,
  };
}
