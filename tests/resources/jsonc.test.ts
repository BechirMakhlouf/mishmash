import { afterEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { editJsonDocument, readJsonDocument } from '../../src/resources/jsonc.js';
import { createSandbox, putFile, type Sandbox } from '../helpers/sandbox.js';

let sandbox: Sandbox | undefined;
afterEach(async () => { await sandbox?.cleanup(); });
it('changes only the selected native registration and retains comments/settings', async () => {
  sandbox = await createSandbox();
  const path = join(sandbox.context.projectRoot, 'config.jsonc');
  await putFile(path, '{\n  // keep this native setting\n  "theme": "dark",\n  "mcpServers": { "untouched": { "command": "never-run" } }\n}\n');
  const document = await readJsonDocument(path);
  const encoded = editJsonDocument(document.text, [{ path: ['mcpServers', 'selected'], value: { command: 'selected-server' } }]);
  const text = Buffer.from(encoded).toString();
  expect(text.includes('// keep this native setting')).toBe(true);
  expect(parse(text)).toEqual({ theme: 'dark', mcpServers: { untouched: { command: 'never-run' }, selected: { command: 'selected-server' } } });
  expect((await readJsonDocument(path)).value).toEqual(document.value);
});
it('returns safe findings for credential-bearing malformed files', async () => {
  sandbox = await createSandbox();
  const path = join(sandbox.context.projectRoot, 'config.json');
  const secret = 'ephemeral-credential-marker';
  await putFile(path, `{ "secret": "${secret}`);
  const result = await readJsonDocument(path);
  expect(result.findings[0]?.code).toBe('INVALID_NATIVE_CONFIG');
  expect(result.text).toBe('');
  expect(JSON.stringify(result.findings).includes(secret)).toBe(false);
});
