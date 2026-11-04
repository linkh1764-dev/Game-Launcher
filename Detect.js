// Finds installed games (Steam, Epic, GOG, plain folders) and lists running processes.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};
const readText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

// Lower-case, forward-slash version of a path, so paths compare the same on every OS.
const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();

function regQuery(args) {
  return new Promise((resolve) => {
    execFile('reg', ['query', ...args], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : stdout)
    );
  });
}

// ---- Steam ----
const unquote = (s) => s.slice(1, -1).replace(/\\(.)/g, '$1');

// Minimal parser for Valve's text format (libraryfolders.vdf, appmanifest_*.acf).
function parseVdf(text) {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}]/g) || [];
  let i = 0;
  function block() {
    const obj = {};
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t === '}') return obj;
      if (t === '{') continue;
      const key = unquote(t);
      if (tokens[i] === '{') {
        i++;
        obj[key] = block();
      } else if (i < tokens.length) {
        obj[key] = unquote(tokens[i++]);
      }
    }
    return obj;
  }
  return block();
}

async function steamRoot() {
  const candidates = [];
  if (isWin) {
    const out = await regQuery(['HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
    const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (m) candidates.push(m[1].trim());
    candidates.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
  } else {
    const home = os.homedir();
    candidates.push(
      path.join(home, '.local', 'share', 'Steam'),
      path.join(home, '.steam', 'steam'),
      path.join(home, '.steam', 'root'),
      path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')
    );
  }
  return candidates.find((c) => exists(path.join(c, 'steamapps'))) || null;
}

// Steam keeps cover art in its own cache; the folder layout differs between client versions.
function findSteamCover(root, appid) {
  const base = path.join(root, 'appcache', 'librarycache');
  const flat = path.join(base, `${appid}_library_600x900.jpg`);
  if (exists(flat)) return flat;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (e.isFile() && /^library_600x900(_2x)?\.jpg$/i.test(e.name)) return path.join(dir, e.name);
    }
    if (depth < 2) {
      for (const e of entries) {
        if (e.isDirectory()) {
          const found = walk(path.join(dir, e.name), depth + 1);
          if (found) return found;
        }
      }
    }
    return null;
  };
  return walk(path.join(base, String(appid)), 0);
}

const STEAM_NOT_GAMES = /steamworks common redistributables|steam linux runtime|^proton\b|steamvr|steam controller configs/i;

async function detectSteam() {
  const root = await steamRoot();
  if (!root) return { games: [], note: "Steam wasn't found on this computer." };

  const libraries = new Set([root]);
  const vdfText = readText(path.join(root, 'steamapps', 'libraryfolders.vdf'));
  if (vdfText) {
    const parsed = parseVdf(vdfText);
    const folders = parsed.libraryfolders || parsed.LibraryFolders || {};
    for (const key of Object.keys(folders)) {
      const entry = folders[key];
      const p = typeof entry === 'string' ? entry : entry && entry.path;
      if (p && /^\d+$/.test(key)) libraries.add(p);
    }
  }

  const games = [];
  for (const lib of libraries) {
    const apps = path.join(lib, 'steamapps');
    let files;
    try {
      files = fs.readdirSync(apps);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^appmanifest_\d+\.acf$/.test(f)) continue;
      const text = readText(path.join(apps, f));
      const state = text && parseVdf(text).AppState;
      if (!state || !state.name || !state.appid || !state.installdir) continue;
      if (STEAM_NOT_GAMES.test(state.name)) continue;
      const installDir = path.join(apps, 'common', state.installdir);
      if (!exists(installDir)) continue;
      games.push({
        source: 'steam',
        key: `steam:${state.appid}`,
        name: state.name,
        installDir,
        launchUri: `steam://rungameid/${state.appid}`,
        coverPath: findSteamCover(root, state.appid)
      });
    }
  }
  return { games };
}

// ---- Epic Games (Windows) ----
function detectEpic() {
  const dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { games: [], note: "Epic Games Launcher wasn't found on this computer." };
  }
  const games = [];
  for (const f of files) {
    if (!f.endsWith('.item')) continue;
    const m = readJson(path.join(dir, f));
    if (!m || !m.DisplayName || !m.InstallLocation || !m.LaunchExecutable || m.bIsIncompleteInstall) continue;
    if (Array.isArray(m.AppCategories) && !m.AppCategories.includes('games')) continue;
    const exe = path.join(m.InstallLocation, m.LaunchExecutable);
    if (!exists(exe)) continue;
    games.push({ source: 'epic', key: `epic:${m.AppName}`, name: m.DisplayName, path: exe, installDir: m.InstallLocation });
  }
  return { games };
}

// ---- GOG (Windows) ----
async function detectGog() {
  const out = await regQuery(['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', '/s']);
  if (!out) return { games: [], note: "GOG games weren't found on this computer." };
  const games = [];
  for (const block of out.split(/\r?\n(?=HKEY_)/)) {
    const get = (name) => {
      const m = block.match(new RegExp('^\\s+' + name + '\\s+REG_SZ\\s+(.+)$', 'mi'));
      return m ? m[1].trim() : null;
    };
    const name = get('gameName');
    const exe = get('exe');
    if (!name || !exe || !exists(exe)) continue;
    games.push({
      source: 'gog',
      key: `gog:${get('gameID') || name}`,
      name,
      path: exe,
      installDir: get('path') || path.dirname(exe)
    });
  }
  return { games };
}

// ---- Plain folders ----
const SKIP_DIRS = /^(_?commonredist|redist|redistributables?|directx|vcredist|__installer|installer|support|mono|monobleedingedge|crashreport(er)?|unitycrashhandler\d*|\.git|node_modules|engine)$/i;
const SKIP_FILES = /unins|uninst|crash|dxsetup|dxwebsetup|redist|dotnet|ndp\d|oalinst|physx|prereq|easyanticheat|eac_|battleye|updater|notification_helper|cefprocess|webview|installer|^setup/i;

function isCandidateFile(name, stat) {
  const ext = path.extname(name).toLowerCase();
  if (isWin) return ext === '.exe';
  if (!(stat.mode & 0o111)) return false;
  if (['.sh', '.x86_64', '.x86', '.appimage', '.run'].includes(ext)) return true;
  return (ext === '' || ext === '.bin') && stat.size > 1024 * 1024;
}

// Picks the most likely game executable inside a folder (largest, preferring one named like the folder).
function bestExecutable(dir) {
  const folderKey = path.basename(dir).toLowerCase().replace(/[^a-z0-9]/g, '');
  let best = null;
  let bestScore = -1;
  let seen = 0;
  const walk = (d, depth) => {
    if (seen > 5000) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      seen++;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 3 && !SKIP_DIRS.test(e.name)) walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const base = path.basename(e.name, path.extname(e.name));
      if (SKIP_FILES.test(base)) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!isCandidateFile(e.name, stat)) continue;
      const key = base.toLowerCase().replace(/[^a-z0-9]/g, '');
      let score = stat.size;
      if (key && folderKey && (folderKey.includes(key) || key.includes(folderKey))) score *= 3;
      if (score > bestScore) {
        best = full;
        bestScore = score;
      }
    }
  };
  walk(dir, 0);
  return best;
}

const prettify = (folderName) => folderName.replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();

function scanFolder(root) {
  const games = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return games;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const exe = bestExecutable(dir);
    if (exe) games.push({ source: 'folder', key: `path:${norm(exe)}`, name: prettify(e.name), path: exe, installDir: dir });
  }
  if (games.length === 0) {
    // The chosen folder might be a single game's folder.
    const exe = bestExecutable(root);
    if (exe) games.push({ source: 'folder', key: `path:${norm(exe)}`, name: prettify(path.basename(root)), path: exe, installDir: root });
  }
  return games;
}

async function detectGames({ sources = [], folders = [] }) {
  const found = [];
  const notes = [];
  const take = (result) => {
    found.push(...result.games);
    if (result.note) notes.push(result.note);
  };
  if (sources.includes('steam')) take(await detectSteam());
  if (sources.includes('epic')) {
    if (isWin) take(detectEpic());
    else notes.push('Epic Games detection only works on Windows for now.');
  }
  if (sources.includes('gog')) {
    if (isWin) take(await detectGog());
    else notes.push('GOG detection only works on Windows for now.');
  }
  for (const folder of folders) found.push(...scanFolder(folder));

  const unique = new Map();
  for (const g of found) if (!unique.has(g.key)) unique.set(g.key, g);
  const games = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { games, notes };
}

// ---- Running processes (used to follow games that start through another launcher) ----
function listProcessPaths() {
  if (isWin) {
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | Where-Object { $_.Path } | Select-Object -ExpandProperty Path'],
        { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => resolve(err ? [] : stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(norm))
      );
    });
  }
  return new Promise((resolve) => {
    const out = [];
    let pids = [];
    try {
      pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n));
    } catch {
      return resolve(out);
    }
    for (const pid of pids) {
      try {
        out.push(norm(fs.readlinkSync(`/proc/${pid}/exe`)));
      } catch {
        /* process gone or not ours */
      }
      try {
        out.push(norm(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')));
      } catch {
        /* process gone or not ours */
      }
    }
    resolve(out);
  });
}

module.exports = { detectGames, listProcessPaths, norm, parseVdf, bestExecutable };