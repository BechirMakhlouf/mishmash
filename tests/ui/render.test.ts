import { expect, it } from 'vitest';
import type { ApplyResult, Context, Inventory, LoadedState, McpResource, PathSnapshot, Plan, SkillResource, SourceRef } from '../../src/model.js';
import {
  renderApplyResult, renderDiscoverySummary, renderPlanDetails, renderPlanReview,
  renderResourceLabel, renderAuthorityName, sanitizeTerminalText,
} from '../../src/ui/render.js';
import { withClackSpinnerExitAbort } from '../../src/ui/flow.js';

const context: Context = {
  projectRoot: '/project',
  homeDir: '/home/tester',
  configHome: '/home/tester/.config',
  stateHome: '/home/tester/.local/state',
};
const hostilePath = '/tmp/source/\u001b[31mred\u001b[0m\nline\u001b]52;c;OSC-SECRET\u0007/hidden\u202e-name';
const source: SourceRef = {
  id: 'source-id',
  agentId: 'claude-code',
  path: hostilePath,
  scope: 'project',
  visibility: 'shared',
  label: 'Claude source\u001b[2J',
};
const snapshot: PathSnapshot = {
  path: hostilePath,
  kind: 'directory',
  digest: 'digest',
  mode: 0o755,
  entries: [],
  parents: [],
  resolvedPath: hostilePath,
};

it('strips terminal controls and line injection from filesystem-derived labels and paths', () => {
  const safe = sanitizeTerminalText(hostilePath);
  const authorityHeading = renderAuthorityName('skill:deploy\u001b[2J\nroot\u202e');
  const resource: SkillResource = {
    id: 'skill-id',
    kind: 'skill',
    name: 'deploy\u001b[2J\nroot\u202e',
    description: 'Safe summary\u0007\nsecond line',
    source,
    path: hostilePath,
    locator: 'deploy',
    snapshot,
  };
  const rendered = [safe, authorityHeading, ...Object.values(renderResourceLabel(resource)), ...renderDiscoverySummary({
    resources: [resource],
    sources: [source],
    detectedAgents: ['claude-code'],
    checkedLocations: [{ agentId: 'claude-code', path: hostilePath, kind: 'skills', scope: 'project', exists: true }],
    findings: [],
  })].join(' ');

  expect(rendered).not.toMatch(/[\u001b\u009b\u009d\u0000-\u001f\u007f-\u009f\u202a-\u202e]/);
  expect(rendered).not.toContain('OSC-SECRET');
  expect(rendered).toContain('deploy');
  expect(rendered).toContain('/tmp/source/red line');
});

it('turns a Clack spinner exit request into an abort and restores process.exit', async () => {
  const originalExit = process.exit;
  let abortReason: Error | undefined;
  const result = await withClackSpinnerExitAbort(async () => {
    Reflect.apply(process.exit, process, [0]);
    return 'settled';
  }, reason => { abortReason = reason; });

  expect(result).toBe('settled');
  expect(abortReason).toBeInstanceOf(Error);
  expect(process.exit).toBe(originalExit);
});

it('keeps credential-bearing MCP definitions and bodies out of safe review projections', () => {
  const secret = 'MCP-CREDENTIAL-BODY-MARKER';
  const mcp: McpResource = {
    id: 'mcp-id',
    kind: 'mcp',
    name: 'example-server',
    source,
    path: hostilePath,
    locator: 'example-server',
    snapshot,
    definition: {
      transport: 'stdio',
      command: 'run-server',
      args: [secret],
      env: { TOKEN: secret },
      headers: { Authorization: secret },
      nativeAgent: 'claude-code',
      native: { command: 'run-server', args: [secret], env: { TOKEN: secret }, headers: { Authorization: secret } },
      unsupportedFields: [],
    },
  };
  const copilot: McpResource = {
    ...mcp,
    id: 'mcp-copilot-id',
    definition: { ...mcp.definition, nativeAgent: 'github-copilot-cli' },
  };
  const inventory: Inventory = {
    resources: [mcp, copilot],
    sources: [source],
    detectedAgents: ['claude-code', 'github-copilot-cli'],
    checkedLocations: [],
    findings: [],
  };
  const state: LoadedState = {
    ownership: { version: 1, receipts: [] },
    preferencePath: '/private/preferences.json',
    ownershipPath: '/private/ownership.json',
    snapshots: [],
    findings: [],
  };
  const plan: Plan = {
    version: 1,
    id: 'plan-id',
    context,
    request: {
      resourceIds: ['mcp-id', 'mcp-copilot-id'],
      authority: { version: 1, sources: [source], resourceAuthorities: {} },
      destinations: [{ agentId: 'claude-code', placement: 'project' }],
      configuration: 'private-project',
    },
    operations: [{
      kind: 'write',
      path: hostilePath,
      expected: snapshot,
      resourceIds: ['mcp-id'],
      purpose: 'resource',
      description: 'Update selected MCP registration.',
      content: { kind: 'bytes', bytes: Buffer.from(secret) },
      mode: 0o600,
    }],
    preconditions: [],
    findings: [],
    summary: {
      authorities: [source],
      resources: [
        { id: 'mcp-id', name: mcp.name, kind: 'mcp' },
        { id: 'mcp-copilot-id', name: copilot.name, kind: 'mcp' },
      ],
      destinations: [{ agentId: 'claude-code', placement: 'project', paths: [hostilePath] }],
      additions: 1,
      updates: 0,
      removals: 0,
      unchanged: 0,
    },
  };
  const applied: ApplyResult = { status: 'applied', changed: 1, unchanged: 0, findings: [] };
  const claudeView = renderResourceLabel(mcp);
  const copilotView = renderResourceLabel(copilot);
  const interpretationDetails = renderPlanDetails(plan, [mcp, copilot]).filter(line => line.includes(mcp.name));
  expect(claudeView.hint).not.toBe(copilotView.hint);
  expect(interpretationDetails).toHaveLength(2);
  expect(interpretationDetails[0]).not.toBe(interpretationDetails[1]);
  const projections = [
    renderResourceLabel(mcp).label,
    ...renderDiscoverySummary(inventory),
    ...renderPlanReview(plan, state, 1, [source]),
    ...renderPlanDetails(plan, [mcp, copilot]),
    ...renderApplyResult(applied),
  ].join(' ');

  expect(projections).not.toContain(secret);
  expect(projections).not.toContain('Authorization');
  expect(projections).not.toContain('run-server');
  expect(projections).not.toMatch(/[\u001b\u009b\u009d\u0000-\u001f\u007f-\u009f\u202a-\u202e]/);
});
