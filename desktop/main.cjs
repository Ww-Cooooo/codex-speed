'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { sanitizeSnapshot, sanitizeConversationOrder, sanitizeExpandedSize, clampExpandedSize,
  clampBounds, STATUS_MESSAGES, pathsOverlap, WINDOW_WIDTH, EXPANDED_HEIGHT, COLLAPSED_HEIGHT,
  MIN_WINDOW_WIDTH, MIN_EXPANDED_HEIGHT, MAX_WINDOW_DIMENSION, MAX_PREFERENCES_BYTES } = require('./validation.cjs');

const args = new Set(process.argv.slice(1));
const mode = args.has('--live') ? 'live' : 'demo';
const smokeTest = args.has('--smoke-test');
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const sourceRoot = path.resolve(__dirname, '..');
const rendererRoot = path.join(sourceRoot, 'dist');
const entryPath = path.join(rendererRoot, 'index.html');
const tempPrefix = 'codex-tps-demo-';
const demoRoot = mode === 'demo' ? fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix)) : null;
const dataRoot = demoRoot || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CodexTPS');
const liveSource = process.env.CODEX_TPS_CODEX_HOME ? path.resolve(process.env.CODEX_TPS_CODEX_HOME) : path.join(os.homedir(), '.codex');
// Validate before Chromium caches or preferences can write to an overlapping source.
if (mode === 'live') {
  try {
    if (pathsOverlap(liveSource, dataRoot)) throw new Error('overlap');
  } catch {
    process.stderr.write('统计目录与来源目录冲突，未启动。\n');
    app.exit(1);
  }
}
const privatePrefix = 'codex-tps-private-';
function createScratchRoot() {
  fs.mkdirSync(dataRoot, { recursive: true });
  return fs.mkdtempSync(path.join(dataRoot, privatePrefix));
}
const scratchRoot = demoRoot || createScratchRoot();
const preferencesPath = path.join(dataRoot, 'preferences.json');

// All Chromium caches and app statistics belong to this app's own directory.
fs.mkdirSync(path.join(dataRoot, 'electron'), { recursive: true });
app.setPath('userData', path.join(dataRoot, 'electron'));
app.setPath('sessionData', path.join(dataRoot, 'electron'));
app.setName('Codex Speed');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');

let mainWindow = null;
let tray = null;
let worker = null;
let quitting = false;
let latestSnapshot = null;
let state = { pinned: true, expanded: true, conversationOrder: [], expandedSize: { width: WINDOW_WIDTH, height: EXPANDED_HEIGHT } };
let savedPosition = null;
let preferencesTimer = null;
let loaded = false;
let smokeFinished = false;
let workerStopped = false;
let shutdownStarted = false;
let userResizing = false;
let resizeMode = null;
let maximizing = false;

function removeDemoRoot() {
  if (!demoRoot) return;
  const resolved = path.resolve(demoRoot);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith(tempPrefix)) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Next OS temp cleanup can remove a busy Chromium cache. */ }
  }
}

function removeScratchRoot() {
  if (scratchRoot === demoRoot) return;
  const resolved = path.resolve(scratchRoot);
  if (path.dirname(resolved) === path.resolve(dataRoot) && path.basename(resolved).startsWith(privatePrefix)) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Retry this app-owned scratch directory at the next launch. */ }
  }
}

function removeStaleScratchRoots() {
  if (mode !== 'live') return;
  const parent = fs.realpathSync.native(dataRoot);
  for (const entry of fs.readdirSync(dataRoot, { withFileTypes: true }).slice(0, 128)) {
    if (!entry.isDirectory() || !entry.name.startsWith(privatePrefix)) continue;
    const candidate = path.join(dataRoot, entry.name);
    if (candidate === scratchRoot) continue;
    try {
      const real = fs.realpathSync.native(candidate);
      if (path.dirname(real) === parent) fs.rmSync(candidate, { recursive: true, force: true });
    } catch { /* A locked or unresolvable scratch folder remains local; do not follow it elsewhere. */ }
  }
}

function readPreferences() {
  try {
    if (fs.statSync(preferencesPath).size > MAX_PREFERENCES_BYTES) return;
    const saved = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
    if (typeof saved.pinned === 'boolean') state.pinned = saved.pinned;
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && Math.abs(saved.x) < 1e6 && Math.abs(saved.y) < 1e6) {
      savedPosition = { x: saved.x, y: saved.y };
    }
    const order = sanitizeConversationOrder(saved.conversationOrder);
    if (order !== null) state.conversationOrder = order;
    const expandedSize = sanitizeExpandedSize(saved.expandedSize);
    if (expandedSize !== null) state.expandedSize = expandedSize;
  } catch { /* First launch or an unreadable preference does not block monitoring. */ }
}

function savePreferences(conversationOrder = state.conversationOrder) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  // A full-screen-sized maximized position is temporary. Reopening should use
  // the user's normal window position and separately saved expanded dimensions.
  const { x, y } = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    const temporary = preferencesPath + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ pinned: state.pinned, x, y, conversationOrder, expandedSize: state.expandedSize }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, preferencesPath);
    return true;
  } catch { return false; /* Optional preferences never block monitoring. */ }
}

function schedulePreferences() {
  clearTimeout(preferencesTimer);
  preferencesTimer = setTimeout(savePreferences, 250);
}

function desktopState() { return { pinned: state.pinned, expanded: state.expanded,
  maximized: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()),
  conversationOrder: [...state.conversationOrder], expandedSize: { ...state.expandedSize } }; }

function publishState() {
  if (loaded && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tps:state', desktopState());
}

function setResizeMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed() || maximizing || mainWindow.isMaximized()) return;
  const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  const key = `${mode}:${area.width}:${area.height}`;
  if (resizeMode === key) return;
  resizeMode = key;
  // Animation and compact dropdowns temporarily need more height than the
  // compact bar. Only a settled expanded/compact window accepts native resizing.
  mainWindow.setResizable(false);
  // Relax the previous compact maximum before raising the expanded minimum.
  mainWindow.setMaximumSize(area.width, area.height);
  mainWindow.setMinimumSize(Math.min(MIN_WINDOW_WIDTH, area.width), Math.min(mode === 'expanded' ? MIN_EXPANDED_HEIGHT : COLLAPSED_HEIGHT, area.height));
  if (mode === 'compact') mainWindow.setMaximumSize(area.width, Math.min(COLLAPSED_HEIGHT, area.height));
  mainWindow.setResizable(mode === 'expanded' || mode === 'compact');
}

function resizeHeight(height, finished = false) {
  if (!mainWindow || mainWindow.isDestroyed() || maximizing || mainWindow.isMaximized() || !Number.isInteger(height)
    || height <= 0 || height > MAX_WINDOW_DIMENSION || typeof finished !== 'boolean') return;
  setResizeMode('animation');
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const compactHeight = Math.min(COLLAPSED_HEIGHT, display.workArea.height);
  // A screen change may lower expandedSize while old animation frames are still
  // arriving. Clamp them so the final frame can still restore native resizing.
  const nextHeight = Math.min(state.expandedSize.height, Math.max(compactHeight, height));
  mainWindow.setBounds(clampBounds(bounds, display.workArea, nextHeight), false);
  if (finished) setResizeMode(state.expanded ? 'expanded' : nextHeight === compactHeight ? 'compact' : 'overlay');
}

function captureUserSize() {
  if (!userResizing || maximizing || !mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized()) return;
  const { width, height } = mainWindow.getBounds();
  state.expandedSize = { width, height: state.expanded ? height : state.expandedSize.height };
  publishState();
  schedulePreferences();
}

function fitWindowToDisplay() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Showing a hidden maximized window and a second launch must preserve its
  // current maximized state. Normal bounds are fitted when it is restored.
  if (mainWindow.isMaximized()) { publishState(); return; }
  const bounds = mainWindow.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  state.expandedSize = clampExpandedSize(state.expandedSize, area);
  resizeMode = null;
  setResizeMode('animation');
  const height = state.expanded ? state.expandedSize.height : Math.min(COLLAPSED_HEIGHT, area.height);
  mainWindow.setBounds(clampBounds({ ...bounds, width: state.expandedSize.width }, area, height), false);
  setResizeMode(state.expanded ? 'expanded' : 'compact');
  publishState();
}

function restoreWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  fitWindowToDisplay();
  mainWindow.show();
  mainWindow.focus();
  updateTray();
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const visible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? '隐藏悬浮窗' : '显示悬浮窗', click: () => { if (visible) mainWindow.hide(); else restoreWindow(); } },
    { label: '窗口置顶', type: 'checkbox', checked: state.pinned, click: (item) => setPinned(item.checked) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

function setPinned(pinned) {
  state.pinned = pinned;
  mainWindow.setAlwaysOnTop(pinned, 'floating');
  schedulePreferences();
  updateTray();
  return desktopState();
}

function setMaximized(maximized) {
  if (maximized === mainWindow.isMaximized()) return desktopState();
  userResizing = false;
  if (maximized) {
    // A compact bar has a height limit. Restore the normal expanded geometry
    // first so native maximize/restore has a useful normal window to return to.
    state.expanded = true;
    fitWindowToDisplay();
    maximizing = true;
    mainWindow.maximize();
  } else mainWindow.unmaximize();
  return desktopState();
}

function trustedSender(event) {
  return mainWindow && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame
    && event.senderFrame.url === mainWindow.webContents.getURL();
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...values) => {
    if (!trustedSender(event)) throw new Error('不允许的请求');
    return fn(...values);
  });
  handle('tps:get-snapshot', () => latestSnapshot);
  handle('tps:get-state', desktopState);
  handle('tps:set-pinned', (pinned) => {
    if (typeof pinned !== 'boolean') throw new TypeError('参数无效');
    return setPinned(pinned);
  });
  handle('tps:set-expanded', (expanded) => {
    if (typeof expanded !== 'boolean') throw new TypeError('参数无效');
    state.expanded = expanded;
    // Assign intent before the native event so an unmaximize notification cannot
    // reverse the renderer's request to collapse.
    if (!expanded && mainWindow.isMaximized()) mainWindow.unmaximize();
    setResizeMode('animation');
    // The renderer owns animated geometry through resize-height. This IPC only
    // records intent so a final-size jump cannot move the animation's anchor.
    return desktopState();
  });
  handle('tps:set-maximized', (maximized) => {
    if (typeof maximized !== 'boolean') throw new TypeError('参数无效');
    return setMaximized(maximized);
  });
  handle('tps:set-conversation-order', (ids) => {
    const order = sanitizeConversationOrder(ids);
    if (order === null) throw new TypeError('排序参数无效');
    // Commit only after the same atomic preference write used by window settings
    // succeeds. A failed manual sort must not promise persistence to the renderer.
    if (!savePreferences(order)) throw new Error('排序未能保存，请稍后重试');
    state.conversationOrder = order;
    return desktopState();
  });
  ipcMain.on('tps:resize-height', (event, height, finished) => { if (trustedSender(event)) resizeHeight(height, finished); });
  ipcMain.on('tps:hide', (event) => { if (trustedSender(event)) mainWindow.hide(); });
  ipcMain.on('tps:quit', (event) => { if (trustedSender(event)) app.quit(); });
}

function isRendererResource(url, resourceType) {
  if (url.startsWith('data:')) return resourceType === 'image' || resourceType === 'font';
  if (!url.startsWith('file:')) return false;
  try {
    const relative = path.relative(rendererRoot, fileURLToPath(url));
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  } catch { return false; }
}

function lockSession(contents) {
  const session = contents.session;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', (event, item) => { event.preventDefault(); item.cancel(); });
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !isRendererResource(details.url, details.resourceType) });
  });
  session.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: {
    ...details.responseHeaders,
    'Content-Security-Policy': ["default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'"],
  } }));
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function createTrayImage() {
  // Original 16-pixel mark, written directly into an RGBA bitmap; no external asset.
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  const set = (x, y, color) => {
    const offset = (y * size + x) * 4;
    pixels[offset] = color[2]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[0]; pixels[offset + 3] = 255;
  };
  for (let y = 2; y < 30; y++) for (let x = 2; x < 30; x++) {
    if ((x >= 7 && x <= 24) || (y >= 7 && y <= 24) || ((x - 7) ** 2 + (y - 7) ** 2 <= 25)
      || ((x - 24) ** 2 + (y - 24) ** 2 <= 25)) set(x, y, [28, 40, 43]);
  }
  const ys = [21, 20, 19, 18, 14, 11, 13, 17, 21, 23, 20, 17, 16, 15, 15, 15, 15, 15];
  for (let i = 0; i < ys.length; i++) {
    const start = i ? ys[i - 1] : ys[i];
    for (let y = Math.min(start, ys[i]); y <= Math.max(start, ys[i]); y++) {
      set(i + 7, y, [97, 216, 174]); if (y + 1 < 30) set(i + 7, y + 1, [97, 216, 174]);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
}

function createWindow() {
  readPreferences();
  const workArea = screen.getPrimaryDisplay().workArea;
  const initialArea = savedPosition ? screen.getDisplayNearestPoint(savedPosition).workArea : workArea;
  state.expandedSize = clampExpandedSize(state.expandedSize, initialArea);
  const initial = clampBounds({
    x: savedPosition?.x ?? workArea.x + workArea.width - state.expandedSize.width - 24,
    y: savedPosition?.y ?? workArea.y + 24,
    ...state.expandedSize,
  }, initialArea);
  mainWindow = new BrowserWindow({
    ...initial,
    frame: false,
    transparent: false,
    backgroundColor: '#171919',
    resizable: true,
    minWidth: Math.min(MIN_WINDOW_WIDTH, initialArea.width),
    minHeight: Math.min(MIN_EXPANDED_HEIGHT, initialArea.height),
    maxWidth: initialArea.width,
    maxHeight: initialArea.height,
    maximizable: true,
    fullscreenable: false,
    minimizable: false,
    alwaysOnTop: state.pinned,
    skipTaskbar: true,
    show: false,
    hasShadow: true,
    autoHideMenuBar: true,
    title: 'Codex Speed',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
      partition: 'codex-tps-renderer',
    },
  });
  mainWindow.setMenu(null);
  lockSession(mainWindow.webContents);
  mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); app.quit(); } });
  mainWindow.on('move', schedulePreferences);
  mainWindow.on('will-resize', () => { userResizing = true; });
  mainWindow.on('resize', captureUserSize);
  mainWindow.on('resized', () => {
    captureUserSize();
    userResizing = false;
    setResizeMode(state.expanded ? 'expanded' : 'compact');
  });
  mainWindow.on('maximize', () => {
    maximizing = false;
    userResizing = false;
    state.expanded = true;
    publishState();
  });
  mainWindow.on('unmaximize', () => {
    maximizing = false;
    userResizing = false;
    resizeMode = null;
    if (state.expanded) fitWindowToDisplay();
    else { setResizeMode('animation'); publishState(); }
  });
  mainWindow.on('show', updateTray);
  mainWindow.on('hide', updateTray);
  mainWindow.webContents.on('did-finish-load', () => {
    loaded = true;
    if (latestSnapshot) mainWindow.webContents.send('tps:snapshot', latestSnapshot);
    mainWindow.show();
    maybeFinishSmoke();
  });
  mainWindow.webContents.on('did-fail-load', (_event, code) => { if (code !== -3) startupFailed('renderer-load'); });
  tray = new Tray(createTrayImage());
  tray.setToolTip(mode === 'demo' ? 'Codex Speed · 示例数据' : 'Codex Speed · 本地只读');
  tray.on('click', restoreWindow);
  tray.on('double-click', restoreWindow);
  updateTray();
  registerIpc();
  mainWindow.loadFile(entryPath).catch(() => startupFailed('renderer-load'));
}

function workerEnvironment() {
  const environment = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  environment.PYTHONUTF8 = '1';
  environment.PYTHONUNBUFFERED = '1';
  return environment;
}

function choosePython() {
  const configured = process.env.CODEX_TPS_PYTHON;
  if (configured) {
    if (!path.isAbsolute(configured) || !fs.existsSync(configured)) return null;
    return { command: configured, prefix: [] };
  }
  const installed = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe');
  if (fs.existsSync(installed)) return { command: installed, prefix: [] };
  return process.platform === 'win32' ? { command: 'py.exe', prefix: ['-3.12'] } : { command: 'python3', prefix: [] };
}

function publishUnavailable(status = 'error') {
  latestSnapshot = {
    schemaVersion: 3, mode, status, message: STATUS_MESSAGES[status],
    updatedAt: new Date().toISOString(), activeProfile: null, profiles: [], samples: [], conversations: [],
  };
  if (loaded && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tps:snapshot', latestSnapshot);
}

function startWorker() {
  const python = choosePython();
  if (!python) { publishUnavailable(); finishSmoke(false, 'python-unavailable'); return; }
  const argv = [...python.prefix, '-I', path.join(sourceRoot, 'backend', 'monitor.py'), '--mode', mode, '--data-dir', path.join(dataRoot, 'data'), '--scratch-dir', scratchRoot];
  if (mode === 'live') argv.push('--codex-home', liveSource);
  worker = spawn(python.command, argv, {
    cwd: sourceRoot, shell: false, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'], env: workerEnvironment(),
  });
  let pending = Buffer.alloc(0);
  let droppingOversizeLine = false;
  worker.stdout.on('data', (chunk) => {
    // A malformed worker cannot grow an unbounded line buffer or forward a raw log.
    let buffer = chunk;
    if (droppingOversizeLine) {
      const end = buffer.indexOf(10);
      if (end === -1) return;
      droppingOversizeLine = false;
      buffer = buffer.subarray(end + 1);
    }
    pending = Buffer.concat([pending, buffer]);
    let end;
    while ((end = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      if (line.length > MAX_LINE_BYTES) continue;
      try {
        const clean = sanitizeSnapshot(JSON.parse(line.toString('utf8')), mode);
        if (!clean) continue;
        latestSnapshot = clean;
        if (loaded && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tps:snapshot', clean);
        maybeFinishSmoke();
      } catch { /* Discard diagnostics and malformed output instead of forwarding it. */ }
    }
    if (pending.length > MAX_LINE_BYTES) { pending = Buffer.alloc(0); droppingOversizeLine = true; }
  });
  worker.stderr.on('data', () => { /* Drain diagnostic bytes without storing or displaying file paths. */ });
  worker.on('error', () => { publishUnavailable(); finishSmoke(false, 'worker-start'); });
  worker.on('exit', () => { if (!quitting && !workerStopped) { publishUnavailable(); finishSmoke(false, 'worker-exit'); } });
  publishUnavailable('waiting');
}

function stopWorker() {
  workerStopped = true;
  if (!worker || worker.exitCode !== null) return;
  worker.stdin.destroy();
  worker.kill();
}

function finishSmoke(success, reason) {
  if (!smokeTest || smokeFinished) return;
  smokeFinished = true;
  process.stdout.write(JSON.stringify({ smoke: success ? 'passed' : 'failed', mode, reason }) + '\n');
  process.exitCode = success ? 0 : 1;
  app.quit();
}

function startupFailed(reason) {
  if (smokeTest) { finishSmoke(false, reason); return; }
  if (quitting) return;
  dialog.showErrorBox('Codex Speed 暂未就绪', '小工具暂时无法打开，请重新打开。若持续出现，请检查本地文件是否完整。');
  app.quit();
}

function maybeFinishSmoke() {
  if (!smokeTest || smokeFinished || !loaded || !latestSnapshot || !latestSnapshot.profiles.length) return;
  setTimeout(async () => {
    try {
      const result = await mainWindow.webContents.executeJavaScript(`({
        bridge: typeof window.tps?.getSnapshot === 'function',
        nodeHidden: typeof window.require === 'undefined' && typeof window.process === 'undefined',
        rendered: document.body.textContent.includes('TPS')
      })`);
      const before = mainWindow.getBounds();
      resizeHeight(COLLAPSED_HEIGHT);
      const collapsed = mainWindow.getBounds();
      resizeHeight(EXPANDED_HEIGHT);
      const after = mainWindow.getBounds();
      resizeHeight(COLLAPSED_HEIGHT);
      const web = mainWindow.webContents.getLastWebPreferences();
      const good = result.bridge && result.nodeHidden && result.rendered
        && web.sandbox && web.contextIsolation && !web.nodeIntegration
        && before.height === EXPANDED_HEIGHT && collapsed.height === COLLAPSED_HEIGHT && after.height === EXPANDED_HEIGHT;
      finishSmoke(good, good ? 'demo-render-and-window' : 'desktop-boundary');
    } catch { finishSmoke(false, 'desktop-boundary'); }
  }, 250);
}

if (!app.requestSingleInstanceLock()) {
  removeDemoRoot();
  removeScratchRoot();
  app.quit();
} else {
  // Only the lock holder may remove old scratch copies, never a second instance.
  removeStaleScratchRoots();
  app.on('second-instance', restoreWindow);
  app.on('before-quit', (event) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    event.preventDefault();
    quitting = true;
    clearTimeout(preferencesTimer);
    savePreferences();
    stopWorker();
    if (tray && !tray.isDestroyed()) tray.destroy();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    // Let the child release SQLite/temp handles before removing our demo folder.
    let resumed = false;
    const resume = () => { if (!resumed) { resumed = true; app.quit(); } };
    if (worker && worker.exitCode === null) {
      worker.once('exit', resume);
      setTimeout(resume, 750);
    } else resume();
  });
  app.on('will-quit', () => { removeDemoRoot(); removeScratchRoot(); });
  app.on('window-all-closed', () => { if (!quitting) app.quit(); });
  app.whenReady().then(() => {
    createWindow();
    startWorker();
    screen.on('display-removed', fitWindowToDisplay);
    screen.on('display-metrics-changed', fitWindowToDisplay);
    if (smokeTest) setTimeout(() => finishSmoke(false, 'timeout'), 15000).unref();
  }).catch(() => startupFailed('desktop-start'));
}
