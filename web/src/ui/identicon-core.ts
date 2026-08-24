/**
 * Deterministic per-account identicon (GitHub/Gravatar-style): sha256(id)
 * picks a hue and a horizontally-symmetric 5x5 cell grid. Pure and
 * framework-free — see Identicon.tsx for the React wrapper that renders it.
 */
import { sha256 } from "@noble/hashes/sha256";
import { utf8 } from "@runa/core";

export interface IdenticonSpec {
  /** Hue in degrees, [0, 360). */
  hue: number;
  /** 5x5 grid, row-major (cells[r*5 + c]); horizontally symmetric. */
  cells: boolean[];
}

const GRID = 5;
const HALF_COLS = 3; // left half (2 cols) + the center column

/** MSB-first bit `i` of `bytes` (bit 0 = high bit of byte 0). */
function bitAt(bytes: Uint8Array, i: number): boolean {
  const byte = bytes[Math.floor(i / 8)] ?? 0;
  const shift = 7 - (i % 8);
  return ((byte >> shift) & 1) === 1;
}

/**
 * sha256 and bit-extraction are total functions, so this never throws —
 * including for the empty string.
 */
export function identiconSpec(id: string): IdenticonSpec {
  const hash = sha256(utf8(id));

  // First two bytes (16 bits) pick the hue.
  const hue = ((hash[0]! << 8) | hash[1]!) % 360;

  // The next 15 bits (one per left-half+center cell, row-major over 3 cols x
  // 5 rows) seed the grid; mirroring the left half onto the right keeps it
  // horizontally symmetric without spending extra hash bits on the mirror.
  const leftBits: boolean[] = [];
  for (let i = 0; i < GRID * HALF_COLS; i++) {
    leftBits.push(bitAt(hash, 16 + i));
  }

  const cells: boolean[] = new Array(GRID * GRID).fill(false);
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const srcCol = c < HALF_COLS ? c : GRID - 1 - c;
      cells[r * GRID + c] = leftBits[r * HALF_COLS + srcCol]!;
    }
  }

  return { hue, cells };
}

/** Background/foreground colors shared by the SVG string and the React component. */
export function identiconColors(hue: number): { bg: string; fg: string } {
  return { bg: `hsl(${hue} 30% 94%)`, fg: `hsl(${hue} 55% 45%)` };
}

/** Inline SVG markup (viewBox 0 0 5 5, rounded corners) as a plain string. */
export function identiconSvg(id: string, size = 32): string {
  const { hue, cells } = identiconSpec(id);
  const { bg, fg } = identiconColors(hue);
  let rects = "";
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      if (cells[r * GRID + c]) {
        rects += `<rect x="${c}" y="${r}" width="1" height="1" fill="${fg}"/>`;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 5 5">` +
    `<rect x="0" y="0" width="5" height="5" rx="0.8" fill="${bg}"/>${rects}</svg>`
  );
}
