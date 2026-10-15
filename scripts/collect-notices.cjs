'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const sections = ['# npm dependency notices\n\nGenerated from the exact local package lock. Original package license files remain in node_modules. Electron and Chromium notices remain in node_modules/electron/dist.\n'];
for (const [relative, info] of Object.entries(lock.packages)) {
  if (!relative) continue;
  const folder = path.join(root, relative);
  if (!fs.existsSync(folder)) continue;
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
  sections.push(`## ${manifest.name} ${manifest.version}\nLicense: ${manifest.license || info.license || 'See package source'}\nSource: ${manifest.homepage || manifest.repository?.url || manifest.repository || ''}\n`);
  for (const name of fs.readdirSync(folder)) {
    const file = path.join(folder, name);
    if (/^(licen[cs]e|copying|notice)(?:\b|[._-])/i.test(name) && fs.statSync(file).isFile() && fs.statSync(file).size < 256000) {
      sections.push(`### ${name}\n\n${fs.readFileSync(file, 'utf8')}\n`);
    }
  }
}
sections.push('## GSAP source notices\n');
for (const relative of ['node_modules/gsap/dist/gsap.js', 'node_modules/@gsap/react/dist/index.js']) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  sections.push(relative + '\n\n' + (source.match(/\/\*![\s\S]*?\*\//)?.[0] || source.slice(0, 700)) + '\n');
}
fs.writeFileSync(path.join(root, 'public/licenses/npm-notices.txt'), sections.join('\n'));
console.log(JSON.stringify({ packages: Object.keys(lock.packages).length - 1, notices: 'public/licenses/npm-notices.txt' }));
