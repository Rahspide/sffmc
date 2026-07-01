// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// CRC32 (IEEE 802.3) — table-driven, no external dependencies.
// Extracted from checkpoint.ts (M-1 god-object refactor, Task 1.7).
//
// Used by:
//   - header.ts: per-line CRC32 + file-level CRC32
//   - migrations.ts: file-level CRC32 during v1→v2 migration
//   - reader.ts: indirectly via header.ts

/** Precomputed CRC32 lookup table (IEEE 802.3 polynomial 0xEDB88320,
 *  reflected). Initialized once at module load. */
const CRC32_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  return t;
})();

/** Compute CRC32 (IEEE 802.3) over a UTF-8 string or byte buffer.
 *  Returns an unsigned 32-bit integer. */
export function crc32(data: string | Uint8Array): number {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}