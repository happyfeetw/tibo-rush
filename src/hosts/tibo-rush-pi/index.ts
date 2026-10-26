import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel as Thinking } from '@earendil-works/pi-agent-core';
import { atomicJson, getHome, listClients, MODES, policyFor, readState, setMode } from '../../core/lib.mjs';
import { getCommandCompletions } from '../../core/commands.mjs';
import type { RushMode, RushPolicy, RushState } from '../../core/types';

type Model = NonNullable<ExtensionContext['model']>;
type Baseline = {
  version: 1; sessionId: string; model: { provider: string; id: string }; thinking: Thinking;
};
type Attachment = { ctx: ExtensionContext; sessionId: string; active: boolean };
const THINKING: Record<string, true> = { off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };
const MARKER = '<tibo-rush-policy>';
const END_MARKER = '</tibo-rush-policy>';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]/g, ' ').slice(0, 360);
}
function parseBaseline(value: unknown, sessionId: string): Baseline {
  if (!record(value) || value.version !== 1 || value.sessionId !== sessionId ||
      !record(value.model) || typeof value.model.provider !== 'string' || !value.model.provider ||
      typeof value.model.id !== 'string' || !value.model.id ||
      typeof value.thinking !== 'string' || !Object.hasOwn(THINKING, value.thinking)) {
    throw new Error('Invalid Pi tibo-rush baseline; refusing to overwrite it. Repair the saved baseline before retrying OFF.');
  }
  return value as unknown as Baseline;
}
function hash(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}
function baselinePath(sessionId: string): string {
  return path.join(getHome(), 'baselines', 'pi', `${hash(sessionId)}.json`);
}
function clientPath(sessionId: string): string {
  return path.join(getHome(), 'clients', `pi-${process.pid}-${hash(sessionId).slice(0, 16)}.json`);
}
async function removeOwnedFile(file: string): Promise<void> {
  try { await fs.unlink(file); }
  catch (error) { if (!(record(error) && error.code === 'ENOENT')) throw error; }
}
// Pi's native Codex API invokes onPayload before both SSE and WebSocket transports,
// and serializes service_tier unchanged. Do not apply that wire format to other APIs
// or arbitrary compatible endpoints. This requests priority; server acceptance is not guaranteed.
function supportsPriority(model: Model | undefined): boolean {
  if (model?.provider !== 'openai-codex' || model.api !== 'openai-codex-responses') return false;
  return model.baseUrl?.replace(/\/$/, '') === 'https://chatgpt.com/backend-api';
}
function stripPolicy(prompt: string): string {
  let result = prompt;
  for (;;) {
    const start = result.indexOf(MARKER);
    if (start < 0) return result.trimEnd();
    const end = result.indexOf(END_MARKER, start);
    result = result.slice(0, start) + (end < 0 ? '' : result.slice(end + END_MARKER.length));
  }
}

export default function tiboRush(pi: ExtensionAPI) {
  let attachment: Attachment | undefined;
  let timer: NodeJS.Timeout | undefined;
  let serial: Promise<void> = Promise.resolve();
  let baseline: Baseline | undefined;
  let requested: RushState = { version: 1, mode: 'off', revision: 'initial', updatedAt: new Date(0).toISOString() };
  let policyRevision = '';
  let requestedPolicy: RushPolicy | null = null;
  let policyError: unknown;
  let appliedMode: RushMode = 'off';
  let appliedRevision = '';
  let appliedPolicy: RushPolicy | undefined;
  let tier: 'default' | 'priority' | undefined;
  let transitionFailure: { revision: string; error: string } | undefined;
  let hookFailure: { revision: string; error: string } | undefined;
  let status: 'applied' | 'pending' | 'error' = 'applied';
  let lastError: string | undefined;
  let publishedSignature = '';
  let publishedAt = 0;

  function current(owner: Attachment): boolean {
    return owner.active && attachment === owner && owner.ctx.sessionManager.getSessionId() === owner.sessionId;
  }
  function failTransition(error: unknown): void {
    status = 'error';
    lastError = message(error);
    transitionFailure = { revision: requested.revision, error: lastError };
  }
  function availableMain(ctx: ExtensionContext, target: { provider: string; id: string }): Model {
    const name = `${target.provider}/${target.id}`;
    const model = ctx.modelRegistry.find(target.provider, target.id);
    if (!model) throw new Error(`Model unavailable: ${name}. Configure it in Pi or edit policies.json, then reissue the mode.`);
    // Snapshot-only checks: never refresh the catalogue or resolve/refresh credentials here.
    if (!ctx.modelRegistry.getAvailable().some(candidate => candidate.provider === target.provider && candidate.id === target.id)) {
      throw new Error(`No configured credentials for ${name}. Authenticate in Pi, then reissue the mode; OFF remains available.`);
    }
    return model;
  }
  async function loadBaseline(owner: Attachment): Promise<void> {
    if (baseline) return;
    try {
      const saved = parseBaseline(JSON.parse(await fs.readFile(baselinePath(owner.sessionId), 'utf8')), owner.sessionId);
      if (current(owner)) baseline = saved;
    } catch (error) {
      if (!(record(error) && error.code === 'ENOENT')) throw error;
    }
  }
  async function saveBaseline(owner: Attachment): Promise<void> {
    await loadBaseline(owner);
    if (!current(owner) || baseline) return;
    const model = owner.ctx.model;
    if (!model) throw new Error('Cannot capture a Pi session without a main model');
    const saved = parseBaseline({
      version: 1, sessionId: owner.sessionId,
      model: { provider: model.provider, id: model.id }, thinking: pi.getThinkingLevel(),
    }, owner.sessionId);
    // No host mutation is allowed before this atomic persistence completes.
    await atomicJson(baselinePath(owner.sessionId), saved);
    if (current(owner)) baseline = saved;
  }
  async function selectMain(owner: Attachment, model: Model, thinking: Thinking): Promise<boolean> {
    if (!current(owner) || !owner.ctx.isIdle()) return false;
    if (!await pi.setModel(model)) throw new Error(`Pi could not select ${model.provider}/${model.id}: credentials are not configured. Reissue the mode after authenticating.`);
    if (!current(owner)) return false;
    if (!owner.ctx.isIdle()) throw new Error('Pi became busy during model selection; thinking and priority were not changed. Reissue the mode while idle or use OFF.');
    pi.setThinkingLevel(thinking);
    const actual = pi.getThinkingLevel();
    if (actual !== thinking) throw new Error(`Pi clamped thinking from ${thinking} to ${actual}; the requested policy is not applied. Choose a supported thinking level and reissue, or use OFF.`);
    if (owner.ctx.model?.provider !== model.provider || owner.ctx.model.id !== model.id) {
      throw new Error(`Pi did not retain the requested model ${model.provider}/${model.id}; use OFF or reissue the mode.`);
    }
    return true;
  }
  async function publish(owner: Attachment, force = false): Promise<void> {
    if (!current(owner)) return;
    const ctx = owner.ctx;
    const row = {
      version: 1, host: 'pi', pid: process.pid, sessionId: owner.sessionId, cwd: ctx.cwd,
      revision: requested.revision, requestedMode: requested.mode, appliedMode, appliedRevision, status,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'unknown',
      thinking: String(pi.getThinkingLevel()), tier: tier ?? 'none',
      capabilities: { routing: false, priority: supportsPriority(ctx.model) },
      ...(lastError ? { error: lastError } : {}),
    };
    const signature = JSON.stringify(row);
    const now = Date.now();
    if (force || signature !== publishedSignature || now - publishedAt >= 5000) {
      await atomicJson(clientPath(owner.sessionId), { ...row, updatedAt: new Date(now).toISOString() });
      if (!current(owner)) return;
      publishedSignature = signature;
      publishedAt = now;
    }
    ctx.ui.setStatus('tibo-rush', requested.mode === 'off' && status === 'applied' ? undefined :
      `tibo-rush ${requested.mode} · ${status} · main ${row.model}:${row.thinking} · tier ${row.tier} · no role routing${lastError ? `: ${lastError}` : ''}`);
  }
  async function reconcile(owner: Attachment): Promise<void> {
    if (!current(owner)) return;
    try {
      const state = await readState();
      if (!current(owner)) return;
      requested = state;
      if (transitionFailure?.revision !== state.revision) transitionFailure = undefined;
      lastError = transitionFailure?.error ??
        (hookFailure?.revision === appliedRevision ? hookFailure.error : undefined);
      await loadBaseline(owner);
      if (!current(owner)) return;
      // OFF must work with corrupt/missing policy configuration, including cold resume.
      if (requested.mode === 'off') {
        if (transitionFailure?.revision === requested.revision) { await publish(owner); return; }
        if (!owner.ctx.isIdle()) {
          status = baseline || tier || appliedMode !== 'off' ? 'pending' : 'applied';
        } else {
          // Disable only at an idle boundary: no in-flight request changes tier.
          tier = undefined;
          appliedPolicy = undefined;
          if (baseline) {
            const saved = baseline;
            const model = availableMain(owner.ctx, saved.model);
            if (!await selectMain(owner, model, saved.thinking)) {
              if (current(owner)) status = 'pending';
              return;
            }
            if (!current(owner)) return;
            await removeOwnedFile(baselinePath(owner.sessionId));
            baseline = undefined;
          }
          appliedMode = 'off';
          appliedRevision = requested.revision;
          hookFailure = undefined;
          lastError = undefined;
          status = 'applied';
        }
      } else {
        if (policyRevision !== requested.revision) {
          policyRevision = requested.revision;
          policyError = undefined;
          try { requestedPolicy = await policyFor(requested.mode); }
          catch (error) { requestedPolicy = null; policyError = error; }
          if (!current(owner)) return;
        }
        if (policyError) throw policyError;
        if (!requestedPolicy) throw new Error('No active Pi policy was returned');
        if (transitionFailure?.revision === requested.revision) { await publish(owner); return; }
        const policy = requestedPolicy;
        const model = availableMain(owner.ctx, policy.main);
        if (!Object.hasOwn(THINKING, policy.main.thinking)) throw new Error(`Pi does not support thinking level ${policy.main.thinking}; edit policies.json and reissue the mode.`);
        if (policy.tier === 'priority' && !supportsPriority(model)) {
          throw new Error('Pi priority is unsupported for this model/API/endpoint. Extreme was not applied; use the native openai-codex-responses API at chatgpt.com/backend-api, or choose fast.');
        }
        if (appliedRevision !== requested.revision) {
          if (!owner.ctx.isIdle()) status = 'pending';
          else {
            await saveBaseline(owner);
            if (!current(owner)) return;
            if (!owner.ctx.isIdle()) status = 'pending';
            else if (await selectMain(owner, model, policy.main.thinking as Thinking)) {
              tier = supportsPriority(model) ? policy.tier : undefined;
              appliedPolicy = policy;
              appliedMode = requested.mode;
              appliedRevision = requested.revision;
              hookFailure = undefined;
              lastError = undefined;
              status = 'applied';
            } else if (current(owner)) status = 'pending';
          }
        } else if (owner.ctx.model?.provider !== policy.main.provider || owner.ctx.model.id !== policy.main.id ||
                   pi.getThinkingLevel() !== policy.main.thinking) {
          throw new Error('Pi main model/thinking changed after policy application; the requested policy is no longer applied. Reissue the mode or use OFF.');
        } else status = 'applied';
      }
      if (status === 'applied' && hookFailure?.revision === appliedRevision) status = 'error';
    } catch (error) { if (current(owner)) failTransition(error); }
    if (current(owner)) await publish(owner);
  }
  function enqueue(owner: Attachment): Promise<void> {
    serial = serial.then(() => reconcile(owner)).catch(async error => {
      if (!current(owner)) return;
      failTransition(error);
      owner.ctx.ui.setStatus('tibo-rush', `tibo-rush error: ${lastError}`);
      // A failed write must be retried by the next heartbeat, not become an unhandled rejection.
      try { await publish(owner, true); } catch { /* The footer still exposes persistence failure. */ }
    });
    return serial;
  }
  async function detach(): Promise<void> {
    const owner = attachment;
    if (!owner) return;
    owner.active = false;
    clearInterval(timer);
    timer = undefined;
    await serial;
    // Main model/thinking are session-persisted by Pi; retain the baseline until
    // OFF restores them. Reload/session replacement must not overwrite that capture.
    tier = undefined;
    await removeOwnedFile(clientPath(owner.sessionId));
    owner.ctx.ui.setStatus('tibo-rush', undefined);
    if (attachment === owner) attachment = undefined;
  }

  pi.on('session_start', async (_event, ctx) => {
    await detach();
    const owner: Attachment = { ctx, sessionId: ctx.sessionManager.getSessionId(), active: true };
    attachment = owner;
    baseline = undefined;
    requested = { version: 1, mode: 'off', revision: 'initial', updatedAt: new Date(0).toISOString() };
    policyRevision = '';
    requestedPolicy = null;
    policyError = undefined;
    appliedMode = 'off';
    appliedRevision = '';
    appliedPolicy = undefined;
    tier = undefined;
    transitionFailure = undefined;
    hookFailure = undefined;
    lastError = undefined;
    status = 'applied';
    publishedSignature = '';
    publishedAt = 0;
    await enqueue(owner);
    if (!current(owner)) return;
    timer = setInterval(() => { if (current(owner)) void enqueue(owner); }, 850);
    timer.unref?.();
  });
  pi.on('session_shutdown', async () => { await detach(); });
  pi.on('agent_settled', async (_event, ctx) => {
    const owner = attachment;
    if (owner && current(owner)) { owner.ctx = ctx; await enqueue(owner); }
  });
  pi.on('before_agent_start', async (event, ctx) => {
    const owner = attachment;
    if (!owner || !current(owner)) return;
    owner.ctx = ctx;
    await enqueue(owner);
    if (!current(owner)) return;
    const prompt = stripPolicy(event.systemPrompt);
    if (!baseline && requested.mode === 'off' && status === 'applied') return { systemPrompt: prompt };
    const details = [
      `Host: original Pi. Requested mode: ${requested.mode}; status: ${status}${lastError ? `; error: ${lastError}` : ''}.`,
      `Actual main: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'unknown'}; thinking: ${pi.getThinkingLevel()}.`,
      `Applied mode: ${appliedMode}; outgoing native Codex service_tier override: ${tier ?? 'none'}. Priority is a request, not a guarantee of server acceptance or latency.`,
      'Capabilities: main model/thinking switching only; native Codex priority payload hook where supported. No OMP role mapping, frontend routing, automatic subagents, agent model overrides, or subagent tier overrides are installed in Pi.',
    ];
    if (status === 'pending') details.push('Requested main/thinking/tier changes or OFF restoration are pending until Pi is idle; do not describe them as applied.');
    if (appliedPolicy && status === 'applied') details.push('Only the actual main model/thinking and outgoing tier above are applied. The shared policy\'s OMP roles and agent routing are not active on this host.');
    return { systemPrompt: `${prompt}\n\n${MARKER}\n${details.join('\n')}\n${END_MARKER}` };
  });
  pi.on('before_provider_request', async (event, ctx) => {
    const owner = attachment;
    if (!owner || !current(owner) || !tier) return;
    // This override belongs to the applied revision, not a newer pending request.
    // Capture it before the hook can await persistence; in-flight tiers are immutable.
    const requestTier = tier;
    const requestRevision = appliedRevision;
    const payload = event.payload;
    if (!supportsPriority(ctx.model) || !record(payload) || payload.model !== ctx.model?.id ||
        !Array.isArray(payload.input) || payload.stream !== true || payload.store !== false) {
      // Never guess another provider's wire format. Hook exceptions are swallowed by
      // Pi, so explicitly persist an error rather than falsely claiming priority.
      const error = `Pi payload hook for applied ${appliedMode} revision ${requestRevision}: Codex payload/API no longer matches the bounded service_tier hook; ${requestTier} override was not sent. Reissue the mode or use OFF.`;
      hookFailure = { revision: requestRevision, error };
      lastError = transitionFailure?.revision === requested.revision ? transitionFailure.error : error;
      // A stale request error is diagnostic, not a failure of the pending transition.
      if (requested.revision === requestRevision) status = 'error';
      try { await publish(owner, true); } catch (error) { owner.ctx.ui.setStatus('tibo-rush', `tibo-rush error: ${message(error)}`); }
      return;
    }
    return { ...payload, service_tier: requestTier };
  });
  pi.registerCommand('tibo-rush', {
    description: 'Global Tibo Rush: regular | fast | extreme | off | status (Pi has no OMP role routing)',
    getArgumentCompletions: getCommandCompletions,
    handler: async (args, ctx) => {
      const owner = attachment;
      if (!owner || !current(owner)) throw new Error('tibo-rush requires an active Pi session');
      owner.ctx = ctx;
      const mode = args.trim() || 'status';
      if (mode === 'status') {
        await enqueue(owner);
        const state = await readState();
        const clients = await listClients();
        ctx.ui.notify(`tibo-rush requested ${state.mode}; ${clients.length} live sessions. Pi: ${status}; actual main ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'unknown'}:${pi.getThinkingLevel()}; tier ${tier ?? 'none'}; role routing unsupported; priority hook ${supportsPriority(ctx.model) ? 'supported (server acceptance not guaranteed)' : 'unsupported'}${lastError ? `; ${lastError}` : ''}. Use tibo-rush status for all sessions.`, lastError ? 'warning' : 'info');
        return;
      }
      if (!MODES.includes(mode)) throw new Error('Use regular, fast, extreme, off or status');
      await setMode(mode);
      await enqueue(owner);
      ctx.ui.notify(status === 'error'
        ? `Requested global ${mode}, but Pi failed: ${lastError}. Reissue after fixing the cause, or use OFF.`
        : `Requested global tibo-rush ${mode}; Pi ${status}${status === 'pending' ? ' (main/thinking/tier changes wait until idle)' : ''}. Pi does not install OMP role/subagent routing.`, status === 'error' ? 'warning' : 'info');
    },
  });
}
