import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Adds observation to an already built QA artifact, never changes permissions.
// Rebuild with npm run build:cloud to remove instrumentation afterward.
const root = resolve('.output/cloud/chrome-mv3');
const manifestPath = `${root}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.content_scripts.some(script => script.js.includes('native-media.js'))) throw new Error('QA instrumentation already installed; rebuild first.');
manifest.content_scripts.push({ matches: ['https://www.youtube.com/watch*'], js: ['native-media.js'] });
await copyFile('tests/cloud/native-media.js', `${root}/native-media.js`);
await copyFile('tests/cloud/native-status.js', `${root}/native-status.js`);
const popup = await readFile(`${root}/popup.html`, 'utf8');
await writeFile(`${root}/popup.html`, popup.replace('</head>', '<script src="native-status.js" defer></script></head>'));
await writeFile(manifestPath, JSON.stringify(manifest));
console.log(`Native QA observation added to ${root}; no permission changes.`);
