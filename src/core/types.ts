export type ImpactMode = 'off' | 'regular' | 'fast' | 'extreme';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
export type ServiceTier = 'auto' | 'default' | 'flex' | 'scale' | 'priority' | 'ultrafast' | 'none';
export type ServiceTiers = Partial<Record<'openai' | 'anthropic' | 'google', ServiceTier>>;
export interface ImpactState {
  version: 1;
  mode: ImpactMode;
  revision: string;
  updatedAt: string;
}
export interface ImpactPolicy {
  main: { provider: 'openai-codex'; id: string; thinking: ThinkingLevel };
  roles: Record<string, string>;
  agentModels: Record<string, string>;
  tier: 'default' | 'priority';
  agentTiers: Record<string, string>;
  instruction: string;
}

export interface ImpactClient {
  version: 1;
  pid: number;
  host?: 'omp' | 'pi';
  capabilities?: { routing: boolean; priority: boolean };
  sessionId: string;
  cwd: string;
  revision: string;
  requestedMode: ImpactMode;
  appliedMode: ImpactMode;
  status: 'applied' | 'pending' | 'error';
  appliedRevision?: string;
  routingMode?: ImpactMode;
  routingRevision?: string;
  model: string;
  thinking: string;
  tier: string;
  error?: string;
  updatedAt: string;
}
