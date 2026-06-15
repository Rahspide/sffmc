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
 * Apply suppress patterns to a line. Each matching pattern's match is
 * replaced with empty string (partial-match → substring removal;
 * full-line match → entire line becomes empty string).
 */
export function suppressLine(line: string, patterns: RegExp[]): string {
  for (const re of patterns) {
    line = line.replace(re, "");
  }
  return line;
}

/**
 * Filter lines through suppress patterns, then whitelist and blacklist.
 * Returns kept lines and dropped count.
 *
 * Suppression runs first — matched substrings are blanked out before
 * whitelist/blacklist evaluation. A full-line suppress match will
 * produce an empty string, which won't match any whitelist pattern.
 */
export function filterLines(
  lines: string[],
  whitelist: RegExp[],
  blacklist: RegExp[],
  maxKeptLines: number,
  truncateMarker: string,
  suppressPatterns?: RegExp[],
): FilterResult {
  const pats = suppressPatterns ?? [];
  const kept: string[] = [];

  for (const line of lines) {
    const suppressed = pats.length > 0 ? suppressLine(line, pats) : line;
    if (shouldDrop(suppressed, blacklist)) continue;
    if (shouldKeep(suppressed, whitelist)) {
      if (kept.length >= maxKeptLines) {
        kept.push(truncateMarker.replace("N", String(lines.length - maxKeptLines)));
        break;
      }
      kept.push(suppressed);
    }
  }

  return {
    kept,
    dropped: lines.length - kept.length,
  };
}
