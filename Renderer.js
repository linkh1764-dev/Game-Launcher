const $ = (id) => document.getElementById(id);
let games = [];
let runningIds = new Set();
let toastTimer;

const store = {
  get(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  }
};
let view = store.get('libraryView', 'grid'); // 'grid' or 'list'
let selectedId = store.get('selectedGame', null);
let detailShownId = null;
let notesTimer = null;

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4500);
}

function formatPlaytime(seconds) {
  if (!seconds) return 'Not played yet';
  const mins = Math.floor(seconds / 60);
  if (mins < 1) return 'Less than a minute played';
  if (mins < 60) return `${mins} min played`;
  return `${(seconds / 3600).toFixed(1)} hours played`;
}

function hueFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function render() {
  const query = $('search').value.trim().toLowerCase();
  const visible = games
    .filter((g) => g.name.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));

  $('empty').hidden = games.length > 0;
  $('grid').hidden = view !== 'grid' || games.length === 0;
  $('listView').hidden = view !== 'list' || games.length === 0;
  $('viewGrid').setAttribute('aria-pressed', String(view === 'grid'));
  $('viewList').setAttribute('aria-pressed', String(view === 'list'));
  if (view === 'list') {
    renderList(visible);
    return;
  }

  const grid = $('grid');
  grid.replaceChildren();

  for (const g of visible) {
    const live = runningIds.has(g.id);
    const card = document.createElement('article');
    card.className = 'card' + (live ? ' live' : '');

    const cover = document.createElement('button');
    cover.className = 'cover';
    cover.title = 'Change cover image';
    if (g.coverUrl) {
      cover.style.backgroundImage = `url("${g.coverUrl}")`;
      cover.style.backgroundSize = 'cover';
      cover.style.backgroundPosition = 'center';
    } else {
      const hue = hueFor(g.name);
      cover.style.background = `linear-gradient(160deg, hsl(${hue} 45% 38%), hsl(${(hue + 40) % 360} 50% 22%))`;
      cover.textContent = g.name.trim().charAt(0).toUpperCase() || '?';
    }
    cover.addEventListener('click', () => changeCover(g.id));

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = g.name;
    name.title = g.name;
    const meta = document.createElement('div');
    meta.className = 'meta status';
    meta.textContent = live ? 'Running' : formatPlaytime(g.playSeconds);

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const play = document.createElement('button');
    play.className = 'primary play';
    play.textContent = live ? 'Running' : 'Play';
    play.disabled = live;
    play.addEventListener('click', () => launch(g.id));
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = 'Remove';
    remove.title = 'Remove from library (does not delete the game)';
    remove.addEventListener('click', () => removeGame(g));
    actions.append(play, remove);

    info.append(name, meta, actions);
    card.append(cover, info);
    grid.append(card);
  }
}

// ---- List layout ----
function formatPlaytimeLong(seconds) {
  if (!seconds) return 'Not played yet';
  const mins = Math.floor(seconds / 60);
  if (mins < 1) return 'Less than a minute';
  if (mins < 60) return `${mins} minutes`;
  return `${(seconds / 3600).toFixed(1)} hours`;
}

function formatLastPlayed(iso) {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function applyArt(el, game, withLetter) {
  el.style.background = '';
  el.style.backgroundImage = '';
  el.style.backgroundSize = '';
  el.style.backgroundPosition = '';
  if (game.coverUrl) {
    el.style.backgroundImage = `url("${game.coverUrl}")`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.textContent = '';
  } else {
    const hue = hueFor(game.name);
    el.style.background = `linear-gradient(160deg, hsl(${hue} 45% 38%), hsl(${(hue + 40) % 360} 50% 22%))`;
    el.textContent = withLetter ? game.name.trim().charAt(0).toUpperCase() || '?' : '';
  }
}

function selectGame(id) {
  flushDetailNotes(); // save anything typed for the previous game first
  selectedId = id;
  store.set('selectedGame', id);
  render();
}

function renderList(visible) {
  const list = $('gameList');
  list.replaceChildren();
  if (!games.some((g) => g.id === selectedId)) selectedId = games.length ? (visible[0] || games[0]).id : null;

  for (const g of visible) {
    const item = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'list-item' + (g.id === selectedId ? ' selected' : '');
    btn.setAttribute('aria-current', String(g.id === selectedId));

    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    applyArt(thumb, g, true);
    const name = document.createElement('span');
    name.className = 'list-name';
    name.textContent = g.name;
    const status = document.createElement('span');
    status.className = 'list-status';
    status.textContent = runningIds.has(g.id) ? 'Running' : '';

    btn.append(thumb, name, status);
    btn.addEventListener('click', () => selectGame(g.id));
    item.append(btn);
    list.append(item);
  }
  updateDetail();
}

function updateDetail() {
  const g = games.find((x) => x.id === selectedId);
  $('detail').hidden = !g;
  if (!g) {
    detailShownId = null;
    return;
  }
  const live = runningIds.has(g.id);
  applyArt($('banner'), g, true);
  $('detailName').textContent = g.name;
  $('detailPlay').textContent = live ? 'Running' : 'Play';
  $('detailPlay').disabled = live;
  $('statPlaytime').textContent = formatPlaytimeLong(g.playSeconds);
  $('statLast').textContent = formatLastPlayed(g.lastPlayed);

  // Don't overwrite what the player is typing right now.
  const notes = $('detailNotes');
  if (detailShownId !== g.id) $('notesSaved').textContent = '';
  if (detailShownId !== g.id || document.activeElement !== notes) notes.value = g.notes || '';
  detailShownId = g.id;
}

function flushDetailNotes() {
  clearTimeout(notesTimer);
  notesTimer = null;
  if (!detailShownId) return;
  const id = detailShownId;
  const text = $('detailNotes').value;
  const g = games.find((x) => x.id === id);
  if (g) g.notes = text;
  window.launcher.saveNotes(id, text).then((ok) => {
    if (ok && id === detailShownId) $('notesSaved').textContent = 'Saved';
  });
}

function setView(next) {
  flushDetailNotes();
  view = next;
  store.set('libraryView', next);
  render();
}

async function changeCover(id) {
  const result = await window.launcher.setCover(id);
  if (result.ok) {
    games = result.games;
    render();
  } else if (!result.canceled) {
    toast(result.error);
  }
}

async function launch(id) {
  const result = await window.launcher.launchGame(id);
  if (!result.ok) toast(result.error);
}

async function removeGame(game) {
  if (!confirm(`Remove "${game.name}" from your library? The game itself won't be deleted.`)) return;
  games = await window.launcher.removeGame(game.id);
  render();
}

// ---- Add game dialog ----
function openAddDialog() {
  $('pathInput').value = '';
  $('nameInput').value = '';
  $('addDialog').showModal();
}

function guessName(filePath) {
  const base = filePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  return base.replace(/[_-]+/g, ' ').trim();
}

$('addBtn').addEventListener('click', openAddDialog);
$('emptyAdd').addEventListener('click', openAddDialog);
$('cancelBtn').addEventListener('click', () => $('addDialog').close());

$('browseBtn').addEventListener('click', async () => {
  const file = await window.launcher.pickExecutable();
  if (!file) return;
  $('pathInput').value = file;
  if (!$('nameInput').value) $('nameInput').value = guessName(file);
});

$('addForm').addEventListener('submit', async (e) => {
  const exePath = $('pathInput').value;
  const name = $('nameInput').value.trim();
  if (!exePath || !name) {
    e.preventDefault();
    toast('Choose a game file and enter a name.');
    return;
  }
  games = await window.launcher.addGame(name, exePath);
  render();
});

$('search').addEventListener('input', render);

// ---- Game state events ----
window.launcher.onGameStarted(({ id }) => {
  runningIds.add(id);
  render();
});

window.launcher.onGameStopped(({ id, games: updated, error }) => {
  runningIds.delete(id);
  games = updated;
  if (error) toast(error);
  render();
});

// ---- Settings: overlay hotkey ----
const KEY_NAMES = {
  Tab: 'Tab', Space: 'Space', Enter: 'Enter', Backspace: 'Backspace', Insert: 'Insert', Delete: 'Delete',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\'
};

function acceleratorFromEvent(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null; // wait for a real key
  let main = null;
  if (/^Key[A-Z]$/.test(e.code)) main = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) main = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) main = e.code;
  else main = KEY_NAMES[e.code] || null;
  if (!main) return { error: "That key can't be used. Try a letter, number, or F-key." };

  const parts = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  if (!parts.length && !/^F\d/.test(main)) return { error: 'Add a modifier such as Shift, Ctrl or Alt.' };
  return { accelerator: parts.concat(main).join('+') };
}

async function openSettings() {
  const settings = await window.launcher.getSettings();
  $('hotkeyBtn').textContent = settings.overlayHotkey;
  $('hotkeyMsg').textContent = '';
  $('settingsDialog').showModal();
}

function captureHotkey() {
  const btn = $('hotkeyBtn');
  const previous = btn.textContent;
  btn.textContent = 'Press a key combination (Esc to cancel)';
  btn.classList.add('capturing');
  $('hotkeyMsg').textContent = '';

  const stop = () => {
    btn.classList.remove('capturing');
    window.removeEventListener('keydown', onKey, true);
  };

  async function onKey(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      btn.textContent = previous;
      stop();
      return;
    }
    const result = acceleratorFromEvent(e);
    if (!result) return;
    if (result.error) {
      $('hotkeyMsg').textContent = result.error;
      return;
    }
    stop();
    const saved = await window.launcher.setHotkey(result.accelerator);
    if (saved.ok) {
      btn.textContent = saved.hotkey;
      $('hotkeyMsg').textContent = 'Saved.';
    } else {
      btn.textContent = previous;
      $('hotkeyMsg').textContent = saved.error;
    }
  }
  window.addEventListener('keydown', onKey, true);
}

$('settingsBtn').addEventListener('click', openSettings);
$('settingsClose').addEventListener('click', () => $('settingsDialog').close());
$('hotkeyBtn').addEventListener('click', captureHotkey);
window.launcher.onToast(toast);

$('viewGrid').addEventListener('click', () => setView('grid'));
$('viewList').addEventListener('click', () => setView('list'));
$('detailPlay').addEventListener('click', () => selectedId && launch(selectedId));
$('detailCover').addEventListener('click', () => selectedId && changeCover(selectedId));
$('detailRemove').addEventListener('click', () => {
  const g = games.find((x) => x.id === selectedId);
  if (g) removeGame(g);
});
$('detailNotes').addEventListener('input', () => {
  $('notesSaved').textContent = '';
  clearTimeout(notesTimer);
  notesTimer = setTimeout(flushDetailNotes, 600);
});
$('detailNotes').addEventListener('blur', () => {
  if (notesTimer) flushDetailNotes();
});

// Notes written on the overlay while a game runs show up when you come back to the launcher.
window.addEventListener('focus', async () => {
  if (view !== 'list' || document.activeElement === $('detailNotes')) return;
  const data = await window.launcher.getLibrary();
  games = data.games;
  render();
});

// ---- Find games ----
const SOURCE_LABELS = { steam: 'Steam', epic: 'Epic', gog: 'GOG', folder: 'Folder' };
let scanFolders = [];

function renderScanFolders() {
  const list = $('scanFolders');
  list.replaceChildren();
  for (const folder of scanFolders) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'path';
    label.textContent = folder;
    label.title = folder;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      scanFolders = scanFolders.filter((f) => f !== folder);
      await window.launcher.setScanFolders(scanFolders);
      renderScanFolders();
    });
    item.append(label, remove);
    list.append(item);
  }
}

async function openScan() {
  scanFolders = await window.launcher.getScanFolders();
  renderScanFolders();
  for (const el of document.querySelectorAll('[data-winonly]')) el.hidden = window.launcher.platform !== 'win32';
  $('scanResults').replaceChildren();
  $('scanStatus').textContent = '';
  $('scanAdd').disabled = true;
  $('selectAllRow').hidden = true;
  $('scanDialog').showModal();
}

function updateScanAddButton() {
  const boxes = [...$('scanResults').querySelectorAll('input[type="checkbox"]')];
  const checked = boxes.filter((b) => b.checked).length;
  $('scanAdd').disabled = checked === 0;
  $('scanAdd').textContent = checked ? `Add ${checked} selected` : 'Add selected';
  $('selectAll').checked = boxes.length > 0 && checked === boxes.length;
}

async function runScan() {
  const sources = [];
  if ($('srcSteam').checked) sources.push('steam');
  if (window.launcher.platform === 'win32') {
    if ($('srcEpic').checked) sources.push('epic');
    if ($('srcGog').checked) sources.push('gog');
  }
  if (sources.length === 0 && scanFolders.length === 0) {
    $('scanStatus').textContent = 'Pick a store or add a folder to look in.';
    return;
  }

  $('scanRun').disabled = true;
  $('scanStatus').textContent = 'Scanning...';
  $('scanResults').replaceChildren();
  $('selectAllRow').hidden = true;
  const result = await window.launcher.scanGames(sources, scanFolders);
  $('scanRun').disabled = false;

  const parts = [];
  parts.push(result.games.length ? `Found ${result.games.length} new ${result.games.length === 1 ? 'game' : 'games'}.` : 'No new games found.');
  if (result.alreadyAdded) parts.push(`${result.alreadyAdded} already in your library.`);
  parts.push(...result.notes);
  $('scanStatus').textContent = parts.join(' ');

  for (const g of result.games) {
    const item = document.createElement('li');
    const row = document.createElement('label');
    row.className = 'scan-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.dataset.key = g.key;
    box.addEventListener('change', updateScanAddButton);
    const name = document.createElement('span');
    name.className = 'scan-name';
    name.textContent = g.name;
    const badge = document.createElement('span');
    badge.className = 'scan-badge';
    badge.textContent = SOURCE_LABELS[g.source] || g.source;
    const where = document.createElement('span');
    where.className = 'scan-path';
    where.textContent = g.location;
    where.title = g.location;
    row.append(box, name, badge, where);
    item.append(row);
    $('scanResults').append(item);
  }
  $('selectAllRow').hidden = result.games.length === 0;
  updateScanAddButton();
}

$('scanBtn').addEventListener('click', openScan);
$('emptyScan').addEventListener('click', openScan);
$('scanClose').addEventListener('click', () => $('scanDialog').close());
$('scanRun').addEventListener('click', runScan);
$('selectAll').addEventListener('change', (e) => {
  for (const box of $('scanResults').querySelectorAll('input[type="checkbox"]')) box.checked = e.target.checked;
  updateScanAddButton();
});
$('addFolderBtn').addEventListener('click', async () => {
  const folder = await window.launcher.pickFolder();
  if (!folder || scanFolders.includes(folder)) return;
  scanFolders = [...scanFolders, folder];
  await window.launcher.setScanFolders(scanFolders);
  renderScanFolders();
});
$('scanAdd').addEventListener('click', async () => {
  const keys = [...$('scanResults').querySelectorAll('input[type="checkbox"]')].filter((b) => b.checked).map((b) => b.dataset.key);
  $('scanAdd').disabled = true;
  const result = await window.launcher.addDetected(keys);
  games = result.games;
  render();
  $('scanDialog').close();
  toast(`Added ${result.added} ${result.added === 1 ? 'game' : 'games'} to your library.`);
});

// ---- Settings: appearance ----
let theme = { ...Theme.DEFAULT };
let themeSaveTimer = null;

function setTheme(next, save = true) {
  theme = next;
  Theme.apply(theme);
  syncThemeControls();
  if (save) {
    clearTimeout(themeSaveTimer);
    themeSaveTimer = setTimeout(() => window.launcher.setTheme(theme), 250);
  }
}

function syncThemeControls() {
  const r = Theme.resolve(theme);
  $('colBg').value = r.background;
  $('colAccent').value = r.accent;
  $('usePanel').checked = !!theme.panel;
  $('colPanel').disabled = !theme.panel;
  $('colPanel').value = r.panel;
  for (const btn of $('presets').children) btn.setAttribute('aria-pressed', String(btn.dataset.id === theme.palette));
  for (const btn of $('corners').children) btn.setAttribute('aria-pressed', String(btn.dataset.corners === theme.corners));
  $('themeWarn').textContent = Theme.warnings(theme).join(' ');
}

function buildPresets() {
  for (const p of Theme.PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset';
    btn.dataset.id = p.id;
    const swatches = document.createElement('span');
    swatches.className = 'swatches';
    for (const color of [p.background, Theme.resolve(p).panel, p.accent]) {
      const dot = document.createElement('span');
      dot.style.background = color;
      swatches.append(dot);
    }
    const label = document.createElement('span');
    label.textContent = p.name;
    btn.append(swatches, label);
    btn.addEventListener('click', () =>
      setTheme({ ...theme, palette: p.id, background: p.background, panel: p.panel, accent: p.accent })
    );
    $('presets').append(btn);
  }
}

buildPresets();
$('colBg').addEventListener('input', (e) => setTheme({ ...theme, palette: 'custom', background: e.target.value }));
$('colAccent').addEventListener('input', (e) => setTheme({ ...theme, palette: 'custom', accent: e.target.value }));
$('colPanel').addEventListener('input', (e) => setTheme({ ...theme, palette: 'custom', panel: e.target.value }));
$('usePanel').addEventListener('change', (e) => {
  const panel = e.target.checked ? Theme.resolve(theme).panel : null;
  setTheme({ ...theme, palette: 'custom', panel });
});
for (const btn of $('corners').children) {
  btn.addEventListener('click', () => setTheme({ ...theme, corners: btn.dataset.corners }));
}
$('themeReset').addEventListener('click', () => setTheme({ ...Theme.DEFAULT }));

(async function init() {
  window.launcher.getTheme().then((saved) => setTheme(saved, false));
  const data = await window.launcher.getLibrary();
  games = data.games;
  runningIds = new Set(data.running);
  render();
})();