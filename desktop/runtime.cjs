'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function resolveMode(argv, isPackaged) {
  const args = new Set(argv);
  // A downloaded executable opens the real monitor; its explicit demo mode
  // still owns a separate synthetic source and temporary statistics directory.
  if (isPackaged) return args.has('--demo') ? 'demo' : 'live';
  return args.has('--live') ? 'live' : 'demo';
}

function isFile(filename) {
  try { return fs.statSync(filename).isFile(); } catch { return false; }
}

function resolveWorkerRuntime({ isPackaged, resourcesPath, sourceRoot,
  environment = process.env, home = os.homedir(), platform = process.platform }) {
  if (isPackaged) {
    // Python cannot execute a script or use a cwd inside Electron's app.asar.
    // Never substitute a host interpreter for a missing packaged resource.
    if (typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath)) return null;
    const command = path.join(resourcesPath, 'python', 'python.exe');
    const monitorPath = path.join(resourcesPath, 'backend', 'monitor.py');
    if (!isFile(command) || !isFile(monitorPath)) return null;
    return { command, prefix: [], cwd: resourcesPath, monitorPath };
  }

  const monitorPath = path.join(sourceRoot, 'backend', 'monitor.py');
  const configured = environment.CODEX_TPS_PYTHON;
  if (configured) {
    if (!path.isAbsolute(configured) || !fs.existsSync(configured)) return null;
    return { command: configured, prefix: [], cwd: sourceRoot, monitorPath };
  }
  const installed = path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe');
  if (fs.existsSync(installed)) return { command: installed, prefix: [], cwd: sourceRoot, monitorPath };
  return { command: platform === 'win32' ? 'py.exe' : 'python3',
    prefix: platform === 'win32' ? ['-3.12'] : [], cwd: sourceRoot, monitorPath };
}

module.exports = { resolveMode, resolveWorkerRuntime };
