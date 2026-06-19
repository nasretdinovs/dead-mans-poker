import { describe, it, expect } from 'vitest';
import { computeSeatPositions } from '../src/seats.js';

describe('computeSeatPositions', () => {
  it('returns an empty array for no players', () => {
    expect(computeSeatPositions([], 'p1')).toEqual([]);
  });

  it('places a single player at bottom-center without dividing by zero', () => {
    const [seat] = computeSeatPositions(['p1'], 'p1');
    expect(seat.playerId).toBe('p1');
    expect(seat.x).toBeCloseTo(450);
    expect(seat.y).toBeCloseTo(430); // cy(240) + ry(190)
  });

  it('always rotates "me" to the bottom-center seat regardless of array position', () => {
    const seats = computeSeatPositions(['p1', 'p2'], 'p2');
    const me = seats.find(s => s.playerId === 'p2');
    expect(me.x).toBeCloseTo(450);
    expect(me.y).toBeCloseTo(430);
  });

  it('falls back to rotationOffset 0 when myPid is not present, without throwing', () => {
    expect(() => computeSeatPositions(['p1', 'p2', 'p3'], 'nonexistent')).not.toThrow();
    const seats = computeSeatPositions(['p1', 'p2', 'p3'], 'nonexistent');
    expect(seats).toHaveLength(3);
  });

  it('returns results in input order, not angle order', () => {
    const seats = computeSeatPositions(['p3', 'p1', 'p2'], 'p1');
    expect(seats.map(s => s.playerId)).toEqual(['p3', 'p1', 'p2']);
  });

  it('honors a custom geometry override', () => {
    const [seat] = computeSeatPositions(['p1'], 'p1', { cx: 100, cy: 100, rx: 50, ry: 25 });
    expect(seat.x).toBeCloseTo(100);
    expect(seat.y).toBeCloseTo(125);
  });
});
