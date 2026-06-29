import { describe, it, expect } from 'vitest';
import {
  votesToPlayers,
  toNumericVote,
  computeResult,
  isCurrentVote,
  resolveJoin,
  getRoomFromUrl,
  makeRoomId,
} from '../src/state.js';

describe('toNumericVote', () => {
  it('parses the half-symbol card', () => {
    expect(toNumericVote('½')).toBe(0.5);
  });
  it('parses plain integers', () => {
    expect(toNumericVote('100')).toBe(100);
  });
  it('parses decimals', () => {
    expect(toNumericVote('3.5')).toBe(3.5);
  });
  it('returns null for non-numeric cards', () => {
    expect(toNumericVote('?')).toBeNull();
    expect(toNumericVote('XL')).toBeNull();
  });
});

describe('computeResult', () => {
  it('returns "no bets" for an empty vote list', () => {
    expect(computeResult([], 'fibonacci')).toEqual({ value: '—', sub: 'no bets', allSame: false });
  });

  it('filters out null (unvoted) entries', () => {
    expect(computeResult([null, null], 'fibonacci')).toEqual({ value: '—', sub: 'no bets', allSame: false });
  });

  it('averages unanimous numeric votes', () => {
    expect(computeResult(['5', '5', '5'], 'fibonacci')).toEqual({
      value: '5',
      sub: 'average of 3 bets',
      allSame: true,
    });
  });

  it('uses singular "bet" for a single vote', () => {
    expect(computeResult(['5'], 'fibonacci')).toEqual({
      value: '5',
      sub: 'average of 1 bet',
      allSame: true,
    });
  });

  it('rounds the average to one decimal place', () => {
    expect(computeResult(['1', '2', '5'], 'fibonacci')).toEqual({
      value: '2.7',
      sub: 'average of 3 bets',
      allSame: false,
    });
  });

  it('rounds 0.75 up to 0.8 (half-symbol mixed average)', () => {
    expect(computeResult(['½', '1'], 'fibonacci').value).toBe('0.8');
  });

  it('preserves the documented quirk: sub counts all votes, average divides by numeric ones only', () => {
    const res = computeResult(['5', '5', '?'], 'fibonacci');
    expect(res.value).toBe('5'); // average of [5,5] only
    expect(res.sub).toBe('average of 3 bets'); // counts the '?' too
  });

  it('falls back to mode when no votes parse as numbers on a numeric deck', () => {
    expect(computeResult(['?', '?'], 'fibonacci')).toEqual({
      value: '?',
      sub: 'most common of 2 bets',
      allSame: true,
    });
  });

  it('never averages on the tshirt deck even if values look numeric', () => {
    expect(computeResult(['1', '1'], 'tshirt')).toEqual({
      value: '1',
      sub: 'most common of 2 bets',
      allSame: true,
    });
  });

  it('picks the first-inserted value on a tie for mode', () => {
    expect(computeResult(['S', 'M', 'S'], 'tshirt').value).toBe('S');
  });

  it('handles a single-player room without dividing by total player count', () => {
    expect(computeResult(['8'], 'fibonacci')).toEqual({
      value: '8',
      sub: 'average of 1 bet',
      allSame: true,
    });
  });
});

describe('isCurrentVote', () => {
  it('is false when there is no vote yet', () => {
    expect(isCurrentVote({ vote: null, round: 1 }, 1)).toBe(false);
  });
  it('is true when the vote was cast for the current round', () => {
    expect(isCurrentVote({ vote: '5', round: 2 }, 2)).toBe(true);
  });
  it('regression: a vote stamped with a past round is stale, not "voted"', () => {
    expect(isCurrentVote({ vote: '5', round: 1 }, 2)).toBe(false);
  });
  it('is false for a missing player', () => {
    expect(isCurrentVote(undefined, 1)).toBe(false);
  });
});

describe('resolveJoin', () => {
  it('treats an unknown pid with no collision as a new player', () => {
    expect(resolveJoin([], 'p1', 'Doc', 1000, 3)).toEqual({ kind: 'new-player', vote: null, round: 3, joinedAt: 1000 });
  });

  it('blocks a new player whose name collides with another pid', () => {
    const rows = [{ player_id: 'p2', name: 'Doc', vote: null, round: 1, joined_at: '2024-01-01T00:00:00Z' }];
    expect(resolveJoin(rows, 'p1', 'Doc')).toEqual({ kind: 'name-taken' });
  });

  it('name collision is case-insensitive', () => {
    const rows = [{ player_id: 'p2', name: 'doc', vote: null, round: 1, joined_at: '2024-01-01T00:00:00Z' }];
    expect(resolveJoin(rows, 'p1', 'Doc')).toEqual({ kind: 'name-taken' });
  });

  it('rejoin with the same name preserves vote/round/joinedAt and is never blocked', () => {
    const t = '2024-01-01T00:00:00Z';
    const rows = [{ player_id: 'p1', name: 'Doc', vote: '5', round: 2, joined_at: t }];
    expect(resolveJoin(rows, 'p1', 'Doc')).toEqual({
      kind: 'rejoin-same-name',
      vote: '5',
      round: 2,
      joinedAt: new Date(t).getTime(),
    });
  });

  it('rejoin with a new name preserves vote/round/joinedAt', () => {
    const t = '2024-01-01T00:00:00Z';
    const rows = [{ player_id: 'p1', name: 'Doc', vote: '5', round: 2, joined_at: t }];
    expect(resolveJoin(rows, 'p1', 'Doctor')).toEqual({
      kind: 'rejoin-renamed',
      vote: '5',
      round: 2,
      joinedAt: new Date(t).getTime(),
    });
  });

  it('regression: rejoin is never blocked by a same-name collision with another row', () => {
    const t = '2024-01-01T00:00:00Z';
    const rows = [
      { player_id: 'p1', name: 'Doc', vote: null, round: 1, joined_at: t },
      { player_id: 'p2', name: 'Doc', vote: null, round: 1, joined_at: t },
    ];
    const result = resolveJoin(rows, 'p1', 'Doc');
    expect(result.kind).toBe('rejoin-same-name');
  });

  it('preserves a null vote exactly on rejoin', () => {
    const t = '2024-01-01T00:00:00Z';
    const rows = [{ player_id: 'p1', name: 'Doc', vote: null, round: 1, joined_at: t }];
    expect(resolveJoin(rows, 'p1', 'Doc').vote).toBeNull();
  });
});

describe('votesToPlayers', () => {
  it('returns an empty map for no rows', () => {
    expect(votesToPlayers([])).toEqual({});
  });

  it('maps rows into a player_id-keyed object', () => {
    const rows = [{ player_id: 'p1', name: 'Doc', vote: '5', round: 2, joined_at: '2024-01-01T00:00:00Z' }];
    expect(votesToPlayers(rows)).toEqual({
      p1: { name: 'Doc', vote: '5', round: 2, joinedAt: new Date('2024-01-01T00:00:00Z').getTime() },
    });
  });
});

describe('getRoomFromUrl', () => {
  it('reads the legacy ?room= query param', () => {
    expect(getRoomFromUrl('?room=abc123', '')).toBe('ABC123');
  });
  it('reads the #hash room id', () => {
    expect(getRoomFromUrl('', '#xyz789')).toBe('XYZ789');
  });
  it('rejects a hash that is not 6 characters', () => {
    expect(getRoomFromUrl('', '#abc')).toBeNull();
  });
  it('returns null when neither is present', () => {
    expect(getRoomFromUrl('', '')).toBeNull();
  });
});

describe('makeRoomId', () => {
  it('is deterministic with an injected rng', () => {
    expect(makeRoomId(() => 0)).toBe('AAAAAA');
  });
  it('produces a 6-character id from the allowed alphabet by default', () => {
    expect(makeRoomId()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });
});
