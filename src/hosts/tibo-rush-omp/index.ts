import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentSession, ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { lookup, type AnySetting } from '@oh-my-pi/pi-coding-agent/config/registry';
import { atomicJson, getHome, listClients, policyFor, readState, setMode, MODES } from '../../core/lib.mjs';
import { getCommandCompletions } from '../../core/commands.mjs';
import type { ThinkingLevel as Thinking, ServiceTiers as Tiers, RushState as State, RushMode as Mode, RushPolicy as Policy } from '../../core/types';

type Context = ExtensionContext;
type SettingKey = 'modelRoles' | 'task.agentModelOverrides' | 'tier.subagent' | 'task.agentServiceTierOverrides';
type Capture = { runtime: boolean; value: unknown };
type Selector = Thinking | null;
type Baseline = {
  version: 1; sessionId: string; model: { provider: string; id: string };
  thinking: Selector; tiers: Tiers; settings: Record<SettingKey, Capture>; restored?: true; handoff?: string;
};
type IntentRef = { sourceId: string; token: string };
type Intent = IntentRef & {
  version: 1; sourceFile: string; createdAt: string; entryId?: string; startedAt?: string; confirmed?: true; resolved?: true;
};
type Handoff = { version: 1; sessionId: string; token: string; baseline: Baseline | null; source?: IntentRef };
type TransitionKind = 'new' | 'resume' | 'inherit';
type TransitionAttempt = {
  event: object; kind: TransitionKind; owner: string; epoch: number;
  valid: boolean; pending: boolean; ready: boolean;
};
const KEYS: SettingKey[] = ['modelRoles', 'task.agentModelOverrides', 'tier.subagent', 'task.agentServiceTierOverrides'];
const HANDLES: Record<SettingKey, AnySetting | undefined> = {
  modelRoles: lookup('modelRoles'),
  'task.agentModelOverrides': lookup('task.agentModelOverrides'),
  'tier.subagent': lookup('tier.subagent'),
  'task.agentServiceTierOverrides': lookup('task.agentServiceTierOverrides'),
};
const THINKING: Record<string, true> = { off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true, auto: true };
const TIERS: Record<string, true> = { none: true, inherit: true, auto: true, default: true, flex: true, scale: true, priority: true, ultrafast: true };
const MARKER = '<tibo-rush-policy>';
const END_MARKER = '</tibo-rush-policy>';
const HANDOFF = 'tibo-rush-session-handoff';
const INTENT = 'tibo-rush-transition-intent';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function settingRecord(value: unknown): value is Record<string, string | null> {
  return record(value) && Object.values(value).every(item => item === null || typeof item === 'string');
}
function parseBaseline(value: unknown, sessionId: string): Baseline {
  if (!record(value) || value.version !== 1 || value.sessionId !== sessionId ||
      !record(value.model) || typeof value.model.provider !== 'string' || !value.model.provider ||
      typeof value.model.id !== 'string' || !value.model.id ||
      (value.thinking !== null && (typeof value.thinking !== 'string' || !Object.hasOwn(THINKING, value.thinking))) || !record(value.tiers) ||
      !Object.values(value.tiers).every(tier => typeof tier === 'string' && Object.hasOwn(TIERS, tier)) || !record(value.settings)) {
    throw new Error('Invalid tibo-rush session baseline; refusing to overwrite it');
  }
  for (const key of KEYS) {
    const capture = value.settings[key];
    if (!record(capture) || typeof capture.runtime !== 'boolean' ||
        (capture.runtime && (key === 'tier.subagent' ? typeof capture.value !== 'string' || !Object.hasOwn(TIERS, capture.value) : !settingRecord(capture.value)))) {
      throw new Error(`Invalid baseline setting: ${key}`);
    }
  }
  if (value.restored !== undefined && value.restored !== true) throw new Error('Invalid tibo-rush restoration acknowledgement');
  if (value.handoff !== undefined && (typeof value.handoff !== 'string' || !/^[a-f0-9-]{36}$/.test(value.handoff))) {
    throw new Error('Invalid tibo-rush handoff generation');
  }
  // Every persisted field consumed below was validated above; SDK aliases are not runtime schemas.
  return value as unknown as Baseline;
}
function baselinePath(sessionId: string): string {
  return path.join(getHome(), 'baselines', `${createHash('sha256').update(sessionId).digest('hex')}.json`);
}
function clientPath(sessionId: string): string {
  return path.join(getHome(), 'clients', `${process.pid}-${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}.json`);
}
function intentDirectory(sourceId: string): string {
  return path.join(getHome(), 'handoffs', createHash('sha256').update(sourceId).digest('hex'));
}
function intentPath(ref: IntentRef): string {
  return path.join(intentDirectory(ref.sourceId), `${ref.token}.json`);
}
async function readIntent(ref: IntentRef): Promise<Intent | undefined> {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(intentPath(ref), 'utf8')); }
  catch (error) {
    if (record(error) && error.code === 'ENOENT') return;
    throw error;
  }
  if (!record(value) || value.version !== 1 || value.sourceId !== ref.sourceId ||
      value.token !== ref.token || !/^[a-f0-9-]{36}$/.test(ref.token) ||
      typeof value.sourceFile !== 'string' || !path.isAbsolute(value.sourceFile) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      (value.confirmed !== undefined && value.confirmed !== true) ||
      (value.resolved !== undefined && value.resolved !== true) ||
      (value.confirmed && (typeof value.entryId !== 'string' || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))))) {
    throw new Error('Invalid OMP transition intent; recovery blocked');
  }
  return value as unknown as Intent;
}
async function readSourceIntents(sourceId: string): Promise<Intent[]> {
  let directory: Awaited<ReturnType<typeof fs.opendir>>;
  try { directory = await fs.opendir(intentDirectory(sourceId)); }
  catch (error) {
    if (record(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  const intents: Intent[] = [];
  let count = 0;
  for await (const file of directory) {
    if (++count > 16) throw new Error('Too many OMP handoff records for one source; recovery blocked');
    if (!file.isFile() || !file.name.endsWith('.json')) continue;
    const token = file.name.slice(0, -5);
    if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error('Invalid OMP handoff filename; recovery blocked');
    const saved = await readIntent({ sourceId, token });
    if (saved) intents.push(saved);
  }
  return intents;
}
async function removeOwnedFile(file: string): Promise<void> {
  try { await fs.unlink(file); }
  catch (error) {
    if (!(record(error) && error.code === 'ENOENT')) throw error;
  }
}

export default function tiboRush(pi: ExtensionAPI) {
  let context: Context | undefined;
  let sessionId = '';
  let baseline: Baseline | undefined;
  let requested: State = { version: 1, mode: 'off', revision: 'initial', updatedAt: new Date(0).toISOString() };
  let appliedMode: Mode = 'off';
  let appliedRevision = '';
  let routingRevision = '';
  let routingMode: Mode = 'off';
  let routingPolicy: Policy | undefined;
  let appliedPolicy: Policy | undefined;
  let policyRevision = '';
  let requestedPolicy: Policy | null = null;
  let policyError: unknown;
  let owned = false;
  let status: 'applied' | 'pending' | 'error' = 'applied';
  let lastError: string | undefined;
  let publishedSignature = '';
  let publishedAt = 0;
  let serial: Promise<void> = Promise.resolve();
  let stopped = false;
  let stopTimer: (() => void) | undefined;
  let generation = 0;
  let restored = false;
  let baselineDurable = false;
  const retiredClients = new Set<string>();
  let pendingHandoff: Handoff | undefined;
  let pendingIntent: Intent | undefined;
  const retiredIntents = new Map<string, IntentRef>();
  let transition: TransitionAttempt | undefined;

  function current(ctx: Context, owner: string, epoch: number): boolean {
    return !stopped && generation === epoch && sessionId === owner && ctx.sessionManager.getSessionId() === owner;
  }

  function requireAttempt(ctx: Context, attempt: TransitionAttempt) {
    if (transition !== attempt || !attempt.valid) throw new Error('OMP transition preparation expired; original baseline retained');
    requireCurrent(ctx, attempt.owner, attempt.epoch);
  }

  function hostSession(ctx: Context, owner = sessionId): AgentSession {
    // These are SDK exports, not properties probed out of the read-only facade.
    // sdk.ts attaches this ref before runtime-init/TUI emit session_start.
    const session = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
    if (!session || session.sessionManager !== ctx.sessionManager || session.sessionManager.getSessionId() !== owner) {
      throw new Error('OMP current session is unavailable in the public agent registry; session unchanged');
    }
    return session;
  }

  function requireCurrent(ctx: Context, owner: string, epoch: number, mutation = false) {
    if (!current(ctx, owner, epoch)) throw new Error('OMP session changed during reconciliation; retained recovery baseline');
    if (hostSession(ctx, owner).isSessionTransitioning && mutation) throw new Error('OMP session transition in progress');
  }

  function latestHandoff(ctx: Context, owner: string): Handoff | undefined {
    const entries = ctx.sessionManager.getBranch();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.type !== 'custom' || entry.customType !== HANDOFF) continue;
      const data: unknown = entry.data;
      if (!record(data) || typeof data.sessionId !== 'string') throw new Error('Invalid OMP handoff identity; refusing restoration');
      if (data.sessionId !== owner) continue;
      if (data.version !== 1 || typeof data.token !== 'string' || !/^[a-f0-9-]{36}$/.test(data.token) ||
          (data.source !== undefined && (!record(data.source) || typeof data.source.sourceId !== 'string' ||
            !data.source.sourceId || data.source.sourceId === owner || data.source.token !== data.token))) {
        throw new Error('Invalid OMP handoff generation; refusing restoration');
      }
      const saved = data.baseline === null ? null : parseBaseline(data.baseline, owner);
      if (saved && (saved.handoff !== data.token || saved.restored)) throw new Error('Invalid OMP inherited baseline');
      return {
        version: 1, sessionId: owner, token: data.token, baseline: saved,
        ...(record(data.source) ? { source: { sourceId: String(data.source.sourceId), token: data.token } } : {}),
      };
    }
  }

  async function retireIntent(ref: IntentRef) {
    const saved = await readIntent(ref);
    if (!saved) return;
    // Token-addressed files prevent old cleanup from deleting a newer intent.
    if (!saved.resolved) await atomicJson(intentPath(ref), { ...saved, resolved: true });
    await removeOwnedFile(intentPath(ref));
  }

  async function persistHandoff(ctx: Context, owner: string, epoch: number) {
    requireCurrent(ctx, owner, epoch);
    if (!pendingHandoff) return;
    const session = hostSession(ctx, owner);
    const saved = pendingHandoff;
    if (latestHandoff(ctx, owner)?.token !== saved.token) session.sessionManager.appendCustomEntry(HANDOFF, saved);
    await session.sessionManager.ensureOnDisk();
    requireCurrent(ctx, owner, epoch);
    await session.sessionManager.flush();
    requireCurrent(ctx, owner, epoch);
    if (saved.source) retiredIntents.set(saved.source.token, saved.source);
    pendingHandoff = undefined;
  }

  async function rejectUncertainInheritance(ctx: Context, owner: string, epoch: number) {
    const header = ctx.sessionManager.getHeader();
    if (!header?.parentSession) return;
    if (!path.isAbsolute(header.parentSession)) return;
    let parentFile: string;
    try { parentFile = await fs.realpath(header.parentSession); }
    catch (error) {
      if (record(error) && error.code === 'ENOENT') return;
      throw error;
    }
    // Public bounded header reader: no transcript traversal or parent-chain guessing.
    const parentId = await pi.pi.readSessionHeaderId(parentFile);
    requireCurrent(ctx, owner, epoch);
    if (!parentId) return;
    if (parentId === owner) throw new Error('OMP parent identity is invalid; recovery blocked');
    const intents = await readSourceIntents(parentId);
    requireCurrent(ctx, owner, epoch);
    for (const intent of intents) {
      if (intent.resolved) continue;
      if (intent.sourceFile !== parentFile) throw new Error('OMP parent intent path changed; recovery blocked');
      const created = Date.parse(header.timestamp);
      if (!Number.isFinite(created)) throw new Error('OMP child creation time cannot be verified; recovery blocked');
      if (created >= Date.parse(intent.confirmed ? intent.startedAt! : intent.createdAt)) {
        throw new Error('OMP inherited recovery is ambiguous: child handoff was not confirmed. Source baseline retained; resume source, use off, then create a fresh session.');
      }
    }
  }

  async function finishRestore(ctx: Context, owner: string, epoch: number) {
    if (!baseline) return;
    if (!baseline.restored) {
      const session = hostSession(ctx, owner);
      if (baseline.handoff) {
        const latest = latestHandoff(ctx, owner);
        if (!latest || latest.token !== baseline.handoff) throw new Error('OMP handoff generation changed; recovery baseline retained');
        if (latest.baseline !== null) session.sessionManager.appendCustomEntry(HANDOFF, { ...latest, baseline: null });
      }
      // Lazy sessions must materialize the restored state; no-session managers
      // deliberately make both calls no-ops. flush drains backing stores and
      // surfaces the append failures which model/tier setters only latch.
      await session.sessionManager.ensureOnDisk();
      requireCurrent(ctx, owner, epoch, true);
      await session.sessionManager.flush();
      requireCurrent(ctx, owner, epoch, true);
      baseline = { ...baseline, restored: true };
      baselineDurable = false;
    }
    // A failed unlink must not turn a completed OFF into a stale restore on
    // the next tick or cold resume, nor poison the next mode's baseline.
    await persistBaseline(ctx, owner, epoch);
    await removeOwnedFile(baselinePath(owner));
    requireCurrent(ctx, owner, epoch);
    baseline = undefined;
    baselineDurable = false;
    restored = false;
    appliedMode = 'off';
    appliedRevision = '';
    appliedPolicy = undefined;
  }

  function restoreSettings(fromPersistedBaseline = false) {
    if (!baseline || (!owned && !fromPersistedBaseline)) return;
    for (const key of KEYS) {
      const handle = HANDLES[key];
      if (!handle) throw new Error(`Missing OMP setting: ${key}`);
      const saved = baseline.settings[key];
      if (saved.runtime) handle.override(pi.pi.settings, saved.value);
      else handle.clearOverride(pi.pi.settings);
    }
    owned = false;
    routingRevision = '';
    routingMode = 'off';
    routingPolicy = undefined;
  }

  function restoreTiers() {
    if (!baseline) return;
    for (const family of ['openai', 'anthropic', 'google'] as const) {
      const tier = baseline.tiers[family];
      pi.setServiceTier(family, tier === 'none' ? undefined : tier);
    }
  }

  async function loadBaseline(ctx: Context, owner: string, epoch: number): Promise<void> {
    if (baseline) return;
    let saved: Baseline | undefined;
    try { saved = parseBaseline(JSON.parse(await fs.readFile(baselinePath(owner), 'utf8')), owner); }
    catch (error) {
      if (!(record(error) && error.code === 'ENOENT')) throw error;
    }
    requireCurrent(ctx, owner, epoch);
    const handoff = latestHandoff(ctx, owner);
    if (handoff?.source) retiredIntents.set(handoff.source.token, handoff.source);
    if (saved) {
      if (saved.handoff && (!handoff || handoff.token !== saved.handoff)) throw new Error('OMP inherited baseline has no matching host handoff; recovery blocked');
      baseline = saved;
      baselineDurable = true;
      if (saved.handoff && handoff?.baseline === null) restored = true;
    } else if (handoff?.baseline) {
      baseline = handoff.baseline;
      baselineDurable = false;
    } else if (!handoff) {
      await rejectUncertainInheritance(ctx, owner, epoch);
    }
  }

  async function persistBaseline(ctx: Context, owner: string, epoch: number): Promise<void> {
    if (!baseline || baselineDurable) return;
    await atomicJson(baselinePath(owner), baseline);
    requireCurrent(ctx, owner, epoch);
    baselineDurable = true;
  }

  async function saveBaseline(ctx: Context, owner: string, epoch: number): Promise<void> {
    if (!baseline) {
      const model = ctx.models.current();
      if (!model) throw new Error('Cannot capture a session without a main model');
      const thinking = hostSession(ctx, owner).configuredThinkingLevel() ?? null;
      const captures: Partial<Record<SettingKey, Capture>> = {};
      for (const key of KEYS) {
        const handle = HANDLES[key];
        if (!handle) throw new Error(`Missing OMP setting: ${key}`);
        const runtime = handle.provenance(pi.pi.settings) === 'runtime';
        captures[key] = { runtime, value: runtime ? structuredClone(handle.get(pi.pi.settings)) : null };
      }
      baseline = parseBaseline({
        version: 1, sessionId: owner, model: { provider: model.provider, id: model.id },
        thinking, tiers: pi.getServiceTiers(), settings: captures,
      }, owner);
      baselineDurable = false;
    }
    await persistBaseline(ctx, owner, epoch);
  }

  function applyRouting(policy: Policy) {
    if (!baseline) throw new Error('Missing baseline before routing update');
    const patches: Record<SettingKey, unknown> = {
      modelRoles: policy.roles,
      'task.agentModelOverrides': policy.agentModels,
      'tier.subagent': 'none',
      'task.agentServiceTierOverrides': policy.agentTiers,
    };
    const previous: Partial<Record<SettingKey, Capture>> = {};
    for (const key of KEYS) {
      const handle = HANDLES[key];
      if (!handle) throw new Error(`Missing OMP setting: ${key}`);
      const runtime = handle.provenance(pi.pi.settings) === 'runtime';
      previous[key] = { runtime, value: runtime ? structuredClone(handle.get(pi.pi.settings)) : null };
    }
    const wasOwned = owned;
    // Ownership starts before mutation so even an unsuccessful rollback remains recoverable by OFF.
    owned = true;
    try {
      for (const key of KEYS) {
        const handle = HANDLES[key]!;
        const capture = baseline.settings[key];
        const patch = patches[key];
        const value = capture.runtime && record(capture.value) && record(patch)
          ? { ...capture.value, ...patch } : patch;
        handle.override(pi.pi.settings, value);
      }
    } catch (error) {
      let rollbackError: unknown;
      for (const key of KEYS) {
        try {
          const saved = previous[key]!;
          if (saved.runtime) HANDLES[key]!.override(pi.pi.settings, saved.value);
          else HANDLES[key]!.clearOverride(pi.pi.settings);
        } catch (failure) { rollbackError ??= failure; }
      }
      if (rollbackError) {
        routingPolicy = undefined;
        routingRevision = '';
        throw new Error(`Routing update failed (${String(error)}); rollback failed (${String(rollbackError)}). Use off to restore the saved baseline.`);
      }
      owned = wasOwned;
      throw error;
    }
    routingRevision = requested.revision;
    routingMode = requested.mode;
    routingPolicy = policy;
  }

  function availableMain(ctx: Context, modelId: { provider: string; id: string }) {
    const name = `${modelId.provider}/${modelId.id}`;
    const model = ctx.modelRegistry.find(modelId.provider, modelId.id);
    if (!model) throw new Error(`Model unavailable: ${name}. Configure this model in OMP or edit policies.json and reissue the mode.`);
    // The documented read-only facade lists authenticated models without selecting one.
    if (!ctx.models.list().some(candidate => candidate.provider === modelId.provider && candidate.id === modelId.id)) {
      throw new Error(`No credentials for ${name}. Authenticate this provider in OMP, then reissue the mode; off remains available.`);
    }
    return model;
  }

  async function selectMain(ctx: Context, modelId: { provider: string; id: string }, thinking: Selector, owner: string, epoch: number, attempt?: TransitionAttempt) {
    if (attempt) requireAttempt(ctx, attempt);
    else requireCurrent(ctx, owner, epoch, true);
    const model = availableMain(ctx, modelId);
    if (!await pi.setModel(model)) throw new Error(`No credentials for ${modelId.provider}/${modelId.id}; authenticate in OMP and retry, or use off.`);
    if (attempt) requireAttempt(ctx, attempt);
    else requireCurrent(ctx, owner, epoch, true);
    const session = hostSession(ctx, owner);
    session.setThinkingLevel(thinking ?? undefined);
    if ((session.configuredThinkingLevel() ?? null) !== thinking) throw new Error(`OMP did not retain configured thinking ${thinking ?? 'unset'}; baseline retained`);
    const actual = ctx.models.current();
    if (actual?.provider !== modelId.provider || actual.id !== modelId.id) throw new Error('OMP did not retain requested model; baseline retained');
  }

  async function publish(ctx: Context, force = false) {
    const owner = sessionId;
    const epoch = generation;
    if (!current(ctx, owner, epoch)) return;
    for (const [token, ref] of retiredIntents) {
      try { await retireIntent(ref); retiredIntents.delete(token); }
      catch (error) {
        if (!current(ctx, owner, epoch)) return;
        status = 'error';
        lastError = `OMP handoff cleanup failed; current session remains controllable: ${error instanceof Error ? error.message : String(error)}`.replace(/[\r\n\t]/g, ' ').slice(0, 240);
      }
      if (!current(ctx, owner, epoch)) return;
    }
    // A stale heartbeat must not stop a committed session from attaching or
    // restoring. Retry it independently and keep aggregation honest meanwhile.
    for (const file of retiredClients) {
      try {
        await removeOwnedFile(file);
        retiredClients.delete(file);
      } catch (error) {
        if (!current(ctx, owner, epoch)) return;
        status = 'error';
        lastError = `Stale OMP client cleanup failed; current session remains controllable: ${error instanceof Error ? error.message : String(error)}`.replace(/[\r\n\t]/g, ' ').slice(0, 240);
      }
      if (!current(ctx, owner, epoch)) return;
    }
    const model = ctx.models.current();
    const row = {
      version: 1, pid: process.pid, sessionId: owner, cwd: ctx.cwd,
      host: 'omp', capabilities: { routing: true, priority: true },
      revision: requested.revision, requestedMode: requested.mode, appliedMode, status,
      appliedRevision, routingMode, routingRevision,
      model: model ? `${model.provider}/${model.id}` : 'unknown',
      thinking: String(pi.getThinkingLevel()), tier: pi.getServiceTiers().openai ?? 'none',
      ...(lastError ? { error: lastError } : {}),
    };
    const signature = JSON.stringify(row);
    const now = Date.now();
    if (force || signature !== publishedSignature || now - publishedAt >= 5000) {
      await atomicJson(clientPath(owner), { ...row, updatedAt: new Date(now).toISOString() });
      if (!current(ctx, owner, epoch)) return;
      publishedSignature = signature;
      publishedAt = now;
    }
    ctx.ui.setStatus('tibo-rush', requested.mode === 'off' && status === 'applied' ? undefined :
      `tibo-rush requested ${requested.mode} · ${status} · routing ${routingPolicy ? routingMode : owned ? 'unknown' : 'baseline'} · main ${row.model}${lastError ? `: ${lastError}` : ''}`);
  }

  async function reconcile(ctx: Context, owner: string, epoch: number) {
    if (ctx.agent.kind !== 'main' || !current(ctx, owner, epoch)) return;
    let session: AgentSession | undefined;
    try {
      const state = await readState();
      if (!current(ctx, owner, epoch)) return;
      requested = state;
      session = hostSession(ctx, owner);
      if (session.isSessionTransitioning || transition?.pending) {
        status = 'pending';
        await publish(ctx);
        return;
      }
      // Same owner after a settled transition means a later hook vetoed it.
      if (pendingIntent?.sourceId === owner) {
        retiredIntents.set(pendingIntent.token, pendingIntent);
        pendingIntent = undefined;
      }
      await persistHandoff(ctx, owner, epoch);
      await loadBaseline(ctx, owner, epoch);
      requireCurrent(ctx, owner, epoch);
      lastError = undefined;
      if (baseline && (baseline.restored || restored)) await finishRestore(ctx, owner, epoch);
      if (policyRevision !== requested.revision) {
        policyRevision = requested.revision;
        policyError = undefined;
        try { requestedPolicy = await policyFor(requested.mode); }
        catch (error) { requestedPolicy = null; policyError = error; }
        requireCurrent(ctx, owner, epoch, true);
      }
      if (policyError) throw policyError;
      const policy = requestedPolicy;
      if (!policy) {
        if (baseline) {
          if (!ctx.isIdle()) {
            status = 'pending';
          } else {
            await persistBaseline(ctx, owner, epoch);
            await selectMain(ctx, baseline.model, baseline.thinking, owner, epoch);
            restoreTiers();
            restoreSettings(true);
            restored = true;
            await finishRestore(ctx, owner, epoch);
            appliedRevision = requested.revision;
            status = 'applied';
          }
        } else {
          appliedMode = 'off';
          appliedRevision = requested.revision;
          appliedPolicy = undefined;
          status = 'applied';
        }
      } else {
        if (appliedRevision !== requested.revision || routingRevision !== requested.revision) availableMain(ctx, policy.main);
        await saveBaseline(ctx, owner, epoch);
        requireCurrent(ctx, owner, epoch, true);
        if (!ctx.isIdle() && appliedRevision !== requested.revision) {
          if (routingRevision !== requested.revision) applyRouting(policy);
          status = 'pending';
        } else {
          if (appliedRevision !== requested.revision) {
            await selectMain(ctx, policy.main, policy.main.thinking, owner, epoch);
            pi.setServiceTier('openai', policy.tier);
          }
          if (routingRevision !== requested.revision) applyRouting(policy);
          const actual = ctx.models.current();
          if (actual?.provider !== policy.main.provider || actual.id !== policy.main.id ||
              hostSession(ctx, owner).configuredThinkingLevel() !== policy.main.thinking ||
              (policy.main.thinking !== 'auto' && pi.getThinkingLevel() !== policy.main.thinking) ||
              pi.getServiceTiers().openai !== policy.tier) {
            throw new Error('Main model/thinking/tier changed outside Tibo Rush; user choice left unchanged. Reissue a mode or use off.');
          }
          appliedMode = requested.mode;
          appliedRevision = requested.revision;
          appliedPolicy = policy;
          status = 'applied';
        }
      }
    } catch (error) {
      if (!current(ctx, owner, epoch)) return;
      status = session?.isSessionTransitioning ? 'pending' : 'error';
      lastError = status === 'pending' ? undefined : (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]/g, ' ').slice(0, 240);
    }
    if (current(ctx, owner, epoch)) await publish(ctx);
  }

  function enqueue(ctx: Context): Promise<void> {
    const owner = sessionId;
    const epoch = generation;
    serial = serial.then(() => reconcile(ctx, owner, epoch)).catch(error => {
      if (!current(ctx, owner, epoch)) return;
      status = 'error';
      lastError = String(error).replace(/[\r\n\t]/g, ' ').slice(0, 240);
      ctx.ui.setStatus('tibo-rush', `tibo-rush error: ${lastError}`);
    });
    return serial;
  }

  async function prepareTransition(ctx: Context, fresh: boolean, attempt: TransitionAttempt) {
    const { owner, epoch } = attempt;
    await serial;
    try {
      const session = hostSession(ctx, owner);
      requireAttempt(ctx, attempt);
      if (pendingIntent?.sourceId === owner) {
        await retireIntent(pendingIntent); // A previous attempt was vetoed.
        requireAttempt(ctx, attempt);
        pendingIntent = undefined;
      }
      await loadBaseline(ctx, owner, epoch);
      requireAttempt(ctx, attempt);
      if (fresh) {
        if (!baseline || baseline.restored) return;
        if (!ctx.isIdle()) throw new Error('Use off or wait until idle before /new while Tibo Rush owns the session');
        // /new has no ancestry. Make what it inherits naturally original before
        // the commit, retaining ownership and the baseline if a later hook vetoes.
        appliedRevision = '';
        routingRevision = '';
        appliedPolicy = undefined;
        status = 'pending';
        if (!restored) {
          await persistBaseline(ctx, owner, epoch);
          requireAttempt(ctx, attempt);
          await selectMain(ctx, baseline.model, baseline.thinking, owner, epoch, attempt);
          requireAttempt(ctx, attempt);
          restoreTiers();
          restoreSettings(true);
        }
        await session.sessionManager.ensureOnDisk();
        requireAttempt(ctx, attempt);
        await session.sessionManager.flush();
        requireAttempt(ctx, attempt);
        return;
      }
      const oldIntents = await readSourceIntents(owner);
      requireAttempt(ctx, attempt);
      if (oldIntents.some(intent => !intent.resolved)) throw new Error('An earlier OMP inherited handoff remains unresolved; recover it or use off and create a fresh session');
      for (const intent of oldIntents) retiredIntents.set(intent.token, intent);
      if (!baseline || baseline.restored || restored) return;
      await persistBaseline(ctx, owner, epoch);
      requireAttempt(ctx, attempt);
      await session.sessionManager.ensureOnDisk();
      requireAttempt(ctx, attempt);
      const sourceFile = session.sessionManager.getSessionFile();
      if (!sourceFile) return; // No cold state exists for an in-memory root.
      const canonical = await fs.realpath(sourceFile);
      requireAttempt(ctx, attempt);
      pendingIntent = { version: 1, sourceId: owner, sourceFile: canonical, token: randomUUID(), createdAt: new Date().toISOString() };
      await atomicJson(intentPath(pendingIntent), pendingIntent);
      requireAttempt(ctx, attempt);
      const entryId = session.sessionManager.appendCustomEntry(INTENT, pendingIntent);
      const entry = session.sessionManager.getEntry(entryId);
      if (!entry) throw new Error('OMP did not retain the transition intent');
      await session.sessionManager.flush();
      requireAttempt(ctx, attempt);
      pendingIntent = { ...pendingIntent, entryId, startedAt: entry.timestamp, confirmed: true };
      await atomicJson(intentPath(pendingIntent), pendingIntent);
      requireAttempt(ctx, attempt);
    } catch (error) {
      // Timed-out hooks may finish after OMP has already committed. Never
      // erase source proof or change the new owner's status in that case.
      if (!attempt.valid || !current(ctx, owner, epoch)) return { cancel: true };
      // Retire only after the transition settles on this owner, not merely
      // when requesting cancellation: OMP may have already timed out the hook.
      status = 'error';
      lastError = `OMP transition preparation failed; cancellation requested: ${error instanceof Error ? error.message : String(error)}`.replace(/[\r\n\t]/g, ' ').slice(0, 240);
      ctx.ui.notify(lastError, 'warning');
      // Ordinary extension-hook exceptions are swallowed by OMP, not vetoes.
      return { cancel: true };
    }
  }

  async function beginTransition(event: object, ctx: Context, kind: TransitionKind) {
    if (ctx.agent.kind !== 'main') return;
    // A native model setter cannot be cancelled mid-await. Keep its original
    // owner attached until it settles; no later transition may pass this lease.
    if (transition?.pending) {
      ctx.ui.notify('OMP transition cancelled: previous preparation is still settling; original baseline retained. Wait and retry.', 'warning');
      return { cancel: true };
    }
    const attempt: TransitionAttempt = {
      event, kind, owner: sessionId, epoch: generation, valid: true, pending: true, ready: false,
    };
    transition = attempt;
    try {
      let result: { cancel: boolean } | undefined;
      if (kind === 'resume') {
        await serial;
        requireAttempt(ctx, attempt);
      } else result = await prepareTransition(ctx, kind === 'new', attempt);
      if (!result?.cancel) {
        requireAttempt(ctx, attempt);
        attempt.ready = true;
      }
      return result;
    } catch {
      attempt.valid = false;
      return { cancel: true };
    } finally {
      attempt.pending = false;
    }
  }

  function commitGate(event: object, ctx: Context) {
    if (ctx.agent.kind !== 'main') return;
    const attempt = transition;
    if (attempt?.event === event && attempt.ready && !attempt.pending && attempt.valid &&
        current(ctx, attempt.owner, attempt.epoch)) return;
    if (attempt?.event === event) {
      attempt.valid = false;
      attempt.ready = false;
    }
    status = 'error';
    lastError = 'OMP transition cancelled: preparation did not complete before the host deadline. Original session and baseline retained; wait for preparation to settle, then retry or use off.';
    ctx.ui.notify(lastError, 'warning');
    return { cancel: true };
  }

  async function attach(ctx: Context, inherits = false, fresh = false) {
    if (ctx.agent.kind !== 'main') return;
    const previous = sessionId;
    const next = ctx.sessionManager.getSessionId();
    const preparedFresh = fresh && transition?.kind === 'new' && transition.ready && !transition.pending &&
      transition.valid && transition.owner === previous && transition.epoch === generation;
    if (transition) transition.valid = false;
    stopped = true;
    const epoch = ++generation;
    stopTimer?.();
    stopTimer = undefined;
    await serial;
    if (generation !== epoch || ctx.sessionManager.getSessionId() !== next) return;
    // The host has committed its new identity. Setters here would mutate the
    // NEW session, not the old one. Only process-wide routing needs release.
    const source = inherits && pendingIntent?.sourceId === previous ? pendingIntent : undefined;
    const token = source?.token ?? randomUUID();
    const inherited = (inherits || (fresh && !preparedFresh)) && baseline && !restored && !baseline.restored
      ? { ...baseline, sessionId: next, handoff: token } : undefined;
    restoreSettings();
    if (previous) retiredClients.add(clientPath(previous));
    stopped = false;
    context = ctx;
    sessionId = next;
    baseline = inherited;
    baselineDurable = false;
    pendingHandoff = inherits || fresh ? {
      version: 1, sessionId: next, token, baseline: inherited ?? null,
      ...(source ? { source: { sourceId: source.sourceId, token: source.token } } : {}),
    } : undefined;
    pendingIntent = undefined;
    restored = false;
    owned = false;
    appliedMode = 'off';
    appliedRevision = '';
    routingRevision = '';
    routingMode = 'off';
    routingPolicy = undefined;
    appliedPolicy = undefined;
    policyRevision = '';
    requestedPolicy = null;
    policyError = undefined;
    publishedSignature = '';
    publishedAt = 0;
    // First put an exact, child-bound recovery copy in the independent host
    // journal. A failure writing shared baselines must remain cold-recoverable.
    try {
      await persistHandoff(ctx, next, epoch);
      if (baseline) await persistBaseline(ctx, next, epoch);
      await enqueue(ctx);
    } catch (error) {
      if (!current(ctx, next, epoch)) return;
      status = 'error';
      lastError = `OMP handoff incomplete; original baseline retained: ${error instanceof Error ? error.message : String(error)}`.replace(/[\r\n\t]/g, ' ').slice(0, 240);
      await publish(ctx);
    } finally {
      // Keep recovery reachable if persisting the inherited baseline failed.
      if (current(ctx, next, epoch)) {
        const timer = ctx.setInterval(() => { if (context) void enqueue(context); }, 850);
        stopTimer = () => ctx.clearTimer(timer);
      }
    }
  }

  async function detach(ctx: Context) {
    if (ctx.agent.kind !== 'main') return;
    const owner = sessionId;
    if (transition) transition.valid = false;
    stopped = true;
    generation++;
    stopTimer?.();
    stopTimer = undefined;
    await serial;
    restoreSettings();
    await removeOwnedFile(clientPath(owner));
    // Keep the baseline until OFF actually restores this session, including across a cold resume.
    context = undefined;
    baseline = undefined;
  }

  pi.on('session_start', async (_event: unknown, ctx: Context) => { await attach(ctx); });
  // Vetoes leave attachment intact. /new is reversibly restored before commit
  // because its fresh journal has no parent pointer; inherited cuts get intents.
  // SDK loader appends handlers; runner gives each its own timeout and stops
  // on explicit cancellation. Keep this synchronous gate AFTER preparation:
  // a timed-out async hook otherwise returns undefined and OMP would commit.
  pi.on('session_before_switch', async (event, ctx) =>
    beginTransition(event, ctx, event.reason === 'new' ? 'new' : event.reason === 'resume' ? 'resume' : 'inherit'));
  pi.on('session_before_switch', (event, ctx) => commitGate(event, ctx));
  pi.on('session_before_branch', async (event, ctx) => beginTransition(event, ctx, 'inherit'));
  pi.on('session_before_branch', (event, ctx) => commitGate(event, ctx));
  pi.on('session_switch', async (event, ctx) => { await attach(ctx, event.reason === 'fork', event.reason === 'new'); });
  pi.on('session_branch', async (_event, ctx) => { await attach(ctx, true); });
  pi.on('session_shutdown', async (_event: unknown, ctx: Context) => { await detach(ctx); });
  pi.on('agent_end', async (_event: unknown, ctx: Context) => {
    if (ctx.agent.kind === 'main') { context = ctx; await enqueue(ctx); }
  });
  pi.on('before_agent_start', async (event: { systemPrompt: string[] }, ctx: Context) => {
    if (ctx.agent.kind !== 'main') return;
    context = ctx;
    await enqueue(ctx);
    // Reconcile owns the revision-bound snapshots; never re-read a requested policy into the prompt.
    const prompt = event.systemPrompt.map(block => {
      const start = block.indexOf(MARKER);
      if (start < 0) return block;
      const end = block.indexOf(END_MARKER, start);
      return block.slice(0, start) + (end < 0 ? '' : block.slice(end + END_MARKER.length));
    }).filter(block => block.trim());
    if (routingPolicy || baseline || status === 'error') {
      const model = ctx.models.current();
      const details = [
        `request: ${requested.mode}; status: ${status}${lastError ? `; error: ${lastError}` : ''}`,
        `actual main: ${model ? `${model.provider}/${model.id}` : 'unknown'}:${pi.getThinkingLevel()}`,
        `actual service tiers: ${JSON.stringify(pi.getServiceTiers())}`,
        routingPolicy
          ? `applied routing: ${routingMode} (revision ${routingRevision})\nroles: ${JSON.stringify(routingPolicy.roles)}\nagentModels: ${JSON.stringify(routingPolicy.agentModels)}\nagentTiers: ${JSON.stringify(routingPolicy.agentTiers)}`
          : owned ? 'Routing is partially changed; use off to restore the saved baseline.' : 'Routing: baseline settings (no policy routing applied).',
        'Search-tool routing and configured fallback chains are unchanged by this extension.',
      ];
      if (appliedPolicy && appliedRevision === routingRevision &&
          model?.provider === appliedPolicy.main.provider && model.id === appliedPolicy.main.id &&
          hostSession(ctx).configuredThinkingLevel() === appliedPolicy.main.thinking && pi.getServiceTiers().openai === appliedPolicy.tier && status === 'applied') {
        details.push(`Applied policy instruction:\n${appliedPolicy.instruction}`);
      } else if (status === 'pending') details.push('Routing and main are separate: main model/thinking/tier changes or OFF restoration wait until idle; do not describe them as applied.');
      prompt.push(`${MARKER}\n${details.join('\n')}\n${END_MARKER}`);
    }
    return { systemPrompt: prompt };
  });
  pi.registerCommand('tibo-rush', {
    description: 'Global Tibo Rush configurable presets: regular | fast | extreme | off | status',
    getArgumentCompletions: getCommandCompletions,
    handler: async (args: string, ctx: Context) => {
      if (ctx.agent.kind !== 'main') throw new Error('tibo-rush is a main-session command');
      const mode = args.trim() || 'status';
      if (mode === 'status') {
        const state = await readState();
        const clients = await listClients();
        const model = ctx.models.current();
        ctx.ui.notify(`tibo-rush requested ${state.mode} · ${clients.length} live sessions; this session ${status}, routing ${routingPolicy ? routingMode : owned ? 'unknown' : 'baseline'}, main ${model ? `${model.provider}/${model.id}` : 'unknown'}${lastError ? `; ${lastError}` : ''}. Run /tibo-rush status in each session to inspect its applied state.`, lastError ? 'warning' : 'info');
        return;
      }
      if (!MODES.includes(mode)) throw new Error('Use regular, fast, extreme, off or status');
      await setMode(mode);
      context = ctx;
      await enqueue(ctx);
      ctx.ui.notify(status === 'error' ? `Requested ${mode}, but this session failed: ${lastError}. Use off to restore.` : `Requested global tibo-rush ${mode}; this session ${status}${status === 'pending' ? mode === 'off' ? ' (existing routing retained; restoration waits until idle)' : ' (routing applied; main waits until idle)' : ''}.`, status === 'error' ? 'warning' : 'info');
    },
  });
}
