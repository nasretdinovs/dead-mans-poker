// Stateless DOM/UX helpers — screen switching, toasts, copy-link feedback. No app state here;
// callers pass in whatever data they need (e.g. the link to copy) rather than this module
// reaching into currentRoom/currentRoomId itself.

const SCREENS = ['screen-lobby', 'screen-join', 'screen-waiting', 'screen-game'];

export function showOnly(id) {
  SCREENS.forEach(s => {
    document.getElementById(s).style.display = s === id ? '' : 'none';
  });
}

export function showError(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}

export function showVoteError(msg) {
  let el = document.getElementById('vote-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'vote-toast';
    el.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#3a1010;color:#e8d5a3;border:1px solid rgba(180,130,60,.4);border-radius:6px;padding:10px 18px;font-family:Cormorant Garamond,serif;font-size:15px;z-index:999;box-shadow:0 8px 24px rgba(0,0,0,.6)';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

const CONN_STATUS_TEXT = {
  SUBSCRIBED: '● live',
  TIMED_OUT: '● lost connection — retrying',
  CLOSED: '● lost connection — retrying',
  CHANNEL_ERROR: '● lost connection — retrying',
};

// Reflects the realtime channel's connection status in both small debug-style spans
// (game bar + waiting screen) so a stuck/erroring channel is visible instead of silently
// looking like "nothing is happening".
export function renderConnStatus(status) {
  const text = CONN_STATUS_TEXT[status] || '● connecting…';
  ['game-conn-status', 'waiting-conn-status'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  });
}

let copiedTimer = null;
export async function copyLink(btnId, link) {
  try { await navigator.clipboard.writeText(link); } catch (e) {}
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = 'Copied!';
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { if (btn) btn.textContent = orig; }, 1600);
}
