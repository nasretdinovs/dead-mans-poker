// DOM-producing functions only. Same responsibilities as the original renderWaiting/renderGame —
// still fully tears down and rebuilds seats/hand-card DOM on every call (cosmetic jank, not
// breakage; deferred to a future diffing pass per CLAUDE.md's open issues).
import { computeSeatPositions } from './seats.js';
import { computeResult, escHtml } from './state.js';
import { showOnly } from './ui.js';

function initials(name) {
  return (name || '?').trim().split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase() || '?';
}

export function renderWaiting({ room, currentRoomId, pid, inviteLink }) {
  showOnly('screen-waiting');
  if (!room) return;

  document.getElementById('waiting-room-id').textContent = 'TABLE ' + currentRoomId;

  const players = Object.entries(room.players).sort((a, b) => a[1].joinedAt - b[1].joinedAt);
  const grid = document.getElementById('waiting-players');
  grid.innerHTML = players
    .map(([id, p]) => {
      const me = id === pid;
      return `<div class="player-chip">
      <div class="avatar ${me ? 'avatar-me' : 'avatar-other'}">${initials(p.name)}</div>
      <div class="name-tag ${me ? 'name-tag-me' : ''}">${escHtml(p.name)}${me ? ' (you)' : ''}</div>
    </div>`;
    })
    .join('');

  document.getElementById('waiting-invite-input').value = inviteLink;
}

export function renderGame({ room, currentRoomId, pid }, { onVote, onReveal, onNewRound }) {
  if (!room) return;

  const players = Object.entries(room.players).sort((a, b) => a[1].joinedAt - b[1].joinedAt);
  const total = players.length;
  const votedCount = players.filter(([, p]) => p.vote != null).length;
  const allVoted = total > 0 && votedCount === total;
  const revealed = !!room.revealed;
  const myVote = room.players[pid] ? room.players[pid].vote : null;

  // bar
  document.getElementById('game-round').textContent = 'Round ' + (room.round || 1);
  const pidDebug = document.getElementById('game-pid-debug');
  if (pidDebug) {
    const myEntry = room.players[pid];
    pidDebug.textContent = myEntry ? 'me: ' + myEntry.name : 'pid missing! ' + pid.slice(-6);
  }
  document.getElementById('game-table-id').textContent = 'Table ' + currentRoomId;
  document.getElementById('game-votes-count').textContent = votedCount + '/' + total + ' Bets';

  // seats
  const wrap = document.getElementById('game-table-wrap');
  wrap.querySelectorAll('.seat').forEach(s => s.remove());

  const positions = computeSeatPositions(players.map(([id]) => id), pid);
  players.forEach(([id, p], i) => {
    const { x, y } = positions[i];
    const me = id === pid;
    const voted = p.vote != null;

    let slotHtml;
    if (!voted) {
      slotHtml = `<div class="seat-slot seat-slot-empty"></div>`;
    } else {
      const flippedClass = revealed ? ' flipped' : '';
      const numSize = p.vote && p.vote.length > 2 ? '13px' : '20px';
      slotHtml = `<div class="card-wrap">
        <div class="card-inner${flippedClass}">
          <div class="card-back"></div>
          <div class="card-face">
            <span class="card-face-orn">✦</span>
            <span class="card-face-num" style="font-size:${numSize}">${escHtml(p.vote)}</span>
            <span class="card-face-orn">✦</span>
          </div>
        </div>
      </div>`;
    }

    const seat = document.createElement('div');
    seat.className = 'seat';
    seat.style.cssText = `left:${x}px;top:${y}px`;
    seat.innerHTML = `${slotHtml}
      <div class="avatar ${me ? 'avatar-me' : 'avatar-other'}${voted ? ' avatar-voted' : ''}">${initials(p.name)}</div>
      <div class="name-tag ${me ? 'name-tag-me' : ''}">${escHtml(p.name)}${me ? ' (you)' : ''}</div>`;
    wrap.appendChild(seat);
  });

  // center
  const center = document.getElementById('game-table-center');
  if (revealed) {
    const res = computeResult(players.map(([, p]) => p.vote), room.deckType);
    const nums = (room.cards || [])
      .map(c => (c === '½' ? 0.5 : /^[0-9]+(\.[0-9]+)?$/.test(c) ? Number(c) : null))
      .filter(n => n != null);
    const val = Number(res.value);
    let rangeHtml = '';
    if (room.deckType !== 'tshirt' && nums.length >= 2 && !isNaN(val)) {
      const mn = Math.min(...nums), mx = Math.max(...nums);
      const pct = Math.max(0, Math.min(1, (val - mn) / (mx - mn)));
      rangeHtml = `<div class="range-bar">
        <div class="range-track"><div class="range-dot" style="left:${(pct * 100).toFixed(1)}%"></div></div>
        <div class="range-labels"><span>${mn === 0.5 ? '½' : mn}</span><span>${mx}</span></div>
      </div>`;
    }
    center.innerHTML = `<div class="verdict-box">
      <div class="verdict-label">The Verdict</div>
      <div class="verdict-value">${escHtml(res.value)}</div>
      ${res.allSame ? '<div class="verdict-unanimous">✦ Unanimous ✦</div>' : ''}
      <div class="verdict-sub">${escHtml(res.sub)}</div>
      ${rangeHtml}
      <button class="btn btn-gold" style="margin-top:14px" id="game-newround-btn">New Round</button>
    </div>`;
    document.getElementById('game-newround-btn').addEventListener('click', onNewRound);
  } else if (allVoted) {
    center.innerHTML = `<button class="reveal-btn" id="game-reveal-btn">Reveal Cards</button>`;
    document.getElementById('game-reveal-btn').addEventListener('click', onReveal);
  } else {
    center.innerHTML = `<div class="waiting-box">
      <div class="waiting-title">Awaiting Bets</div>
      <div class="waiting-sub">${votedCount} of ${total} have placed</div>
    </div>`;
  }

  // hand
  const cards = room.cards || [];
  const handWrap = document.getElementById('game-hand-wrap');
  handWrap.innerHTML = '';
  handWrap.className = 'hand-wrap' + (revealed ? ' hand-revealed' : '');

  const m = cards.length;
  const c = (m - 1) / 2;
  cards.forEach((card, j) => {
    const off = j - c;
    const isSelected = myVote === card;
    const rot = off * 3.2;
    const baseY = Math.abs(off) * 5;

    const div = document.createElement('div');
    div.className = 'hand-card' + (isSelected ? ' selected-card' : '');
    div.style.cssText = `transform:rotate(${rot}deg) translateY(${baseY}px);margin:0 -4px;z-index:${isSelected ? 51 : 10 + j}`;
    const numSize = card.length > 2 ? '18px' : '26px';
    div.innerHTML = `<div class="hand-card-inner">
      <span class="card-face-orn">✦</span>
      <span class="hand-card-num" style="font-size:${numSize}">${escHtml(card)}</span>
      <span class="card-face-orn">✦</span>
    </div>`;

    if (!revealed) {
      div.addEventListener('click', () => onVote(card));
    }
    handWrap.appendChild(div);
  });

  const caption = revealed
    ? 'Cards on the table'
    : myVote
      ? `Your bet: ${myVote} — tap another to change`
      : 'Your hand — choose your bet';
  document.getElementById('game-hand-caption').textContent = caption;
}
