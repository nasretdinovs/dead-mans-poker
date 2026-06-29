// The single stateful module: owns currentRoom/currentVotes/pid/etc and orchestrates
// db.js + realtime.js + render.js + state.js. No top-level side effects — everything (including
// reading pid from localStorage and parsing the URL) happens inside init().
import { DECKS } from './decks.js';
import * as db from './db.js';
import { subscribeRoom, unsubscribeRoom } from './realtime.js';
import { renderWaiting, renderGame } from './render.js';
import { showOnly, showError, showVoteError, copyLink, renderConnStatus } from './ui.js';
import { votesToPlayers, resolveJoin, getRoomFromUrl, makeRoomId } from './state.js';

let pid = null;
let urlRoom = null;

let currentRoom = null;
let currentRoomId = null;
let currentVotes = {}; // player_id -> { name, vote, round, joinedAt } — mirrored onto currentRoom.players
let realtimeChannel = null;
let votingLocked = false;
let lastAppliedUpdatedAt = null;

function inviteLink() {
  return location.origin + location.pathname + '#' + currentRoomId;
}

function renderAfterChange() {
  if (!currentRoom) return;
  if (currentRoom.started) showGameScreen();
  else renderWaitingScreen();
}

function renderWaitingScreen() {
  renderWaiting({ room: currentRoom, currentRoomId, pid, inviteLink: inviteLink() });
}

function showGameScreen() {
  showOnly('screen-game');
  renderGameScreen();
}

function renderGameScreen() {
  renderGame({ room: currentRoom, currentRoomId, pid, locked: votingLocked }, {
    onVote: doVote,
    onReveal: doReveal,
    onNewRound: doNewRound,
  });
}

// Supabase Realtime does not replay missed events after a dropped/reconnected websocket — any
// database change that happened while the connection was down (or even briefly stalled, per the
// real connection resets seen in production HAR captures) is simply never delivered, leaving
// this client permanently stuck on stale state with no further events to correct it. Re-fetching
// the authoritative room+votes rows every time the channel reports SUBSCRIBED (which fires on
// every successful reconnect, not just the first) closes that gap: whatever was missed during the
// outage gets picked up in one direct read the moment the connection is healthy again.
async function resyncRoom() {
  const id = currentRoomId;
  if (!id) return;
  const room = await db.loadRoom(id);
  if (currentRoomId !== id) return; // left/switched rooms while this was in flight
  if (!room) { goLobby(); return; }
  const votesRows = await db.loadVotes(id);
  if (currentRoomId !== id) return;
  currentVotes = votesToPlayers(votesRows);
  if (!currentVotes[pid]) { goLobby(); return; }
  currentRoom = room;
  currentRoom.players = currentVotes;
  lastAppliedUpdatedAt = null;
  renderAfterChange();
}

function subscribeToRoom(id) {
  if (realtimeChannel) { unsubscribeRoom(realtimeChannel); realtimeChannel = null; }
  lastAppliedUpdatedAt = null;
  // createRoom()/joinRoom() already did their own fresh loadRoom()/loadVotes() right before
  // calling this, so the FIRST SUBSCRIBED would just repeat that work — wasteful, and doubles the
  // number of REST calls competing for an already-flaky connection at exactly the moment (initial
  // join) when that's most likely to hurt. Only resync from the second SUBSCRIBED onward, i.e. on
  // an actual reconnect after a drop.
  let isReconnect = false;
  realtimeChannel = subscribeRoom(id, {
    onStatusChange: (status, err) => {
      console.log('[realtime]', new Date().toISOString(), 'room:' + id, status, err || '');
      renderConnStatus(status);
      if (status === 'SUBSCRIBED') {
        if (isReconnect) resyncRoom();
        isReconnect = true;
      }
    },
    onRoomDeleted: () => {
      console.log('[realtime:event]', new Date().toISOString(), 'rooms DELETE');
      goLobby();
    },
    onRoomChange: (roomState, updatedAt) => {
      console.log('[realtime:event]', new Date().toISOString(), 'rooms', roomState, 'updatedAt:', updatedAt);
      if (lastAppliedUpdatedAt && updatedAt && updatedAt <= lastAppliedUpdatedAt) return;
      lastAppliedUpdatedAt = updatedAt || lastAppliedUpdatedAt;
      if (!currentRoom) return;
      Object.assign(currentRoom, roomState);
      currentRoom.players = currentVotes;
      renderAfterChange();
    },
    onVoteUpsert: (row) => {
      console.log('[realtime:event]', new Date().toISOString(), 'votes upsert', row);
      currentVotes[row.player_id] = { name: row.name, vote: row.vote, round: row.round, joinedAt: new Date(row.joined_at).getTime() };
      if (!currentRoom) return;
      currentRoom.players = currentVotes;
      if (!currentVotes[pid]) { goLobby(); return; }
      renderAfterChange();
    },
    onVoteDelete: (playerId) => {
      console.log('[realtime:event]', new Date().toISOString(), 'votes delete', playerId);
      delete currentVotes[playerId];
      if (!currentRoom) return;
      currentRoom.players = currentVotes;
      if (!currentVotes[pid]) { goLobby(); return; }
      renderAfterChange();
    },
  });
}

function goLobby() {
  if (realtimeChannel) { unsubscribeRoom(realtimeChannel); realtimeChannel = null; }
  currentRoom = null; currentRoomId = null; currentVotes = {};
  try {
    history.replaceState({}, '', location.pathname + location.search.replace(/[?&]room=[^&]*/, ''));
    location.hash = '';
  } catch (e) {}
  showOnly('screen-lobby');
}

// ── Lobby ──────────────────────────────────────────────────────────────
function initLobby() {
  const deckSel = document.getElementById('lobby-deck');
  const pillsEl = document.getElementById('lobby-pills');

  function updatePills() {
    const cards = DECKS[deckSel.value] || [];
    pillsEl.innerHTML = cards.map(c => `<span class="deck-pill">${c}</span>`).join('');
  }
  updatePills();
  deckSel.addEventListener('change', updatePills);

  document.getElementById('lobby-name').addEventListener('keydown', e => { if (e.key === 'Enter') createRoom(); });
  document.getElementById('lobby-create-btn').addEventListener('click', createRoom);
}

async function createRoom() {
  const nameEl = document.getElementById('lobby-name');
  const errEl = document.getElementById('lobby-error');
  const name = nameEl.value.trim();
  if (!name) { showError(errEl, 'Enter your name, stranger.'); return; }

  const btn = document.getElementById('lobby-create-btn');
  btn.textContent = 'Shuffling cards…'; btn.disabled = true;
  errEl.style.display = 'none';

  const id = makeRoomId();
  const deckType = document.getElementById('lobby-deck').value;
  const room = { deckType, cards: DECKS[deckType], revealed: false, round: 1, started: false };

  await db.saveRoom(id, room);
  const inserted = await db.insertVoteRow(id, pid, name, room.round);
  if (!inserted) {
    showError(errEl, 'Could not seat you at the table — check your connection and try again.');
    btn.textContent = 'Create Room'; btn.disabled = false;
    return;
  }
  try { location.hash = id; } catch (e) {}

  currentRoomId = id;
  currentVotes = { [pid]: { name, vote: null, round: room.round, joinedAt: Date.now() } };
  currentRoom = room;
  currentRoom.players = currentVotes;
  subscribeToRoom(id);
  renderWaitingScreen();

  btn.textContent = 'Create Room'; btn.disabled = false;
}

// ── Join ────────────────────────────────────────────────────────────────
function initJoin() {
  if (!urlRoom) return;
  document.getElementById('join-room-id').textContent = urlRoom;
  document.getElementById('join-name').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  document.getElementById('join-btn').addEventListener('click', joinRoom);
  showOnly('screen-join');
}

async function joinRoom() {
  const nameEl = document.getElementById('join-name');
  const errEl = document.getElementById('join-error');
  const name = nameEl.value.trim();
  if (!name) { showError(errEl, 'Enter your name, stranger.'); return; }

  const btn = document.getElementById('join-btn');
  btn.textContent = 'Entering saloon…'; btn.disabled = true;
  errEl.style.display = 'none';

  const room = await db.loadRoom(urlRoom);
  if (!room) {
    showError(errEl, 'No such table in this town, partner.');
    btn.textContent = 'Join the Table'; btn.disabled = false;
    return;
  }

  const votesRows = await db.loadVotes(urlRoom);
  const decision = resolveJoin(votesRows, pid, name, Date.now(), room.round);

  if (decision.kind === 'name-taken') {
    showError(errEl, 'That name is already at the table.');
    btn.textContent = 'Join the Table'; btn.disabled = false;
    return;
  }
  if (decision.kind === 'new-player') {
    const ok = await db.insertVoteRow(urlRoom, pid, name, room.round);
    if (!ok) {
      showError(errEl, 'Could not seat you at the table — check your connection and try again.');
      btn.textContent = 'Join the Table'; btn.disabled = false;
      return;
    }
  } else if (decision.kind === 'rejoin-renamed') {
    const ok = await db.renameVoteRow(urlRoom, pid, name);
    if (!ok) {
      showError(errEl, 'Could not update your name — check your connection and try again.');
      btn.textContent = 'Join the Table'; btn.disabled = false;
      return;
    }
  }
  // decision.kind === 'rejoin-same-name': nothing to write, name already matches

  currentVotes = votesToPlayers(votesRows);
  currentVotes[pid] = { name, vote: decision.vote, round: decision.round, joinedAt: decision.joinedAt };

  currentRoomId = urlRoom;
  currentRoom = room;
  currentRoom.players = currentVotes;
  subscribeToRoom(urlRoom);

  if (room.started) showGameScreen();
  else renderWaitingScreen();
  btn.textContent = 'Join the Table'; btn.disabled = false;
}

// ── Waiting ─────────────────────────────────────────────────────────────
function initWaitingButtons() {
  document.getElementById('waiting-copy-btn').addEventListener('click', () => copyLink('waiting-copy-btn', inviteLink()));
  document.getElementById('waiting-start-btn').addEventListener('click', async () => {
    const btn = document.getElementById('waiting-start-btn');
    btn.disabled = true; btn.textContent = 'Starting…';
    const state = await db.startGame(currentRoomId);
    if (state) {
      Object.assign(currentRoom, state);
      currentRoom.players = currentVotes;
      showGameScreen();
    } else {
      showVoteError('Could not start the game — try again in a moment.');
    }
    btn.disabled = false; btn.textContent = 'Start the Game';
  });
  document.getElementById('waiting-leave-btn').addEventListener('click', leaveRoom);
}

// ── Game ────────────────────────────────────────────────────────────────
function initGameButtons() {
  document.getElementById('game-copy-btn').addEventListener('click', () => copyLink('game-copy-btn', inviteLink()));
  document.getElementById('game-leave-btn').addEventListener('click', leaveRoom);
}

// ── Actions ─────────────────────────────────────────────────────────────
async function doVote(card) {
  if (!currentRoom || currentRoom.revealed) return;
  const me = currentRoom.players[pid];
  if (!me) return;

  // A vote from a past round reads as "no vote" (see isCurrentVote in state.js) — compare against
  // that, not the raw stored value, so re-clicking a stale card is treated as a fresh pick.
  const currentVote = me.round === currentRoom.round ? me.vote : null;
  if (currentVote === card) return;

  const snapshot = { ...me };
  me.vote = card;
  me.round = currentRoom.round;
  renderGameScreen();

  const ok = await db.setVote(currentRoomId, pid, card);

  if (!ok) {
    currentRoom.players[pid] = snapshot;
    showVoteError('Your bet did not land — try again, partner.');
    renderGameScreen();
  }
}

// Reveal/New Round affect the WHOLE table's shared state, not just the clicker's own view — so
// unlike doVote(), there is no optimistic local mutation here. The button shows a local "saving"
// state, but currentRoom.revealed/round only ever change once the atomic RPC (see db.js/
// supabase_setup.sql) confirms what the server actually applied, same as a realtime event from
// another player's click would. That keeps every connected client converged on one truth instead
// of briefly diverging on a local guess while a slow/flaky network catches up.
async function doReveal() {
  if (votingLocked) {
    console.warn('[action] doReveal ignored — previous action still saving');
    showVoteError('Still saving the last action — try again in a moment.');
    return;
  }
  votingLocked = true;
  renderGameScreen();
  try {
    const state = await db.revealRound(currentRoomId);
    if (state) {
      Object.assign(currentRoom, state);
      currentRoom.players = currentVotes;
    } else {
      showVoteError('Could not reveal the cards — try again, partner.');
    }
  } catch (e) { console.error('doReveal failed:', e); showVoteError('Could not reveal the cards — try again, partner.'); }
  finally { votingLocked = false; renderGameScreen(); }
}

async function doNewRound() {
  if (votingLocked) {
    console.warn('[action] doNewRound ignored — previous action still saving');
    showVoteError('Still saving the last action — try again in a moment.');
    return;
  }
  votingLocked = true;
  renderGameScreen();
  try {
    const expectedRound = currentRoom.round || 1;
    const state = await db.newRound(currentRoomId, expectedRound);
    if (state) {
      Object.assign(currentRoom, state);
      currentRoom.players = currentVotes;
    } else {
      showVoteError('Could not start a new round — try again, partner.');
    }
  } catch (e) { console.error('doNewRound failed:', e); showVoteError('Could not start a new round — try again, partner.'); }
  finally { votingLocked = false; renderGameScreen(); }
}

async function leaveRoom() {
  const id = currentRoomId;
  if (id) {
    await db.deleteVoteRow(id, pid);
    const remaining = await db.loadVotes(id);
    if (remaining.length === 0) await db.deleteRoom(id);
  }
  goLobby();
}

// ── Init ─────────────────────────────────────────────────────────────────
export function init() {
  pid = localStorage.getItem('dmp_pid');
  if (!pid) {
    pid = 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('dmp_pid', pid);
  }
  sessionStorage.setItem('dmp_pid', pid);

  urlRoom = getRoomFromUrl(location.search, location.hash);

  initLobby();
  initWaitingButtons();
  initGameButtons();

  if (urlRoom) {
    initJoin();
  } else {
    showOnly('screen-lobby');
  }
}
