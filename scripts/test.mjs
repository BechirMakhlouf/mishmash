import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const files = (await readdir(new URL('../.test-dist/tests/', import.meta.url)))
  .filter(file => file.endsWith('.test.js')).sort().map(file => fileURLToPath(new URL(`../.test-dist/tests/${file}`, import.meta.url)));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
