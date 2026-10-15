'use strict';

const metadata = require('./package.json');
const path = require('node:path');

module.exports = {
  appId: 'io.github.ww-cooooo.codex-speed',
  productName: 'Codex Speed',
  electronVersion: metadata.devDependencies.electron,
  electronDist: path.join(__dirname, 'node_modules', 'electron', 'dist'),
  directories: {app: 'build/app', output: 'release', buildResources: 'build-resources'},
  files: ['**/*', '!**/node_modules/**'],
  asar: true,
  npmRebuild: false,
  compression: 'maximum',
  artifactName: 'Codex-Speed-${version}-win-${arch}.${ext}',
  extraResources: [
    {from: 'vendor/python', to: 'python', filter: ['**/*']},
    {from: 'backend', to: 'backend', filter: ['**/*.py', '!tests/**', '!**/__pycache__/**', 'TOKENPULSE-LICENSE.txt', 'THIRD_PARTY.md']},
    {from: 'LICENSE', to: 'licenses/Codex-Speed-MIT.txt'},
    {from: 'THIRD_PARTY_NOTICES.md', to: 'licenses/THIRD_PARTY_NOTICES.md'},
  ],
  win: {
    target: [{target: 'portable', arch: ['x64']}],
    icon: 'build-resources/icon.ico',
    requestedExecutionLevel: 'asInvoker',
    signExecutable: false,
  },
  portable: {requestExecutionLevel: 'user', unpackDirName: false},
  publish: null,
};
