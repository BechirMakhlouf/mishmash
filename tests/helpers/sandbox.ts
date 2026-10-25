import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Context } from '../../src/model.js';

export interface Sandbox { root: string; context: Context; cleanup(): Promise<void> }
export async function createSandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'mishmash-test-'));
  const context: Context = { projectRoot: join(root, 'project'), homeDir: join(root, 'home'), configHome: join(root, 'xdg-config'), stateHome: join(root, 'xdg-state') };
  await Promise.all(Object.values(context).map(path => mkdir(path, { recursive: true })));
  return { root, context, cleanup: () => rm(root, { recursive: true, force: true }) };
}
export async function putFile(path: string, content: string | Uint8Array, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, mode === undefined ? undefined : { mode });
}
export async function putSkill(root: string, name: string, description = 'Useful development guidance'): Promise<string> {
  const path = join(root, name);
  await putFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nUse the complete skill directory.\n`);
  return path;
}
