// Pure seat-position math, extracted from renderGame's trig block. Player at `myPid` is always
// rotated to the bottom-center seat (angle = PI/2), matching the original behavior.

export function computeSeatPositions(playerIds, myPid, geometry = {}) {
  const { cx = 450, cy = 240, rx = 380, ry = 190 } = geometry;
  const total = playerIds.length;
  if (total === 0) return [];

  const myIndex = playerIds.indexOf(myPid);
  const rotationOffset = myIndex >= 0 ? myIndex : 0;

  return playerIds.map((playerId, i) => {
    const rotated = (i - rotationOffset + total) % total;
    const angle = Math.PI / 2 + (rotated * 2 * Math.PI) / total;
    return { playerId, x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
  });
}
