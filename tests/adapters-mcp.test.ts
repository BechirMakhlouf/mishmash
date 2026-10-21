import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeCode } from '../src/adapters/claude-code.js';
import { codex } from '../src/adapters/codex.js';
import { githubCopilotCli } from '../src/adapters/github-copilot-cli.js';
import { pi } from '../src/adapters/pi.js';
import { opencode } from '../src/adapters/opencode.js';
import { geminiCli } from '../src/adapters/gemini-cli.js';
import type { Adapter, Context, JsonObject, Server } from '../src/types.js';

const context: Context = {
  scope: 'project', project: '/workspace/project', home: '/home/fixture', platform: 'linux', env: {},
  canonicalRoot: '/workspace/project/.agents', stateRoot: '/home/fixture/state', opencodeVersion: 2, skillMode: 'auto',
};
const all = [claudeCode, codex, githubCopilotCli, pi, opencode, geminiCli];
const errors = (result: { diagnostics: { severity: string }[] }) => result.diagnostics.filter(item => item.severity === 'error');
const local = (adapter: Adapter, extra: JsonObject = {}): JsonObject => adapter === opencode
  ? { type: 'local', command: ['node'], ...extra }
  : { command: 'node', ...extra };
const remote = (adapter: Adapter, url: string, extra: JsonObject = {}): JsonObject => ({
  ...(adapter === codex || adapter === pi ? {} : { type: adapter === opencode ? 'remote' : 'http' }), url, ...extra,
});

for (const adapter of all) {
  test(`${adapter.id} round-trips environment and full-header references without resolving them`, () => {
    const servers: Server[] = [
      { type: 'stdio', command: 'node', args: ['server.js', 'a b'], env: { MODE: 'safe', API_TOKEN: { env: 'API_TOKEN' } } },
      { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: { env: 'MCP_AUTH' }, Accept: 'application/json' } },
    ];
    for (const server of servers) {
      const encoded = adapter.encode(server, undefined, context);
      assert.deepEqual(errors(encoded), []);
      assert.ok(encoded.entry);
      const decoded = adapter.decode(encoded.entry, context);
      assert.deepEqual(errors(decoded), []);
      assert.deepEqual(decoded.server, server);
    }
  });

  test(`${adapter.id} preserves safe unknown native properties without allowing overrides to change portable fields`, () => {
    const nativeOptions = JSON.parse('{"extensionOptions":{"second":2,"first":1},"__proto__":{"sentinel":"safe"}}') as JsonObject;
    const decoded = adapter.decode(local(adapter, nativeOptions), context);
    assert.deepEqual(errors(decoded), []);
    assert.deepEqual(decoded.override, nativeOptions);
    assert.ok(decoded.server);
    const encoded = adapter.encode(decoded.server, decoded.override, context);
    assert.deepEqual(errors(encoded), []);
    for (const key of Object.keys(nativeOptions)) {
      assert.equal(Object.hasOwn(encoded.entry!, key), true);
      assert.deepEqual(encoded.entry![key], nativeOptions[key]);
    }
    const field = adapter === opencode ? 'environment' : 'env';
    const conflicting = adapter.encode({ type: 'stdio', command: 'node' }, { [field]: { MODE: 'changed' } }, context);
    assert.equal(conflicting.entry, undefined);
    assert.ok(errors(conflicting).length > 0);
  });

  test(`${adapter.id} rejects malformed native and canonical values before emitting usable servers`, () => {
    assert.equal(adapter.decode(remote(adapter, 'not a URL'), context).server, undefined);
    assert.equal(adapter.encode({ type: 'streamable-http', url: 'not a URL' }, undefined, context).entry, undefined);
    const field = adapter === opencode ? 'environment' : 'env';
    for (const values of [{ 'INVALID-NAME': 'safe' }, { MODE: 42 }]) {
      const result = adapter.decode(local(adapter, { [field]: values }), context);
      assert.equal(result.server, undefined);
      assert.ok(errors(result).length > 0);
    }
  });

  test(`${adapter.id} blocks literal credentials in portable and unknown native fields`, () => {
    const secret = 'must-not-be-persisted';
    for (const native of [local(adapter, { clientSecret: secret }), remote(adapter, 'https://example.com/mcp', { headers: { Authorization: secret }, http_headers: { Authorization: secret } })]) {
      const result = adapter.decode(native, context);
      assert.equal(result.server, undefined);
      assert.equal(JSON.stringify(result.diagnostics).includes(secret), false);
      assert.ok(errors(result).length > 0);
    }
  });
}

for (const adapter of [pi, opencode, geminiCli]) {
  test(`${adapter.id} retains unanchorable cwd as native-only rather than dropping execution intent`, () => {
    for (const [scope, cwd] of [['user', './per-session'], ['project', '/machine-only/runtime']] as const) {
      const selected = { ...context, scope, canonicalRoot: scope === 'user' ? '/home/fixture/.agents' : context.canonicalRoot };
      const result = adapter.decode(local(adapter, { cwd }), selected);
      assert.equal(result.server, undefined);
      assert.equal(result.override?.cwd, cwd);
      assert.ok(errors(result).length > 0);
    }
    const relative = adapter.decode(local(adapter, { cwd: './runtime/.' }), context);
    assert.deepEqual(errors(relative), []);
    assert.deepEqual(relative.server?.type === 'stdio' ? relative.server.cwd : undefined, { base: 'project', path: 'runtime' });
  });

  test(`${adapter.id} preserves own __proto__ environment and header entries`, () => {
    const field = adapter === opencode ? 'environment' : 'env';
    const values = JSON.parse('{"__proto__":"safe"}') as Record<string, string>;
    for (const native of [local(adapter, { [field]: values }), remote(adapter, 'https://example.com/mcp', { headers: values })]) {
      const decoded = adapter.decode(native, context);
      assert.deepEqual(errors(decoded), []);
      const server = decoded.server!;
      const result = server.type === 'stdio' ? server.env : server.headers;
      assert.equal(Object.hasOwn(result!, '__proto__'), true);
      assert.equal(result!.__proto__, 'safe');
      const encoded = adapter.encode(server, undefined, context);
      assert.deepEqual(errors(encoded), []);
      assert.equal(Object.hasOwn(encoded.entry![server.type === 'stdio' ? field : 'headers'] as object, '__proto__'), true);
    }
  });
}

test('native-only OAuth references remain typed canonical references and render in verified native syntax', () => {
  for (const adapter of [pi, opencode, geminiCli]) {
    const expression = adapter === opencode ? '{env:OAUTH_SECRET}' : '${OAUTH_SECRET}';
    const key = adapter === opencode ? 'client_secret' : 'clientSecret';
    const decoded = adapter.decode(remote(adapter, 'https://example.com/mcp', { oauth: { [key]: expression, scopes: ['read'] } }), context);
    assert.deepEqual(errors(decoded), []);
    assert.deepEqual(decoded.override?.oauth, { [key]: { env: 'OAUTH_SECRET' }, scopes: ['read'] });
    const encoded = adapter.encode(decoded.server!, decoded.override, context);
    assert.deepEqual(errors(encoded), []);
    assert.deepEqual(encoded.entry!.oauth, { [key]: expression, scopes: ['read'] });
  }
});

test('pi escapes literal dollars and leading bangs without executing or converting them into references', () => {
  const server: Server = { type: 'stdio', command: 'node', env: { MODE: '!command $NAME ${OTHER} $$ $!' } };
  const encoded = pi.encode(server, undefined, context);
  assert.deepEqual(errors(encoded), []);
  assert.equal((encoded.entry!.env as JsonObject).MODE, '$!command $$NAME $${OTHER} $$$$ $$!');
  assert.deepEqual(pi.decode(encoded.entry!, context).server, server);
  assert.equal(pi.decode({ command: 'node', env: { MODE: '!never execute this' } }, context).server, undefined);
});

test('legacy SSE is retained only by harnesses with an explicit native representation', () => {
  const server: Server = { type: 'sse', url: 'https://example.com/sse' };
  for (const adapter of all) {
    const result = adapter.encode(server, undefined, context);
    if ([claudeCode, githubCopilotCli, geminiCli].includes(adapter)) {
      assert.deepEqual(errors(result), []);
      assert.equal(result.entry?.type, 'sse');
      assert.deepEqual(adapter.decode(result.entry!, context).server, server);
    } else {
      assert.equal(result.entry, undefined);
      assert.ok(errors(result).length > 0);
    }
  }
});

test('native template interpolation never changes a canonical literal silently', () => {
  for (const adapter of [claudeCode, githubCopilotCli, opencode, geminiCli]) {
    const value = adapter === opencode ? '{env:NOT_A_REFERENCE}' : '${NOT_A_REFERENCE}';
    const result = adapter.encode({ type: 'stdio', command: 'node', env: { MODE: value } }, undefined, context);
    assert.equal(result.entry, undefined);
    assert.ok(errors(result).length > 0);
  }
  assert.equal(geminiCli.decode({ url: 'https://example.com/mcp' }, context).server, undefined);
  assert.equal(codex.encode({ type: 'stdio', command: 'node', env: { RENAMED: { env: 'ORIGINAL' } } }, undefined, context).entry, undefined);
});

test('Copilot explicit empty tool allowlists and native restrictions survive round-trip', () => {
  const source = { command: 'node', args: [], tools: [], deferTools: true, filterMapping: { safe: ['read'] } };
  const decoded = githubCopilotCli.decode(source, context);
  assert.deepEqual(errors(decoded), []);
  const encoded = githubCopilotCli.encode(decoded.server!, decoded.override, context);
  assert.deepEqual(errors(encoded), []);
  assert.deepEqual(encoded.entry, { type: 'stdio', ...source });
});

test('OpenCode translates activation, timeouts and OAuth spelling across native majors without weakening options', () => {
  const v1 = { ...context, opencodeVersion: 1 as const };
  const decoded = opencode.decode({ type: 'remote', url: 'https://example.com/mcp', enabled: false, timeout: 3000, oauth: { clientId: 'public-client', redirectUri: 'http://localhost/callback' } }, v1);
  assert.deepEqual(errors(decoded), []);
  const v2 = opencode.encode(decoded.server!, decoded.override, context);
  assert.deepEqual(errors(v2), []);
  assert.deepEqual(v2.entry, { type: 'remote', url: 'https://example.com/mcp', disabled: true, timeout: { startup: 3000, catalog: 3000, execution: 3000 }, oauth: { client_id: 'public-client', redirect_uri: 'http://localhost/callback' } });
  const lowered = opencode.encode(decoded.server!, { disabled: true, timeout: { startup: 3000, catalog: 3000, execution: 3000 }, oauth: { client_id: 'public-client' } }, v1);
  assert.deepEqual(errors(lowered), []);
  assert.equal(lowered.entry?.enabled, false);
  assert.equal(lowered.entry?.timeout, 3000);
  for (const override of [{ timeout: { startup: 1000, catalog: 2000, execution: 3000 } }, { protocol: 'legacy' }, { codemode: true }]) {
    assert.equal(opencode.encode(decoded.server!, override, v1).entry, undefined);
  }
  assert.equal(opencode.decode({ type: 'local', command: ['node'], enabled: 'false' }, v1).server, undefined);
  assert.equal(opencode.decode({ command: ['node'], enabled: false }, v1).server, undefined);
});

test('Gemini refuses environment overrides that its native launcher silently discards', () => {
  for (const key of ['NODE_OPTIONS', 'pythonpath', 'LD_PRELOAD', 'JAVA_TOOL_OPTIONS', 'CORECLR_ENABLE_PROFILING']) {
    for (const value of ['safe-literal', { env: 'RUNTIME_SETTING' }]) {
      const encoded = geminiCli.encode({ type: 'stdio', command: 'node', env: { [key]: value } }, undefined, context);
      assert.equal(encoded.entry, undefined);
      assert.ok(encoded.diagnostics.some(item => item.code === 'blocked-native-environment' && item.severity === 'error'));
    }
    const decoded = geminiCli.decode({ command: 'node', env: { [key]: 'safe-literal' } }, context);
    assert.equal(decoded.server, undefined);
    assert.ok(decoded.diagnostics.some(item => item.code === 'blocked-native-environment' && item.severity === 'error'));
  }
});

test('Windows cwd imports retain portable relative separators instead of machine-specific backslashes', () => {
  const windows: Context = { ...context, platform: 'win32', project: 'D:\\workspace\\project', home: 'C:\\Users\\Fixture', canonicalRoot: 'D:\\workspace\\project\\.agents' };
  for (const adapter of [pi, opencode, geminiCli]) {
    const decoded = adapter.decode(local(adapter, { cwd: 'D:\\workspace\\project\\runtime\\nested' }), windows);
    assert.deepEqual(errors(decoded), []);
    assert.deepEqual(decoded.server?.type === 'stdio' ? decoded.server.cwd : undefined, { base: 'project', path: 'runtime/nested' });
  }
});
