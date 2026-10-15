'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { resolveMode, resolveWorkerRuntime } = require('./runtime.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-speed-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourcesPath = path.join(root, 'Portable resources');
  const sourceRoot = path.join(resourcesPath, 'app.asar');
  const home = path.join(root, 'Empty home');
  const write = (filename) => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, 'synthetic fixture');
    return filename;
  };
  return { resourcesPath, sourceRoot, home, write };
}

test('downloaded app defaults to live and --demo explicitly selects synthetic mode', () => {
  assert.equal(resolveMode([], true), 'live');
  assert.equal(resolveMode(['--live'], true), 'live');
  assert.equal(resolveMode(['--demo'], true), 'demo');
  assert.equal(resolveMode(['--live', '--demo'], true), 'demo');
  assert.equal(resolveMode(['--smoke-test'], true), 'live');
});

test('source mode preserves the existing explicit --live behavior', () => {
  assert.equal(resolveMode([], false), 'demo');
  assert.equal(resolveMode(['--demo'], false), 'demo');
  assert.equal(resolveMode(['--live'], false), 'live');
  assert.equal(resolveMode(['--live', '--demo'], false), 'live');
});

test('packaged worker uses real resources outside app.asar and ignores a host interpreter', (t) => {
  const f = fixture(t);
  const command = f.write(path.join(f.resourcesPath, 'python', 'python.exe'));
  const monitorPath = f.write(path.join(f.resourcesPath, 'backend', 'monitor.py'));
  const hostPython = f.write(path.join(f.home, 'host-python.exe'));
  const runtime = resolveWorkerRuntime({ ...f, isPackaged: true,
    environment: { CODEX_TPS_PYTHON: hostPython, PYTHONHOME: f.home, PYTHONPATH: f.home } });
  assert.deepEqual(runtime, { command, monitorPath, prefix: [], cwd: f.resourcesPath });
  assert.ok(!runtime.command.includes('app.asar'));
  assert.ok(!runtime.monitorPath.includes('app.asar'));
  assert.ok(!runtime.cwd.includes('app.asar'));
});

test('missing or invalid bundled resources never fall back to host Python', (t) => {
  const f = fixture(t);
  const configured = f.write(path.join(f.home, 'configured.exe'));
  f.write(path.join(f.home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'));
  const options = { ...f, isPackaged: true, environment: { CODEX_TPS_PYTHON: configured }, platform: 'win32' };
  assert.equal(resolveWorkerRuntime(options), null);
  const bundled = f.write(path.join(f.resourcesPath, 'python', 'python.exe'));
  assert.equal(resolveWorkerRuntime(options), null);
  f.write(path.join(f.resourcesPath, 'backend', 'monitor.py'));
  fs.rmSync(bundled);
  fs.mkdirSync(bundled);
  assert.equal(resolveWorkerRuntime(options), null);
  assert.equal(resolveWorkerRuntime({ ...options, resourcesPath: 'relative-resources' }), null);
});

test('source interpreter override and invalid override retain existing compatibility', (t) => {
  const f = fixture(t);
  const command = f.write(path.join(f.home, 'Custom Python', 'python.exe'));
  const options = { ...f, isPackaged: false };
  assert.deepEqual(resolveWorkerRuntime({ ...options, environment: { CODEX_TPS_PYTHON: command } }), {
    command, prefix: [], cwd: f.sourceRoot, monitorPath: path.join(f.sourceRoot, 'backend', 'monitor.py'),
  });
  assert.equal(resolveWorkerRuntime({ ...options, environment: { CODEX_TPS_PYTHON: 'python.exe' } }), null);
  assert.equal(resolveWorkerRuntime({ ...options, environment: { CODEX_TPS_PYTHON: path.join(f.home, 'missing.exe') } }), null);
});

test('source mode keeps Python312 discovery and platform launcher fallback', (t) => {
  const f = fixture(t);
  const options = { ...f, isPackaged: false, environment: {} };
  assert.deepEqual(resolveWorkerRuntime({ ...options, platform: 'win32' }), {
    command: 'py.exe', prefix: ['-3.12'], cwd: f.sourceRoot, monitorPath: path.join(f.sourceRoot, 'backend', 'monitor.py'),
  });
  assert.equal(resolveWorkerRuntime({ ...options, platform: 'linux' }).command, 'python3');
  const command = f.write(path.join(f.home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'));
  assert.equal(resolveWorkerRuntime({ ...options, platform: 'win32' }).command, command);
});
