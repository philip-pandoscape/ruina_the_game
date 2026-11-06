// Hexagons, pointy side up, in axial coordinates (q along a row, r down the rows): where one is
// drawn, for boards of them (a mini-game's, src/ui/minigames/boards/ and src/render/open/gameBoards/).

/** Where hex (q, r)'s middle is, on a board of hexes `size` from middle to corner: x across, y down. */
export function hexCentre(q: number, r: number, size: number): { x: number; y: number } {
  return { x: size * Math.sqrt(3) * (q + r / 2), y: size * 1.5 * r };
}
