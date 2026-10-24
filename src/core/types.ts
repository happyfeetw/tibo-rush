export type RushMode = 'off' | 'regular' | 'fast' | 'extreme';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
export type ServiceTier = 'auto' | 'default' | 'flex' | 'scale' | 'priority' | 'ultrafast' | 'none';
export type ServiceTiers = Partial<Record<'openai' | 'anthropic' | 'google', ServiceTier>>;
export interface RushState {
  version: 1;
  mode: RushMode;
  revision: string;
  updatedAt: string;
}
export interface RushPolicy {
  main: { provider: 'openai-codex'; id: string; thinking: ThinkingLevel };
  roles: Record<string, string>;
  agentModels: Record<string, string>;
  tier: 'default' | 'priority';
  agentTiers: Record<string, string>;
  instruction: string;
}

export interface RushClient {
  version: 1;
  pid: number;
  host?: 'omp' | 'pi';
  capabilities?: { routing: boolean; priority: boolean };
  sessionId: string;
  cwd: string;
  revision: string;
  requestedMode: RushMode;
  appliedMode: RushMode;
  status: 'applied' | 'pending' | 'error';
  appliedRevision?: string;
  routingMode?: RushMode;
  routingRevision?: string;
  model: string;
  thinking: string;
  tier: string;
  error?: string;
  updatedAt: string;
}
