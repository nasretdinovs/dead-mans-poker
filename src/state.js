// Pure logic only — no DOM access, no network calls, no global `location`/`localStorage`.
// Anything that needs "now" or randomness takes it as an injectable parameter so it stays testable.

const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function votesToPlayers(rows) {
  const players = {};
  rows.forEach(r => {
    players[r.player_id] = { name: r.name, vote: r.vote, joinedAt: new Date(r.joined_at).getTime() };
  });
  return players;
}

export function toNumericVote(v) {
  if (v === '½') return 0.5;
  return /^[0-9]+(\.[0-9]+)?$/.test(v) ? Number(v) : null;
}

// votes: Array<string|null> — may include unvoted (null) entries, filtered out here.
export function computeResult(votes, deckType) {
  const nonNullVotes = (votes || []).filter(v => v != null);
  if (!nonNullVotes.length) return { value: '—', sub: 'no bets', allSame: false };

  const allSame = nonNullVotes.every(v => v === nonNullVotes[0]);
  const nums = nonNullVotes.map(toNumericVote).filter(n => n != null);

  // Note: `sub` always counts every non-null vote (including non-numeric ones like '?'),
  // while the numeric average only divides by the subset that parsed as numbers. These two
  // counts can differ on a numeric deck with a '?' vote mixed in — that's existing, intended
  // behavior, not a bug, and is locked in by a regression test.
  if (deckType !== 'tshirt' && nums.length) {
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    const rounded = Math.round(avg * 10) / 10;
    return {
      value: String(rounded),
      sub: 'average of ' + nonNullVotes.length + ' bet' + (nonNullVotes.length === 1 ? '' : 's'),
      allSame,
    };
  }

  const freq = {};
  nonNullVotes.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
  let best = nonNullVotes[0];
  let bestCount = 0;
  for (const k in freq) {
    if (freq[k] > bestCount) { bestCount = freq[k]; best = k; }
  }
  return { value: best, sub: 'most common of ' + nonNullVotes.length + ' bets', allSame };
}

// Pure decision half of "reset my vote when the round changes". The caller is responsible for
// the side effects (mutating currentVotes[pid] and calling the setVote RPC) — see app.js.
export function decideRoundReset(lastSeenRound, newRound) {
  const shouldReset = lastSeenRound !== null && newRound !== lastSeenRound;
  return { shouldReset, nextLastSeenRound: newRound };
}

// votesRows: Array<{ player_id, name, vote, joined_at }>
export function resolveJoin(votesRows, pid, name, now = Date.now()) {
  const existing = votesRows.find(r => r.player_id === pid);

  if (!existing) {
    const taken = votesRows.some(r => r.player_id !== pid && r.name.toLowerCase() === name.toLowerCase());
    if (taken) return { kind: 'name-taken' };
    return { kind: 'new-player', vote: null, joinedAt: now };
  }

  const joinedAt = new Date(existing.joined_at).getTime();
  return existing.name === name
    ? { kind: 'rejoin-same-name', vote: existing.vote, joinedAt }
    : { kind: 'rejoin-renamed', vote: existing.vote, joinedAt };
}

export function getRoomFromUrl(search, hash) {
  const qp = new URLSearchParams(search).get('room');
  if (qp) return qp.toUpperCase();
  const h = (hash || '').replace('#', '');
  if (h && h.length === 6) return h.toUpperCase();
  return null;
}

export function makeRoomId(rng = Math.random) {
  let id = '';
  for (let i = 0; i < 6; i++) id += ROOM_ID_CHARS[Math.floor(rng() * ROOM_ID_CHARS.length)];
  return id;
}

export function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
