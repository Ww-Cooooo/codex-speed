'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Transform, Readable} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {spawnSync} = require('node:child_process');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
const vendor = path.join(root, 'vendor');
const build = path.join(root, 'build');
const python = path.join(vendor, 'python');
const app = path.join(build, 'app');
const frontend = path.join(build, 'frontend');
const version = '3.13.16';
// Official release page: https://www.python.org/downloads/release/python-31316/
const url = `https://www.python.org/ftp/python/${version}/python-${version}-embed-amd64.zip`;
const expected = '97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297';
const archive = path.join(vendor, `python-${version}-embed-amd64.zip`);
const maxBytes = 32 * 1024 * 1024;
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function resetGenerated(directory) {
  if (![python, app].includes(directory)) throw new Error('Unexpected generated path');
  const parent = path.dirname(directory);
  fs.mkdirSync(parent, {recursive: true});
  if (fs.realpathSync(parent) !== parent || (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink())) {
    throw new Error('Generated directory must not redirect outside the project');
  }
  fs.rmSync(directory, {recursive: true, force: true});
  fs.mkdirSync(directory);
}

async function preparePython() {
  fs.mkdirSync(vendor, {recursive: true});
  if (fs.realpathSync(vendor) !== vendor) throw new Error('Runtime cache must stay inside the project');
  if (!fs.existsSync(archive)) {
    const response = await fetch(url, {signal: AbortSignal.timeout(120_000)});
    if (!response.ok || new URL(response.url).hostname !== 'www.python.org') throw new Error('Official Python download failed');
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Python download exceeds budget');
    let size = 0;
    const bound = new Transform({transform(chunk, encoding, done) {
      size += chunk.length;
      done(size > maxBytes ? new Error('Python download exceeds budget') : null, chunk);
    }});
    const temporary = archive + '.partial';
    await pipeline(Readable.fromWeb(response.body), bound, fs.createWriteStream(temporary));
    if (digest(temporary) !== expected) throw new Error('Python archive checksum mismatch; partial retained for diagnosis');
    fs.renameSync(temporary, archive);
  }
  if (fs.statSync(archive).size > maxBytes || digest(archive) !== expected) throw new Error('Cached Python archive checksum mismatch');
  resetGenerated(python);
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  // Windows' built-in libarchive reads this official, hash-verified ZIP. No
  // shell, downloaded unpacking program or PowerShell policy change is needed.
  const listed = spawnSync(tar, ['-tf', archive], {encoding: 'utf8', windowsHide: true, timeout: 30_000});
  if (listed.status !== 0) throw new Error('Windows tar could not inspect the Python archive');
  for (const name of listed.stdout.trim().split(/\r?\n/)) {
    if (path.isAbsolute(name) || name.replaceAll('\\', '/').split('/').includes('..')) throw new Error('Unsafe Python archive path');
  }
  const unpacked = spawnSync(tar, ['-xf', archive, '-C', python], {encoding: 'utf8', windowsHide: true, timeout: 60_000});
  if (unpacked.status !== 0) throw new Error('Windows tar could not unpack the Python runtime');
  for (const name of ['python.exe', 'python313.dll', 'python313.zip', 'python313._pth', '_sqlite3.pyd', 'sqlite3.dll', 'LICENSE.txt']) {
    if (!fs.statSync(path.join(python, name)).isFile()) throw new Error(`Required runtime file missing: ${name}`);
  }
  // Retain the official isolated search path. The backend admits only its own
  // bundled directory, not user site-packages, registry paths or PYTHONPATH.
  const pth = fs.readFileSync(path.join(python, 'python313._pth'), 'utf8');
  if (/^\s*import\s+site\s*$/m.test(pth)) throw new Error('Unexpected embedded site-package activation');
}

function prepareApp() {
  if (!fs.existsSync(path.join(frontend, 'index.html'))) throw new Error('Run the package frontend build first');
  resetGenerated(app);
  fs.cpSync(frontend, path.join(app, 'dist'), {recursive: true});
  fs.mkdirSync(path.join(app, 'desktop'));
  for (const name of ['main.cjs', 'preload.cjs', 'validation.cjs', 'runtime.cjs']) {
    fs.copyFileSync(path.join(root, 'desktop', name), path.join(app, 'desktop', name));
  }
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(root, name), path.join(app, name));
  const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  // Frontend packages are already compiled into dist. The Electron main process
  // uses only built-ins and these four files, so no npm tree is shipped twice.
  const metadata = {name: source.name, version: source.version, description: source.description,
    main: source.main, author: 'Ww-Cooooo', license: source.license, private: true};
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
}

(async () => {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This package target is Windows x64');
  await preparePython();
  prepareApp();
  process.stdout.write(JSON.stringify({prepared: true, python: version, sha256: expected, platform: 'win32-x64'}) + '\n');
})().catch(error => {process.stderr.write(error.message + '\n'); process.exitCode = 1;});
