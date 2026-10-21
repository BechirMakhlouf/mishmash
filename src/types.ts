export type Scope = 'project' | 'user' | 'project-private';
export type AdapterId = string;
export type JsonObject = Record<string, unknown>;
export interface Diagnostic { code: string; severity: 'info' | 'warning' | 'error'; message: string; adapter?: string; resource?: string; path?: string }
export interface Context {
  scope: Scope; project: string; home: string; platform: NodeJS.Platform;
  env: Record<string, string | undefined>; canonicalRoot: string; stateRoot: string;
  opencodeVersion: 1 | 2; codexHome?: string; claudeStateFile?: string;
  skillMode: 'auto' | 'link' | 'copy';
}
export type Value = string | { env: string };
export interface Cwd { base: 'project' | 'home' | 'source'; path: string }
export interface StdioServer { type: 'stdio'; command: string; args?: string[]; env?: Record<string, Value>; cwd?: Cwd }
export interface RemoteServer { type: 'streamable-http' | 'sse'; url: string; headers?: Record<string, Value> }
export type Server = StdioServer | RemoteServer;
export interface McpDocument { version: 1; mcpServers: Record<string, Server> }
export interface SyncDocument { version: 1; targets: string[] }
export interface OverrideDocument { version: 1; mcpServers: Record<string, JsonObject> }
export interface SkillRoot { path: string; kind: 'canonical' | 'native' | 'legacy' | 'configured'; recursive?: boolean; maxDepth?: number; maxEntries?: number; maxDirectories?: number; ignoreFiles?: string[]; ignoredDirectories?: string[] }
export interface NativeFile { path: string; format: 'json' | 'jsonc' | 'toml'; mapPath: string[]; role?: 'primary' | 'legacy'; private?: boolean; exposureOverlay?: boolean; ignoreKeys?: string[] }
export interface AdapterLayout { skillRoots: SkillRoot[]; skillDestination?: string; directSkills: boolean; mcpFiles: NativeFile[]; diagnostics: Diagnostic[]; inputs?: string[] }
export interface DecodeResult { server?: Server; override?: JsonObject; diagnostics: Diagnostic[] }
export interface EncodeResult { entry?: JsonObject; diagnostics: Diagnostic[] }
export interface Adapter {
  id: string;
  resolve(context: Context): AdapterLayout;
  decode(entry: JsonObject, context: Context): DecodeResult;
  encode(server: Server, override: JsonObject | undefined, context: Context): EncodeResult;
}
export interface Skill { id: string; path: string; hash: string; realPath: string; nativeOnly: boolean; diagnostics: Diagnostic[] }
export interface CanonicalData { sync: SyncDocument; mcp: McpDocument; overrides: Record<string, OverrideDocument>; skills: Skill[]; diagnostics: Diagnostic[]; inputs: string[] }
export type Operation =
  | { kind: 'write'; path: string; content: string; mode?: number; reason: string }
  | { kind: 'copy'; path: string; source: string; reason: string }
  | { kind: 'link'; path: string; source: string; fallbackCopy: boolean; reason: string }
  | { kind: 'remove'; path: string; reason: string };
export interface Precondition { path: string; hash: string | null }
export interface ManagedEntry { path: string; hash: string; kind: Operation['kind']; keys?: Record<string, string[]> }
export interface State { version: 1; managed: Record<string, ManagedEntry> }
export interface Plan {
  version: 1; command: 'import' | 'sync'; scope: Scope; targets: string[];
  operations: Operation[]; diagnostics: Diagnostic[]; preconditions: Precondition[];
  statePath: string; state: State;
}
export interface ApplyResult { applied: boolean; changes: number; backupDirectory?: string }
