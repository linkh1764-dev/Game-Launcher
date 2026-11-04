const { app, BrowserWindow, ipcMain, dialog, globalShortcut, screen, nativeImage, WebContentsView, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const detect = require('./detect');

let win;
let overlay = null;
let hotkeyActive = false;
let currentGameId = null;

// Foreground-window tracking (lets the overlay stay on top of the game window only)
let activeWindow = null;
try {
  activeWindow = require('active-win');
} catch {
  activeWindow = null;
}
let trackingOk = !!activeWindow;
let overlayWanted = false; // the player has toggled the overlay on
let gameFocused = false; // the foreground window belongs to a running game
let lastBounds = null; // last known game window bounds
let pollTimer = null;
let polling = false;
const running = new Map(); // game id -> { child, startedAt }

const DEFAULT_THEME = { palette: 'dusk', background: '#161b2e', panel: '#20274a', accent: '#6c8cff', corners: 'rounded' };
const DEFAULT_SETTINGS = { overlayHotkey: 'Shift+Tab', theme: DEFAULT_THEME, scanFolders: [] };
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const CORNER_STYLES = ['rounded', 'subtle', 'blocky'];

// A palette is 2 colors (background + accent) or 3 (plus a separate panel color).
function sanitizeTheme(t) {
  t = t && typeof t === 'object' ? t : {};
  const hex = (v, fallback) => (typeof v === 'string' && HEX_COLOR.test(v) ? v.toLowerCase() : fallback);
  return {
    palette: typeof t.palette === 'string' ? t.palette.slice(0, 20) : DEFAULT_THEME.palette,
    background: hex(t.background, DEFAULT_THEME.background),
    panel: t.panel === null ? null : hex(t.panel, DEFAULT_THEME.panel),
    accent: hex(t.accent, DEFAULT_THEME.accent),
    corners: CORNER_STYLES.includes(t.corners) ? t.corners : DEFAULT_THEME.corners
  };
}

const libraryFile = () => path.join(app.getPath('userData'), 'library.json');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadLibrary() {
  try {
    return JSON.parse(fs.readFileSync(libraryFile(), 'utf8'));
  } catch {
    return [];
  }
}

function saveLibrary(games) {
  fs.mkdirSync(path.dirname(libraryFile()), { recursive: true });
  fs.writeFileSync(libraryFile(), JSON.stringify(games, null, 2));
}

function loadSettings() {
  let settings;
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  settings.theme = sanitizeTheme(settings.theme);
  return settings;
}

// ---- Cover art ----
const coversDir = () => path.join(app.getPath('userData'), 'covers');
const coverCache = new Map(); // file path -> data URL

function coverDataUrl(game) {
  if (!game.coverFile) return null;
  const file = path.join(coversDir(), game.coverFile);
  if (coverCache.has(file)) return coverCache.get(file);
  try {
    const url = 'data:image/jpeg;base64,' + fs.readFileSync(file).toString('base64');
    coverCache.set(file, url);
    return url;
  } catch {
    return null;
  }
}

function removeCoverFile(name) {
  if (!name) return;
  const file = path.join(coversDir(), name);
  coverCache.delete(file);
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

// The library as the launcher window needs it: games plus their cover images.
function libraryForUI() {
  return loadLibrary().map((g) => ({ ...g, coverUrl: coverDataUrl(g) }));
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 700,
    minHeight: 480,
    backgroundColor: loadSettings().theme.background,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile('index.html');
  win.on('closed', () => {
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    destroyBrowser();
  });
}

// ---- Overlay ----
function createOverlay() {
  if (overlay && !overlay.isDestroyed()) return overlay;
  overlay = new BrowserWindow({
    width: 320,
    height: 392,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[overlay] preload failed to load:', preloadPath, error && error.message);
  });
  overlay.webContents.on('console-message', (_e, level, message) => {
    console.log('[overlay page]', message);
  });
  overlay.loadFile('overlay.html');
  overlay.on('closed', () => {
    overlay = null;
  });
  return overlay;
}

function overlayState() {
  const run = running.get(currentGameId);
  const game = loadLibrary().find((g) => g.id === currentGameId);
  return {
    gameName: game ? game.name : null,
    startedAt: run ? run.startedAt : null,
    playSeconds: game ? game.playSeconds || 0 : 0,
    gameId: game ? game.id : null,
    notes: game ? game.notes || '' : '',
    hotkey: loadSettings().overlayHotkey
  };
}

function pushOverlayState() {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay:state', overlayState());
}

function sameExe(a, b) {
  if (!a || !b) return false;
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

function findRunningGame(win) {
  if (!win || !win.owner) return null;
  for (const [id, run] of running) {
    const pidMatch = run.child && win.owner.processId === run.child.pid;
    const dirMatch =
      run.installDir &&
      win.owner.path &&
      detect.norm(win.owner.path).includes(detect.norm(run.installDir).replace(/\/+$/, '') + '/');
    if (pidMatch || sameExe(win.owner.path, run.exePath) || dirMatch) return id;
  }
  return null;
}

function positionOverlay(o) {
  const [w] = o.getSize();
  let x;
  let y;
  if (trackingOk && lastBounds) {
    let area = lastBounds;
    if (process.platform === 'win32') area = screen.screenToDipRect(null, lastBounds);
    x = area.x + area.width - w - 16;
    y = area.y + 44; // clears a normal title bar
  } else {
    const { workArea } = screen.getPrimaryDisplay();
    x = workArea.x + workArea.width - w - 20;
    y = workArea.y + 20;
  }
  o.setPosition(Math.round(x), Math.round(y));
}

// Shows or hides the overlay (and browser) depending on what the player wants and what is in front.
function syncOverlay() {
  const active = running.size > 0 && (trackingOk ? gameFocused : true);
  if (overlayWanted && active) {
    const o = createOverlay();
    positionOverlay(o);
    if (!o.isVisible()) {
      pushOverlayState();
      o.showInactive();
    }
  } else if (overlay && !overlay.isDestroyed() && overlay.isVisible()) {
    overlay.hide();
  }
  syncBrowser(active);
}

function toggleOverlay() {
  if (running.size === 0) return;
  overlayWanted = !overlayWanted;
  if (!overlayWanted) browserWanted = false; // hiding the overlay hides the browser too
  syncOverlay();
}

async function pollForeground() {
  if (polling || running.size === 0) return;
  polling = true;
  try {
    const front = await activeWindow();
    // If our own windows are in front (e.g. the player clicked the overlay), leave things as they are.
    if (front && front.owner && front.owner.processId === process.pid) return;
    const matchId = findRunningGame(front);
    gameFocused = !!matchId;
    if (matchId) {
      lastBounds = front.bounds;
      if (currentGameId !== matchId) {
        currentGameId = matchId;
        pushOverlayState();
      }
    }
    syncOverlay();
  } catch (err) {
    console.error('[launcher] window tracking failed:', err.message);
    trackingOk = false;
    stopForegroundTracking();
    send('toast', "Couldn't detect the game window, so the overlay will show in the corner of your main screen instead.");
    syncOverlay();
  } finally {
    polling = false;
  }
}

function startForegroundTracking() {
  if (!trackingOk || pollTimer) return;
  pollTimer = setInterval(pollForeground, 400);
}

function stopForegroundTracking() {
  clearInterval(pollTimer);
  pollTimer = null;
  gameFocused = false;
  lastBounds = null;
}

// ---- Web browser (opens inside the game window, like Steam's overlay browser) ----
const BROWSER_HOME = 'https://www.google.com';
const BROWSER_TOOLBAR_H = 44;
const BROWSER_EDGE = 4;
let browserWin = null;
let browserView = null;
let browserWanted = false;
let lastBrowserBounds = null;

function isWebUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// Addresses go straight there; anything else becomes a Google search.
function normalizeUrl(input) {
  const text = String(input || '').trim();
  if (!text) return BROWSER_HOME;
  if (/^https?:\/\//i.test(text)) return text;
  if (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(text)) return 'https://' + text;
  return 'https://www.google.com/search?q=' + encodeURIComponent(text);
}

function browserState() {
  if (!browserView || browserView.webContents.isDestroyed()) return null;
  const wc = browserView.webContents;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading()
  };
}

function sendBrowserState() {
  if (browserWin && !browserWin.isDestroyed()) browserWin.webContents.send('browser:state', browserState());
}

function layoutBrowser() {
  if (!browserWin || browserWin.isDestroyed() || !browserView) return;
  const [w, h] = browserWin.getContentSize();
  browserView.setBounds({
    x: BROWSER_EDGE,
    y: BROWSER_TOOLBAR_H,
    width: Math.max(0, w - BROWSER_EDGE * 2),
    height: Math.max(0, h - BROWSER_TOOLBAR_H - BROWSER_EDGE)
  });
}

function createBrowser() {
  if (browserWin && !browserWin.isDestroyed()) return browserWin;

  const ses = session.fromPartition('persist:overlay-browser');
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  browserWin = new BrowserWindow({
    width: 900,
    height: 620,
    minWidth: 480,
    minHeight: 320,
    frame: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: loadSettings().theme.background,
    webPreferences: {
      preload: path.join(__dirname, 'browser-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  browserWin.setAlwaysOnTop(true, 'screen-saver');
  browserWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  browserWin.loadFile('browser.html');

  // The web page itself: no preload, no Node, sandboxed, and its own cookie storage.
  browserView = new WebContentsView({
    webPreferences: {
      partition: 'persist:overlay-browser',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  browserWin.contentView.addChildView(browserView);
  layoutBrowser();
  browserWin.on('resize', layoutBrowser);

  const wc = browserView.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) wc.loadURL(url); // open "new windows" in the same view
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!isWebUrl(url)) e.preventDefault();
  });
  for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) {
    wc.on(event, sendBrowserState);
  }
  wc.loadURL(BROWSER_HOME);

  browserWin.on('closed', () => {
    browserWin = null;
    browserView = null;
  });
  return browserWin;
}

function destroyBrowser() {
  lastBrowserBounds = null;
  if (browserView) {
    try {
      browserView.webContents.close();
    } catch {
      /* already closed */
    }
  }
  browserView = null;
  if (browserWin && !browserWin.isDestroyed()) browserWin.destroy();
  browserWin = null;
}

function gameArea() {
  if (trackingOk && lastBounds) {
    return process.platform === 'win32' ? screen.screenToDipRect(null, lastBounds) : lastBounds;
  }
  return screen.getPrimaryDisplay().workArea;
}

function positionBrowser(b) {
  if (lastBrowserBounds) {
    b.setBounds(lastBrowserBounds);
    return;
  }
  const area = gameArea();
  const width = Math.max(480, Math.min(1000, Math.round(area.width * 0.7)));
  const height = Math.max(320, Math.min(700, Math.round(area.height * 0.75)));
  b.setBounds({
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height
  });
}

function syncBrowser(active) {
  if (!(browserWanted && active)) {
    if (browserWin && !browserWin.isDestroyed() && browserWin.isVisible()) {
      lastBrowserBounds = browserWin.getBounds();
      browserWin.hide();
    }
    return;
  }
  const b = createBrowser();
  if (!b.isVisible()) {
    positionBrowser(b);
    b.show(); // focused, so you can type straight away
    if (browserView) browserView.webContents.focus();
  }
}

ipcMain.handle('browser:getState', () => browserState());
ipcMain.on('browser:navigate', (_e, text) => {
  if (!browserView) return;
  browserView.webContents.loadURL(normalizeUrl(text));
  browserView.webContents.focus();
});
ipcMain.on('browser:back', () => browserView && browserView.webContents.navigationHistory.goBack());
ipcMain.on('browser:forward', () => browserView && browserView.webContents.navigationHistory.goForward());
ipcMain.on('browser:reload', () => {
  if (!browserView) return;
  const wc = browserView.webContents;
  if (wc.isLoading()) wc.stop();
  else wc.reload();
});
ipcMain.on('browser:home', () => browserView && browserView.webContents.loadURL(BROWSER_HOME));
ipcMain.on('browser:close', () => {
  browserWanted = false;
  syncOverlay();
});
ipcMain.on('browser:open', () => {
  if (running.size === 0) return;
  browserWanted = true;
  syncOverlay();
});

// The hotkey is only registered while a game is running, so it never
// steals the key (e.g. Shift+Tab) from other apps the rest of the time.
function registerHotkey() {
  unregisterHotkey();
  const accelerator = loadSettings().overlayHotkey;
  try {
    hotkeyActive = globalShortcut.register(accelerator, toggleOverlay);
  } catch {
    hotkeyActive = false;
  }
  if (!hotkeyActive) {
    send('toast', `Couldn't register ${accelerator}. Another app may be using it. Pick a different hotkey in Settings.`);
  }
}

function unregisterHotkey() {
  globalShortcut.unregisterAll();
  hotkeyActive = false;
}

// ---- Settings ----
ipcMain.handle('settings:get', () => loadSettings());

ipcMain.handle('theme:get', () => loadSettings().theme);

ipcMain.handle('theme:set', (e, incoming) => {
  const theme = sanitizeTheme(incoming);
  saveSettings({ ...loadSettings(), theme });
  // Tell the other windows (overlay, browser) so they restyle live.
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.webContents.id !== e.sender.id) w.webContents.send('theme:changed', theme);
  }
  return theme;
});

ipcMain.handle('settings:setHotkey', (_e, accelerator) => {
  const current = loadSettings().overlayHotkey;
  if (accelerator !== current) {
    // Test that the combination is valid and not already taken by another app.
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, () => {});
      if (ok) globalShortcut.unregister(accelerator);
    } catch {
      ok = false;
    }
    if (!ok) {
      if (hotkeyActive) registerHotkey();
      return { ok: false, error: `${accelerator} can't be used. It may already be taken by another app.` };
    }
  }
  saveSettings({ ...loadSettings(), overlayHotkey: accelerator });
  if (hotkeyActive) registerHotkey();
  pushOverlayState();
  return { ok: true, hotkey: accelerator };
});

ipcMain.handle('overlay:getState', () => overlayState());

ipcMain.handle('notes:save', (_e, { id, text }) => {
  const games = loadLibrary();
  const game = games.find((g) => g.id === id);
  if (!game) return false;
  game.notes = String(text).slice(0, 20000);
  saveLibrary(games);
  return true;
});

ipcMain.handle('cover:set', async (_e, id) => {
  const games = loadLibrary();
  const game = games.find((g) => g.id === id);
  if (!game) return { ok: false, error: 'That game is no longer in your library.' };

  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
  });
  if (result.canceled) return { ok: false, canceled: true };

  const image = nativeImage.createFromPath(result.filePaths[0]);
  if (image.isEmpty()) return { ok: false, error: "Couldn't read that image. Use a PNG or JPG file." };

  const resized = image.getSize().height > 800 ? image.resize({ height: 800, quality: 'best' }) : image;
  fs.mkdirSync(coversDir(), { recursive: true });
  const file = `${id}-${Date.now()}.jpg`;
  fs.writeFileSync(path.join(coversDir(), file), resized.toJPEG(90));

  removeCoverFile(game.coverFile);
  game.coverFile = file;
  saveLibrary(games);
  return { ok: true, games: libraryForUI() };
});

// ---- Library ----
ipcMain.handle('library:get', () => ({
  games: libraryForUI(),
  running: [...running.keys()]
}));

ipcMain.handle('library:add', (_e, { name, exePath }) => {
  const games = loadLibrary();
  const game = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    path: exePath,
    playSeconds: 0,
    lastPlayed: null
  };
  games.push(game);
  saveLibrary(games);
  return libraryForUI();
});

ipcMain.handle('library:remove', (_e, id) => {
  const all = loadLibrary();
  removeCoverFile((all.find((g) => g.id === id) || {}).coverFile);
  saveLibrary(all.filter((g) => g.id !== id));
  return libraryForUI();
});

ipcMain.handle('dialog:pickExecutable', async () => {
  const filters =
    process.platform === 'win32'
      ? [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd', 'lnk'] }, { name: 'All files', extensions: ['*'] }]
      : [{ name: 'All files', extensions: ['*'] }];
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  return result.canceled ? null : result.filePaths[0];
});

// ---- Game detection ----
let lastScan = new Map(); // key -> candidate from the most recent scan

function importCoverFile(game, srcPath) {
  try {
    const image = nativeImage.createFromPath(srcPath);
    if (image.isEmpty()) return false;
    const resized = image.getSize().height > 800 ? image.resize({ height: 800, quality: 'best' }) : image;
    fs.mkdirSync(coversDir(), { recursive: true });
    const file = `${game.id}-${Date.now()}.jpg`;
    fs.writeFileSync(path.join(coversDir(), file), resized.toJPEG(90));
    removeCoverFile(game.coverFile);
    game.coverFile = file;
    return true;
  } catch {
    return false;
  }
}

function alreadyInLibrary(candidate, games) {
  const cPath = candidate.path ? detect.norm(candidate.path) : null;
  const cDir = candidate.installDir ? detect.norm(candidate.installDir).replace(/\/+$/, '') : null;
  return games.some((g) => {
    if (g.sourceKey && g.sourceKey === candidate.key) return true;
    const gPath = g.path ? detect.norm(g.path) : null;
    const gDir = g.installDir ? detect.norm(g.installDir).replace(/\/+$/, '') : null;
    if (cPath && gPath && cPath === gPath) return true;
    if (cDir && gDir && cDir === gDir) return true;
    return !!(cDir && gPath && gPath.startsWith(cDir + '/'));
  });
}

ipcMain.handle('detect:getFolders', () => loadSettings().scanFolders);

ipcMain.handle('detect:setFolders', (_e, folders) => {
  const clean = Array.isArray(folders) ? folders.filter((f) => typeof f === 'string').slice(0, 20) : [];
  saveSettings({ ...loadSettings(), scanFolders: clean });
  return clean;
});

ipcMain.handle('detect:pickFolder', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('detect:scan', async (_e, { sources, folders }) => {
  const wanted = ['steam', 'epic', 'gog'].filter((s) => Array.isArray(sources) && sources.includes(s));
  const dirs = Array.isArray(folders) ? folders.filter((f) => typeof f === 'string').slice(0, 20) : [];
  const { games: found, notes } = await detect.detectGames({ sources: wanted, folders: dirs });
  const library = loadLibrary();
  const fresh = found.filter((c) => !alreadyInLibrary(c, library));
  lastScan = new Map(fresh.map((c) => [c.key, c]));
  return {
    games: fresh.map((c) => ({ key: c.key, name: c.name, source: c.source, location: c.path || c.installDir || '' })),
    notes,
    alreadyAdded: found.length - fresh.length
  };
});

ipcMain.handle('detect:add', (_e, keys) => {
  const games = loadLibrary();
  let added = 0;
  for (const key of Array.isArray(keys) ? keys : []) {
    const c = lastScan.get(key);
    if (!c || alreadyInLibrary(c, games)) continue;
    const game = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: c.name,
      path: c.path || '',
      installDir: c.installDir || null,
      launchUri: c.launchUri && /^steam:\/\/rungameid\/\d+$/.test(c.launchUri) ? c.launchUri : null,
      source: c.source,
      sourceKey: c.key,
      playSeconds: 0,
      lastPlayed: null,
      notes: ''
    };
    if (c.coverPath) importCoverFile(game, c.coverPath);
    games.push(game);
    lastScan.delete(key);
    added++;
  }
  saveLibrary(games);
  return { added, games: libraryForUI() };
});

// ---- Launching ----
const WATCH_INTERVAL_MS = 3000;
const WATCH_START_TIMEOUT_MS = 90000; // how long to wait for a hand-off game to appear
const WATCH_GONE_POLLS = 3; // polls in a row with nothing running before the session ends
const launching = new Set();

// Follows a game that another launcher started (Steam, or a stub that hands off):
// it counts as running while any process lives inside its install folder.
function watchByFolder(run, dir, finish, notFoundMessage) {
  const needle = detect.norm(dir).replace(/\/+$/, '') + '/';
  const watchStart = Date.now();
  let gone = 0;
  let busy = false;
  run.timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const paths = await detect.listProcessPaths();
      const alive = paths.some((p) => p.includes(needle));
      if (alive) {
        if (!run.seen) {
          run.seen = true;
          run.startedAt = Date.now();
          pushOverlayState();
        }
        gone = 0;
      } else if (run.seen) {
        if (++gone >= WATCH_GONE_POLLS) finish(null);
      } else if (Date.now() - watchStart > WATCH_START_TIMEOUT_MS) {
        finish(notFoundMessage);
      }
    } finally {
      busy = false;
    }
  }, WATCH_INTERVAL_MS);
}

ipcMain.handle('game:launch', async (_e, id) => {
  const game = loadLibrary().find((g) => g.id === id);
  if (!game) return { ok: false, error: 'That game is no longer in your library.' };
  if (running.has(id) || launching.has(id)) return { ok: false, error: `${game.name} is already running.` };

  const usesStore = !!game.launchUri;
  if (usesStore && game.installDir && !fs.existsSync(game.installDir)) {
    return { ok: false, error: `Can't find ${game.installDir}. Was it uninstalled?` };
  }
  if (!usesStore && !fs.existsSync(game.path)) {
    return { ok: false, error: `Can't find ${game.path}. Was it moved or uninstalled?` };
  }

  let child = null;
  launching.add(id);
  try {
    if (usesStore) {
      await shell.openExternal(game.launchUri);
    } else {
      child = spawn(game.path, [], { cwd: path.dirname(game.path), stdio: 'ignore' });
    }
  } catch (err) {
    return { ok: false, error: `Couldn't start ${game.name}: ${err.message}` };
  } finally {
    launching.delete(id);
  }

  const run = {
    child,
    startedAt: Date.now(),
    exePath: game.path || null,
    installDir: game.installDir || (game.path ? path.dirname(game.path) : null),
    timer: null,
    seen: false
  };
  running.set(id, run);
  currentGameId = id;
  if (!hotkeyActive) registerHotkey();
  startForegroundTracking();
  pushOverlayState();

  let finished = false;
  const finish = (errorMessage) => {
    if (finished) return;
    finished = true;
    if (run.timer) clearInterval(run.timer);
    running.delete(id);

    if (currentGameId === id) currentGameId = [...running.keys()].pop() || null;
    if (running.size === 0) {
      unregisterHotkey();
      stopForegroundTracking();
      overlayWanted = false;
      browserWanted = false;
      destroyBrowser();
      if (overlay && !overlay.isDestroyed()) overlay.hide();
    } else {
      pushOverlayState();
    }

    const games = loadLibrary();
    const g = games.find((x) => x.id === id);
    if (g && !errorMessage) {
      g.playSeconds += Math.round((Date.now() - run.startedAt) / 1000);
      g.lastPlayed = new Date().toISOString();
      saveLibrary(games);
    }
    send('game:stopped', { id, games: libraryForUI(), error: errorMessage || null });
  };

  if (child) {
    child.on('error', (err) => finish(`Couldn't start ${game.name}: ${err.message}`));
    child.on('exit', (code) => {
      const secs = Math.round((Date.now() - run.startedAt) / 1000);
      console.log(`[launcher] ${game.name} process exited after ${secs}s (code ${code})`);
      if (secs < 15 && (code === 0 || code === null) && run.installDir) {
        // Probably a stub that handed off to the real game (e.g. through Steam): keep watching the folder.
        watchByFolder(run, run.installDir, finish, `${game.name} closed right after starting, and no running copy of it was found.`);
      } else {
        finish(null);
      }
    });
  } else {
    watchByFolder(run, run.installDir, finish, `Couldn't detect ${game.name} starting. Make sure its store app is running and signed in.`);
  }

  send('game:started', { id });
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => globalShortcut.unregisterAll());