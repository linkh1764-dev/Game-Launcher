if (!window.overlayApi) {
  document.getElementById('game').textContent = 'Overlay failed to load';
  document.getElementById('total').textContent = 'Check that overlay-preload.js is in the app folder with exactly that name.';
  throw new Error('overlayApi is missing: overlay-preload.js did not load');
}

let state = { gameId: null, gameName: null, startedAt: null, playSeconds: 0, notes: '', hotkey: '' };
const notesEl = document.getElementById('notes');
let saveTimer = null;

const pad = (n) => String(n).padStart(2, '0');

function tick() {
  document.getElementById('game').textContent = state.gameName || 'No game running';
  document.getElementById('hint').textContent = state.hotkey ? `${state.hotkey} to hide` : '';
  document.getElementById('clock').textContent = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });

  let elapsed = 0;
  if (state.startedAt) elapsed = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  document.getElementById('timer').textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;

  // Total play time: what the library has saved plus the current session.
  const total = (state.playSeconds || 0) + elapsed;
  const totalMins = Math.floor(total / 60);
  let totalText;
  if (totalMins < 1) totalText = 'Less than a minute played in total';
  else if (totalMins < 60) totalText = `${totalMins} min played in total`;
  else totalText = `${(total / 3600).toFixed(1)} hours played in total`;
  document.getElementById('total').textContent = totalText;
}

// ---- Notes (saved per game) ----
function flushNotes() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (state.gameId) window.overlayApi.saveNotes(state.gameId, notesEl.value);
}

notesEl.addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushNotes, 600);
});
notesEl.addEventListener('blur', () => {
  if (saveTimer) flushNotes();
});

function applyState(next) {
  if (saveTimer) flushNotes(); // save anything typed for the previous game first
  const switched = next.gameId !== state.gameId;
  state = next;
  notesEl.disabled = !state.gameId;
  // Don't overwrite what the player is typing right now.
  if (switched || document.activeElement !== notesEl) notesEl.value = state.notes || '';
  tick();
}

window.overlayApi.onState(applyState);
window.overlayApi.getState().then(applyState);
setInterval(tick, 500);

document.getElementById('browserBtn').addEventListener('click', () => window.overlayApi.openBrowser());

window.overlayApi.getTheme().then(Theme.apply);
window.overlayApi.onTheme(Theme.apply);