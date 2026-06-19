// The single stateful module: owns currentRoom/currentVotes/pid/etc and orchestrates
// db.js + realtime.js + render.js + state.js. No top-level side effects — everything (including
// reading pid from localStorage and parsing the URL) happens inside init().
import { DECKS } from './decks.js';
import * as db from './db.js';
import { subscribeRoom, unsubscribeRoom } from './realtime.js';
import { renderWaiting, renderGame } from './render.js';
import { showOnly, showError, showVoteError, copyLink, renderConnStatus } from './ui.js';
import { votesToPlayers, resolveJoin, decideRoundReset, getRoomFromUrl, makeRoomId } from './state.js';

let pid = null;
let urlRoom = null;

let currentRoom = null;
let currentRoomId = null;
let currentVotes = {}; // player_id -> { name, vote, joinedAt } — mirrored onto currentRoom.players
let realtimeChannel = null;
let votingLocked = false;
let lastSeenRound = null;
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
  renderGame({ room: currentRoom, currentRoomId, pid }, {
    onVote: doVote,
    onReveal: doReveal,
    onNewRound: doNewRound,
  });
}

// Each player resets only THEIR OWN vote row when they notice the round changed — never another
// player's row. A shared "clear all votes" write would race with anyone voting for the new round
// while that write is still in flight, silently wiping their fresh vote.
function maybeResetOwnVoteForNewRound(newRound) {
  const { shouldReset, nextLastSeenRound } = decideRoundReset(lastSeenRound, newRound);
  if (shouldReset && currentVotes[pid]) {
    currentVotes[pid].vote = null;
    db.setVote(currentRoomId, pid, null);
  }
  lastSeenRound = nextLastSeenRound;
}

function subscribeToRoom(id) {
  if (realtimeChannel) { unsubscribeRoom(realtimeChannel); realtimeChannel = null; }
  lastAppliedUpdatedAt = null;
  realtimeChannel = subscribeRoom(id, {
    onStatusChange: (status, err) => {
      console.log('[realtime]', new Date().toISOString(), 'room:' + id, status, err || '');
      renderConnStatus(status);
    },
    onRoomDeleted: goLobby,
    onRoomChange: (roomState, updatedAt) => {
      if (lastAppliedUpdatedAt && updatedAt && updatedAt <= lastAppliedUpdatedAt) return;
      lastAppliedUpdatedAt = updatedAt || lastAppliedUpdatedAt;
      if (!currentRoom) return;
      Object.assign(currentRoom, roomState);
      currentRoom.players = currentVotes;
      maybeResetOwnVoteForNewRound(currentRoom.round);
      renderAfterChange();
    },
    onVoteUpsert: (row) => {
      currentVotes[row.player_id] = { name: row.name, vote: row.vote, joinedAt: new Date(row.joined_at).getTime() };
      if (!currentRoom) return;
      currentRoom.players = currentVotes;
      if (!currentVotes[pid]) { goLobby(); return; }
      renderAfterChange();
    },
    onVoteDelete: (playerId) => {
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
  currentRoom = null; currentRoomId = null; currentVotes = {}; lastSeenRound = null;
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
  await db.insertVoteRow(id, pid, name);
  try { location.hash = id; } catch (e) {}

  currentRoomId = id;
  currentVotes = { [pid]: { name, vote: null, joinedAt: Date.now() } };
  currentRoom = room;
  currentRoom.players = currentVotes;
  lastSeenRound = currentRoom.round;
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
  const decision = resolveJoin(votesRows, pid, name);

  if (decision.kind === 'name-taken') {
    showError(errEl, 'That name is already at the table.');
    btn.textContent = 'Join the Table'; btn.disabled = false;
    return;
  }
  if (decision.kind === 'new-player') {
    await db.insertVoteRow(urlRoom, pid, name);
  } else if (decision.kind === 'rejoin-renamed') {
    await db.renameVoteRow(urlRoom, pid, name);
  }
  // decision.kind === 'rejoin-same-name': nothing to write, name already matches

  currentVotes = votesToPlayers(votesRows);
  currentVotes[pid] = { name, vote: decision.vote, joinedAt: decision.joinedAt };

  currentRoomId = urlRoom;
  currentRoom = room;
  currentRoom.players = currentVotes;
  lastSeenRound = currentRoom.round;
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
    const room = await db.updateRoom(currentRoomId, r => { r.started = true; });
    if (room) {
      currentRoom = room;
      currentRoom.players = currentVotes;
      showGameScreen();
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
  if (!currentRoom.players[pid]) return;

  const previousVote = currentRoom.players[pid].vote;
  if (previousVote === card) return;

  currentRoom.players[pid].vote = card;
  renderGameScreen();

  const ok = await db.setVote(currentRoomId, pid, card);

  if (!ok) {
    if (currentRoom && currentRoom.players[pid]) {
      currentRoom.players[pid].vote = previousVote;
    }
    showVoteError('Your bet did not land — try again, partner.');
    renderGameScreen();
  }
}

async function doReveal() {
  if (votingLocked) return;
  votingLocked = true;
  currentRoom.revealed = true;
  renderGameScreen();
  try {
    await db.updateRoom(currentRoomId, r => { r.revealed = true; });
  } catch (e) { console.error('doReveal failed:', e); }
  finally { votingLocked = false; }
}

async function doNewRound() {
  if (votingLocked) return;
  votingLocked = true;
  currentRoom.revealed = false;
  currentRoom.round = (currentRoom.round || 1) + 1;
  maybeResetOwnVoteForNewRound(currentRoom.round);
  renderGameScreen();
  try {
    const round = currentRoom.round;
    await db.updateRoom(currentRoomId, r => {
      r.revealed = false;
      r.round = round;
    });
  } catch (e) { console.error('doNewRound failed:', e); }
  finally { votingLocked = false; }
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
