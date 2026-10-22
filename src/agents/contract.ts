import type {
  AgentId, CheckedLocation, Context, Finding, McpResource, PathSnapshot,
  Placement, ResourceInstance, SourceRef,
} from '../model.js';

export interface NativeLocation {
  path: string;
  scope: 'project' | 'user';
  visibility: 'shared' | 'private';
}
export interface LocationResolution { location?: NativeLocation; findings: readonly Finding[] }
export interface AdapterDiscovery {
  resources: readonly ResourceInstance[];
  sources: readonly SourceRef[];
  checkedLocations: readonly CheckedLocation[];
  detected: boolean;
  findings: readonly Finding[];
}
export interface PreparedFileEdit {
  path: string;
  bytes: Uint8Array;
  mode: number;
  expected: PathSnapshot;
}
export interface PreparedMcpTarget {
  resourceId: string;
  key: string;
  slotId: string;
  path: string;
  beforeFingerprint?: string;
  afterFingerprint: string;
}
export interface PreparedMcpEdit {
  files: readonly PreparedFileEdit[];
  targets: readonly PreparedMcpTarget[];
  findings: readonly Finding[];
}
export interface NativeAdapter {
  id: AgentId;
  label: string;
  capabilities: {
    skills: readonly Placement[];
    mcp: readonly Placement[];
    links: boolean;
    transports: readonly ('stdio' | 'http' | 'sse')[];
  };
  discover(context: Context): Promise<AdapterDiscovery>;
  skillDestination(context: Context, placement: Placement): LocationResolution;
  prepareMcpEdit(context: Context, placement: Placement, resources: readonly McpResource[]): Promise<PreparedMcpEdit>;
}
