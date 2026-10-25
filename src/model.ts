export type AgentId = 'claude-code' | 'codex' | 'github-copilot-cli' | 'pi' | 'opencode' | 'gemini-cli';
export type Scope = 'project' | 'user';
export type Visibility = 'shared' | 'private';
export type Placement = 'project' | 'private-project' | 'user';
export type ResourceKind = 'skill' | 'mcp';

export interface Context {
  projectRoot: string;
  homeDir: string;
  configHome: string;
  stateHome: string;
  extraSources?: readonly SourceRef[];
}
export interface Finding {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  path?: string;
  resourceId?: string;
  remediation?: string;
}
export interface SourceRef {
  id: string;
  agentId: AgentId | 'shared';
  agents?: readonly AgentId[];
  path: string;
  scope: Scope;
  visibility: Visibility;
  label: string;
}
export interface PathIdentity {
  path: string;
  kind: 'directory' | 'symlink' | 'file' | 'other';
  dev: string;
  ino: string;
  linkTarget?: string;
}
export interface TreeEntry {
  relativePath: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  mode: number;
  digest: string;
  linkTarget?: string;
}
export interface PathSnapshot {
  path: string;
  kind: 'missing' | 'file' | 'directory' | 'symlink' | 'other';
  digest: string;
  mode: number;
  entries: readonly TreeEntry[];
  parents: readonly PathIdentity[];
  linkTarget?: string;
  resolvedPath: string;
}
interface ResourceBase {
  id: string;
  name: string;
  description?: string;
  source: SourceRef;
  path: string;
  locator: string;
  snapshot: PathSnapshot;
}
export interface SkillResource extends ResourceBase { kind: 'skill' }
export interface McpDefinition {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  url?: string;
  headers?: Readonly<Record<string, string>>;
  cwd?: string;
  nativeAgent: AgentId;
  native: Readonly<Record<string, unknown>>;
  unsupportedFields: readonly string[];
}
export interface McpResource extends ResourceBase { kind: 'mcp'; definition: McpDefinition }
export type ResourceInstance = SkillResource | McpResource;
export interface CheckedLocation {
  agentId: AgentId | 'shared';
  path: string;
  kind: 'skills' | 'mcp' | 'evidence';
  scope: Scope;
  exists: boolean;
}
export interface Inventory {
  resources: readonly ResourceInstance[];
  sources: readonly SourceRef[];
  detectedAgents: readonly AgentId[];
  checkedLocations: readonly CheckedLocation[];
  findings: readonly Finding[];
}
export interface AuthorityConfig {
  version: 1;
  sources: readonly SourceRef[];
  resourceAuthorities: Readonly<Record<string, string>>;
}
export interface SelectionResolution { resources: readonly ResourceInstance[]; findings: readonly Finding[] }
export interface AuthorityConflict { key: string; resources: readonly ResourceInstance[] }
export interface AuthorityResolution {
  resources: readonly ResourceInstance[];
  choices: AuthorityConfig;
  conflicts: readonly AuthorityConflict[];
  findings: readonly Finding[];
}
export interface DestinationRequest { agentId: AgentId; placement: Placement }
export interface SyncRequest {
  resourceIds: readonly string[];
  authority: AuthorityConfig;
  destinations: readonly DestinationRequest[];
  skillMode?: 'copy' | 'link';
  configuration: 'project' | 'private-project' | 'user';
}
export interface OwnershipReceipt {
  slotId: string;
  path: string;
  kind: ResourceKind;
  key: string;
  sourceId: string;
  resourceId: string;
  fingerprint: string;
}
export interface OwnershipState { version: 1; receipts: readonly OwnershipReceipt[] }
export interface LoadedState {
  choices?: AuthorityConfig;
  ownership: OwnershipState;
  preferencePath: string;
  ownershipPath: string;
  snapshots: readonly PathSnapshot[];
  findings: readonly Finding[];
}
interface OperationBase {
  path: string;
  expected: PathSnapshot;
  resourceIds: readonly string[];
  purpose: 'resource' | 'state';
  description: string;
}
export type FileContent = { kind: 'bytes'; bytes: Uint8Array } | { kind: 'source'; path: string; snapshot: PathSnapshot };
export interface WriteOperation extends OperationBase { kind: 'write'; content: FileContent; mode: number }
export interface MkdirOperation extends OperationBase { kind: 'mkdir'; mode: number }
export interface SymlinkOperation extends OperationBase { kind: 'symlink'; target: string }
export interface RemoveOperation extends OperationBase { kind: 'remove' }
export interface ChmodOperation extends OperationBase { kind: 'chmod'; mode: number }
export type Operation = WriteOperation | MkdirOperation | SymlinkOperation | RemoveOperation | ChmodOperation;
export interface PlanSummary {
  authorities: readonly SourceRef[];
  resources: readonly { id: string; name: string; kind: ResourceKind }[];
  destinations: readonly { agentId: AgentId; placement: Placement; paths: readonly string[] }[];
  additions: number;
  updates: number;
  removals: number;
  unchanged: number;
  skillMode?: 'copy' | 'link';
}
export interface Plan {
  version: 1;
  id: string;
  context: Context;
  request: SyncRequest;
  operations: readonly Operation[];
  preconditions: readonly PathSnapshot[];
  findings: readonly Finding[];
  summary: PlanSummary;
}
export interface ApplyOptions {
  confirmed: boolean;
  signal?: AbortSignal;
  onCheckpoint?: (phase: 'prepared' | 'replaced' | 'committed', path?: string) => void;
}
export interface ApplyResult {
  status: 'declined' | 'cancelled' | 'blocked' | 'unchanged' | 'applied' | 'recovered' | 'recovery-required';
  changed: number;
  unchanged: number;
  findings: readonly Finding[];
  transactionPath?: string;
  backupPath?: string;
}
export interface JournalEntry {
  path: string;
  backupPath?: string;
  before: PathSnapshot;
  after?: PathSnapshot;
  operation: Operation['kind'];
  state: 'prepared' | 'intent' | 'replaced' | 'restored';
}
export interface TransactionJournal {
  version: 1;
  id: string;
  context: Context;
  status: 'prepared' | 'applying' | 'committed' | 'recovering' | 'recovered' | 'recovery-required';
  entries: readonly JournalEntry[];
}
export interface RecoveryStatus { transactions: readonly { path: string; journal: TransactionJournal }[]; findings: readonly Finding[] }
export type RecoveryResult = ApplyResult;
