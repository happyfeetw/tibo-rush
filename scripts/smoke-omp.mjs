#!/usr/bin/env bun
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { listClients, policyFor, readState, setMode } from "../src/core/lib.mjs";
import { offlineProviderCredentials } from "../tests/fixtures/offline-provider.mjs";

// Real OMP processes, real settings registry, real extension package discovery.
// Never submits a model prompt: every prompt is registration-checked local command.
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const executable = process.env.OMP_BIN || "omp";
const timeoutMs = 45_000;
const settingsKeys = ["modelRoles", "task.agentModelOverrides", "tier.subagent", "task.agentServiceTierOverrides"];
const children = new Set();
const evidence = [];
let temporary;
let interrupted = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function verify(description, detail) {
  evidence.push({ verified: description, ...detail });
  console.log(JSON.stringify(evidence.at(-1)));
}
async function until(description, callback, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Smoke interrupted");
    const result = await callback();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

class RpcSession {
  constructor(label, args, env, cwd) {
    this.label = label;
    this.pending = new Map();
    this.completions = new Map();
    this.stderr = "";
    this.fatal = undefined;
    this.ready = false;
    this.closed = false;
    this.expectedNativeTimeouts = 0;
    this.nativeTimeouts = [];
    this.child = spawn(executable, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    children.add(this);
    this.exit = new Promise(resolve => {
      this.child.once("error", error => {
        this.fail(new Error(`OMP runtime unavailable (${executable}): ${error.message}`));
        this.closed = true;
        resolve({ code: null, signal: null });
      });
      this.child.once("exit", (code, signal) => {
        this.closed = true;
        if (!this.stopping) this.fail(new Error(`${label}: OMP exited unexpectedly (${code ?? signal}); ${this.stderr}`));
        resolve({ code, signal });
      });
    });
    this.child.stdin.on("error", error => { if (!this.stopping) this.fail(error); });
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-12_000); });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", line => {
      if (!line.trim()) return;
      let frame;
      try { frame = JSON.parse(line); }
      catch { this.fail(new Error(`${label}: non-JSON RPC output: ${line.slice(0, 200)}`)); return; }
      if (frame.type === "ready") this.ready = true;
      if (frame.type === "extension_error") {
        const relative = path.relative(packageRoot, frame.extensionPath ?? "");
        if (this.expectedNativeTimeouts > 0 && frame.event === "session_before_switch" &&
            frame.error === "handler timed out after 30000ms" && !path.isAbsolute(relative) &&
            relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
          this.expectedNativeTimeouts--;
          this.nativeTimeouts.push(frame);
        } else this.fail(new Error(`${label}: ${frame.extensionPath}: ${frame.error}`));
      }
      if (frame.type === "agent_start" || frame.type === "before_provider_request") {
        this.fail(new Error(`${label}: forbidden model turn started; smoke only permits local commands`));
      }
      if (frame.type === "prompt_result") this.completions.set(frame.id, frame);
      if (frame.type === "response") {
        const pending = this.pending.get(frame.id);
        if (pending) {
          this.pending.delete(frame.id);
          clearTimeout(pending.timer);
          if (frame.success) pending.resolve(frame);
          else pending.reject(new Error(`${label}: ${frame.command}: ${frame.error}`));
        }
      }
    });
  }
  fail(error) {
    this.fatal ||= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.fatal);
    }
    this.pending.clear();
  }
  healthy() { if (this.fatal) throw this.fatal; }
  async request(type, fields = {}) {
    this.healthy();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label}: timed out RPC ${type}; ${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
  }
  async local(command, args = "") {
    // An unregistered slash command could reach a real provider. Refuse before sending it.
    const inventory = await this.request("get_available_commands");
    assert.ok(inventory.data.commands.some(item => item.name === command && item.source === "extension"), `${this.label}: extension command /${command} not registered`);
    const result = await this.request("prompt", { message: `/${command}${args ? ` ${args}` : ""}` });
    if (result.data?.agentInvoked !== false) {
      const completion = await until(`${this.label}: local command completion`, () => { this.healthy(); return this.completions.get(result.id); });
      assert.equal(completion.agentInvoked, false, `${command} must never invoke a model`);
      assert.equal(completion.status, "completed", JSON.stringify(completion.error));
      this.completions.delete(result.id);
    }
    this.healthy();
  }
  async snapshot(operation = "read") {
    const id = randomUUID();
    await this.local("rush-smoke-probe", `${operation} ${id}`);
    const file = path.join(temporary, "observations", `${id}.json`);
    const snapshot = await until(`${this.label}: probe snapshot`, async () => {
      this.healthy();
      try { return JSON.parse(await fs.readFile(file, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    });
    const state = (await this.request("get_state")).data;
    assert.equal(state.isStreaming, false);
    assert.equal(snapshot.providerRequests, 0, "no provider requests permitted");
    return { ...snapshot, state };
  }
  async close() {
    if (this.closed) { children.delete(this); return; }
    this.stopping = true;
    this.child.stdin.end();
    let outcome = await Promise.race([this.exit, delay(5000).then(() => null)]);
    if (!outcome) {
      this.kill("SIGTERM");
      outcome = await Promise.race([this.exit, delay(2000).then(() => null)]);
      if (!outcome) { this.kill("SIGKILL"); await this.exit; }
    }
    this.lines.close();
    children.delete(this);
    if (outcome?.code !== 0) throw new Error(`${this.label}: OMP did not shut down cleanly (${outcome?.code ?? outcome?.signal ?? "forced kill"}); ${this.stderr}`);
  }
  async crash() {
    this.stopping = true;
    this.kill("SIGKILL");
    await this.exit;
    this.lines.close();
    children.delete(this);
  }
  kill(signal) {
    if (this.closed) return;
    try {
      if (process.platform !== "win32") process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

const probeSource = `import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
const keys = ${JSON.stringify(settingsKeys)};
export default function probe(pi) {
  let providerRequests = 0;
  let cancelSwitch = false;
  let storageFault = false;
  let writeFailures = 0;
  let unlinkFailures = 0;
  let cancelBranch = false;
  let blockedClient;
  let clientUnlinkFailures = 0;
  let blockedIntentDirectory;
  let intentUnlinkFailures = 0;
  let blockIntentWrites = false;
  let intentWriteFailures = 0;
  let baselineWriteSource;
  let baselineWriteFailures = 0;
  let blockChildHandoff = false;
  let currentSessionId = () => undefined;
  let blockNextModelRefresh = false;
  let releaseModelRefresh;
  let modelRefreshWaiting = false;
  let modelRefreshBlocks = 0;
  let modelRefreshReleases = 0;
  // Hold an actual public model-registry operation past the native hook
  // deadline, then resume its real implementation; never synthesize a model.
  const refreshSelectedModelMetadata = pi.pi.ModelRegistry.prototype.refreshSelectedModelMetadata;
  pi.pi.ModelRegistry.prototype.refreshSelectedModelMetadata = async function(...args) {
    if (blockNextModelRefresh) {
      blockNextModelRefresh = false;
      modelRefreshWaiting = true;
      modelRefreshBlocks++;
      await new Promise(resolve => { releaseModelRefresh = resolve; });
      modelRefreshWaiting = false;
      modelRefreshReleases++;
    }
    return refreshSelectedModelMetadata.apply(this, args);
  };
  const rename = fs.rename;
  fs.rename = async function(from, to) {
    if (blockIntentWrites && path.dirname(path.dirname(String(to))) === path.join(process.env.TIBO_RUSH_HOME, "handoffs")) {
      intentWriteFailures++;
      throw Object.assign(new Error("Synthetic precommit intent publication failure"), { code: "EIO" });
    }
    if (baselineWriteSource && path.dirname(String(to)) === path.join(process.env.TIBO_RUSH_HOME, "baselines") &&
        path.basename(String(to)) !== createHash("sha256").update(baselineWriteSource).digest("hex") + ".json") {
      baselineWriteFailures++;
      throw Object.assign(new Error("Synthetic inherited baseline publication failure"), { code: "EIO" });
    }
    return rename.call(this, from, to);
  };
  function rejectsChildHandoff(value) {
    const owner = currentSessionId();
    if (!blockChildHandoff || !owner || owner === baselineWriteSource) return false;
    const identity = '"sessionId":' + JSON.stringify(owner);
    const matches = line => typeof line === "string" && line.includes('"customType":"tibo-rush-session-handoff"') && line.includes(identity);
    return Array.isArray(value) ? value.some(matches) : matches(value);
  }
  const unlink = fs.unlink;
  fs.unlink = async function(file, ...args) {
    if (blockedClient && String(file) === blockedClient) {
      clientUnlinkFailures++;
      throw Object.assign(new Error("Synthetic old-client deletion failure"), { code: "EACCES" });
    }
    if (blockedIntentDirectory && path.dirname(String(file)) === blockedIntentDirectory && String(file).endsWith(".json")) {
      intentUnlinkFailures++;
      throw Object.assign(new Error("Synthetic resolved-intent deletion failure"), { code: "EACCES" });
    }
    if (process.env.RUSH_SMOKE_RETAIN_BASELINE === "1" && path.dirname(String(file)) === path.join(process.env.TIBO_RUSH_HOME, "baselines")) {
      unlinkFailures++;
      throw Object.assign(new Error("Synthetic baseline deletion failure"), { code: "EACCES" });
    }
    return unlink.call(this, file, ...args);
  };
  const transitions = [];
  pi.registerProvider("rush-smoke", {
    baseUrl: "http://127.0.0.1:9", apiKey: ${JSON.stringify(offlineProviderCredentials.apiKey)}, api: "openai-completions",
    models: [{ id: "plain", name: "Non-reasoning offline fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
  });
  pi.on("session_before_switch", () => {
    if (cancelSwitch) { cancelSwitch = false; return { cancel: true }; }
  });
  pi.on("session_before_branch", () => {
    if (cancelBranch) { cancelBranch = false; return { cancel: true }; }
  });
  for (const name of ["session_switch", "session_branch"]) pi.on(name, (event, ctx) => {
    transitions.push({ type: name, reason: event.reason, sessionId: ctx.sessionManager.getSessionId() });
  });
  // Inject genuine I/O failures into this isolated process's real host storage,
  // not into the adapter or its status reporting.
  const openWriter = pi.pi.FileSessionStorage.prototype.openWriter;
  pi.pi.FileSessionStorage.prototype.openWriter = function(file, ...args) {
    const writer = openWriter.call(this, file, ...args);
    for (const name of ["append", "appendSync", "flush"]) {
      const original = writer[name];
      if (typeof original !== "function") continue;
      writer[name] = function(...args) {
        if ((storageFault && file.endsWith(".jsonl")) || rejectsChildHandoff(args[0])) {
          writeFailures++;
          throw Object.assign(new Error("Synthetic session append/flush failure"), { code: "EIO" });
        }
        return original.apply(this, args);
      };
    }
    return writer;
  };
  for (const name of ["writeTextSync", "writeLinesSync", "writeTextAtomic", "writeLinesAtomic"]) {
    const original = pi.pi.FileSessionStorage.prototype[name];
    if (typeof original !== "function") continue;
    pi.pi.FileSessionStorage.prototype[name] = function(file, ...args) {
      if ((storageFault && file.endsWith(".jsonl")) || rejectsChildHandoff(args[0])) {
        writeFailures++;
        throw Object.assign(new Error("Synthetic session rewrite failure"), { code: "EIO" });
      }
      return original.call(this, file, ...args);
    };
  }
  // No outbound fetch is necessary for local settings/model selection. Deny it as defense in depth.
  globalThis.fetch = async () => { throw new Error("Network disabled by zero-network rush smoke"); };
  pi.on("before_agent_start", () => { throw new Error("Model turns forbidden by zero-network rush smoke"); });
  pi.on("before_provider_request", () => { providerRequests++; throw new Error("Provider requests forbidden by rush smoke"); });
  pi.registerCommand("rush-smoke-probe", {
    description: "Read actual local settings without invoking a model",
    handler: async (args, ctx) => {
      const [operation, id] = args.trim().split(/\\s+/);
      if (!/^[a-f0-9-]+$/.test(id || "")) throw new Error("Invalid observation id");
      const session = pi.pi.AgentRegistry.global().get(ctx.agent.id)?.session;
      if (!session || session.sessionManager !== ctx.sessionManager ||
          session.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) throw new Error("Public registry identity mismatch");
      if (operation === "seed") {
        const values = JSON.parse(process.env.RUSH_SMOKE_SEED);
        for (const key of keys) {
          const handle = lookup(key);
          if (!handle) throw new Error("Missing OMP setting: " + key);
          if (process.env.RUSH_SMOKE_RUNTIME === "1") handle.override(pi.pi.settings, values[key]);
          else handle.clearOverride(pi.pi.settings);
        }
        pi.setServiceTier("openai", "flex");
        pi.setServiceTier("anthropic", "priority");
        pi.setServiceTier("google", "priority");
      } else if (operation === "cancel-switch") {
        cancelSwitch = true;
      } else if (operation === "block-model-refresh") {
        blockNextModelRefresh = true;
      } else if (operation === "release-model-refresh") {
        if (!releaseModelRefresh) throw new Error("No blocked native model refresh");
        const release = releaseModelRefresh;
        releaseModelRefresh = undefined;
        release();
      } else if (operation === "cancel-branch") {
        cancelBranch = true;
      } else if (operation === "prepare-branch") {
        const created = await ctx.newSession({ setup: async manager => {
          manager.appendMessage({ role: "user", content: "Synthetic persisted branch fixture; no provider request.", timestamp: Date.now() });
        } });
        if (created.cancelled) throw new Error("Branch fixture session unexpectedly cancelled");
      } else if (operation === "fault-intent") {
        blockIntentWrites = true;
      } else if (operation === "heal-intent") {
        blockIntentWrites = false;
      } else if (operation === "fault-transition-cleanup") {
        const hash = createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex");
        blockedClient = path.join(process.env.TIBO_RUSH_HOME, "clients", process.pid + "-" + hash.slice(0, 16) + ".json");
        blockedIntentDirectory = path.join(process.env.TIBO_RUSH_HOME, "handoffs", hash);
      } else if (operation === "heal-transition-cleanup") {
        blockedClient = undefined;
        blockedIntentDirectory = undefined;
      } else if (operation === "fault-inherited-baseline" || operation === "fault-inherited-both") {
        baselineWriteSource = ctx.sessionManager.getSessionId();
        currentSessionId = () => ctx.sessionManager.getSessionId();
        blockChildHandoff = operation === "fault-inherited-both";
      } else if (operation === "branch") {
        const created = await ctx.newSession({ setup: async manager => {
          manager.appendMessage({ role: "user", content: "Synthetic branch fixture; never sent to a provider.", timestamp: Date.now() });
        } });
        if (created.cancelled) throw new Error("Fixture new session unexpectedly cancelled");
        const entry = ctx.sessionManager.getBranch().find(item => item.type === "message" && item.message.role === "user");
        if (!entry) throw new Error("Branch fixture missing");
        const result = await ctx.branch(entry.id);
        if (result.cancelled) throw new Error("Fixture branch unexpectedly cancelled");
      } else if (operation === "auto") {
        session.setThinkingLevel("auto");
      } else if (operation === "unset") {
        const model = ctx.modelRegistry.find("rush-smoke", "plain");
        if (!model || !await pi.setModel(model)) throw new Error("Offline non-reasoning model unavailable");
        session.setThinkingLevel(undefined);
      } else if (operation === "drift-model") {
        const model = ctx.modelRegistry.find("openai-codex", "gpt-6.1-sol");
        if (!model || !await pi.setModel(model)) throw new Error("Drift model unavailable");
      } else if (operation === "drift-thinking") {
        pi.setThinkingLevel("low");
      } else if (operation === "drift-tier") {
        pi.setServiceTier("openai", "flex");
      } else if (operation === "fault") {
        storageFault = true;
      } else if (operation !== "read") throw new Error("Unknown probe operation");
      const settings = {};
      for (const key of keys) {
        const handle = lookup(key);
        if (!handle) throw new Error("Missing OMP setting: " + key);
        settings[key] = { value: handle.get(pi.pi.settings), provenance: handle.provenance(pi.pi.settings) };
      }
      const configured = session.configuredThinkingLevel();
      const model = ctx.models.current();
      const branchEntry = ctx.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user");
      const ownHandoff = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom" &&
        entry.customType === "tibo-rush-session-handoff" && entry.data?.sessionId === ctx.sessionManager.getSessionId())?.data;
      const result = { sessionId: ctx.sessionManager.getSessionId(), settings, tiers: pi.getServiceTiers(),
        thinking: pi.getThinkingLevel() ?? null, configured: configured ?? null,
        model: { provider: model?.provider, id: model?.id }, providerRequests,
        transitions, writeFailures, unlinkFailures, clientUnlinkFailures, baselineWriteFailures, blockedClient,
        intentWriteFailures, intentUnlinkFailures,
        modelRefreshWaiting, modelRefreshBlocks, modelRefreshReleases,
        branchEntryId: branchEntry?.id, ownHandoff, hostVersion: pi.pi.VERSION, registryIdentity: true };
      const dir = path.join(process.env.RUSH_SMOKE_ROOT, "observations");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, id + ".json"), JSON.stringify(result));
    }
  });
}
`;

function baselineFile(sessionId) {
  return path.join(temporary, "rush", "baselines", `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}
async function sourceIntents(sessionId) {
  const directory = path.join(temporary, "rush", "handoffs", createHash("sha256").update(sessionId).digest("hex"));
  let files;
  try { files = await fs.readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const entries = await Promise.all(files.filter(file => file.endsWith(".json")).map(async file => {
    try { return JSON.parse(await fs.readFile(path.join(directory, file), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  }));
  return entries.filter(Boolean);
}
function assertRestored(actual, baseline) {
  assert.deepEqual(actual.model, baseline.model, "main model restored");
  assert.equal(actual.thinking, baseline.thinking, "thinking restored");
  assert.equal(actual.configured, baseline.configured, "configured thinking selector restored (including auto/unset)");
  assert.deepEqual(actual.tiers, baseline.tiers, "all provider-family tiers restored");
  assert.deepEqual(actual.settings, baseline.settings, "routing values AND runtime-vs-persisted provenance restored");
}
function assertPolicy(actual, baseline, policy) {
  assert.deepEqual(actual.model, { provider: policy.main.provider, id: policy.main.id });
  assert.equal(actual.thinking, policy.main.thinking);
  assert.equal(actual.configured, policy.main.thinking);
  assert.equal(actual.state.model.provider, policy.main.provider);
  assert.equal(actual.state.model.id, policy.main.id);
  assert.equal(actual.state.thinkingLevel, policy.main.thinking);
  assert.equal(actual.tiers.openai, policy.tier);
  assert.equal(actual.tiers.anthropic, baseline.tiers.anthropic);
  assert.equal(actual.tiers.google, baseline.tiers.google);
  const patches = { modelRoles: policy.roles, "task.agentModelOverrides": policy.agentModels, "tier.subagent": "none", "task.agentServiceTierOverrides": policy.agentTiers };
  for (const key of settingsKeys) {
    const capture = baseline.settings[key];
    const patch = patches[key];
    const expected = typeof capture.value === "object" && capture.value !== null && typeof patch === "object"
      ? { ...capture.value, ...patch } : patch;
    assert.deepEqual(actual.settings[key], { value: expected, provenance: "runtime" }, key);
  }
}
async function aligned(sessions, state) {
  await until(`sessions apply ${state.mode}/${state.revision}`, async () => {
    sessions.forEach(session => session.healthy());
    const rows = await listClients(path.join(temporary, "rush"));
    for (const row of rows) if (row.revision === state.revision) assert.notEqual(row.status, "error", `${row.sessionId}: ${row.error}`);
    return rows.length === sessions.length && rows.every(row => row.status === "applied" && row.revision === state.revision && row.appliedMode === state.mode);
  });
}

async function main() {
  if (!process.versions.bun) throw new Error("Bun runtime required: bun scripts/smoke-omp.mjs");
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tibo-rush-rpc-"));
  const home = path.join(temporary, "home");
  const agent = path.join(home, ".omp", "agent");
  const cwd = path.join(temporary, "workspace");
  const rush = path.join(temporary, "rush");
  await Promise.all([home, agent, cwd].map(dir => fs.mkdir(dir, { recursive: true })));
  const probe = path.join(temporary, "probe.mjs");
  await fs.writeFile(probe, probeSource);
  const sol = "openai-codex/gpt-6.1-sol";
  const astra = "openai-codex/gpt-6-astra";
  const seed = {
    modelRoles: { task: `${sol}:low`, smokeRetained: `${sol}:high` },
    "task.agentModelOverrides": { task: `${sol}:low`, smokeRetained: `${sol}:high` },
    "tier.subagent": "flex",
    "task.agentServiceTierOverrides": { task: "flex", smokeRetained: "none" },
  };
  const config = path.join(agent, "config.yml");
  // Use the isolated user's persistent layer, not --config (which OMP exposes as runtime).
  await fs.writeFile(config, JSON.stringify({
    modelRoles: seed.modelRoles,
    task: { agentModelOverrides: seed["task.agentModelOverrides"], agentServiceTierOverrides: seed["task.agentServiceTierOverrides"] },
    tier: { subagent: "flex" },
    providers: { cacheWarming: "off" },
    advisor: { enabled: false }, autoResume: false,
    disabledProviders: ["claude", "codex", "gemini", "github", "opencode", "cursor", "agents-md"],
  }));
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin", HOME: home, USERPROFILE: home,
    TMPDIR: temporary, TMP: temporary, TEMP: temporary, TERM: "dumb",
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_DATA_HOME: path.join(home, ".local/share"),
    PI_CONFIG_DIR: ".omp", PI_CODING_AGENT_DIR: agent,
    PI_NATIVES_DIR: path.join(temporary, "natives"),
    TIBO_RUSH_HOME: rush,
    OPENAI_CODEX_OAUTH_TOKEN: offlineProviderCredentials.oauthToken,
    PI_NO_TITLE: "1", PI_NO_PTY: "1", OMP_SKIP_SETUP: "1", PI_AUTO_QA: "0", OTEL_SDK_DISABLED: "true",
    RUSH_SMOKE_ROOT: temporary, RUSH_SMOKE_SEED: JSON.stringify(seed),
  };
  const common = ["--mode", "rpc", "--no-ui", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp", "--no-title", "--no-pty", "--no-prewalk",
    "--extension", packageRoot, "--extension", probe, "--api-key", "rush-smoke-local-only"];
  async function start(label, runtime, model, resume, { initialize = true, noSession = false, thinking, retainBaseline = false } = {}) {
    const sessionDir = path.join(temporary, label, "sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    const session = new RpcSession(label, [...common, "--session-dir", sessionDir, "--model", model,
      ...(noSession ? ["--no-session"] : []),
      ...(resume ? ["--session", resume] : []),
      ...(!resume || thinking !== undefined ? ["--thinking", thinking ?? (runtime ? "medium" : "high")] : [])],
      { ...env, RUSH_SMOKE_RUNTIME: runtime ? "1" : "0", RUSH_SMOKE_RETAIN_BASELINE: retainBaseline ? "1" : "0" }, cwd);
    await until(`${label}: RPC ready`, () => { session.healthy(); return session.ready; });
    // Explicit /new persists an empty session; ordinary startup stays memory-only until a model turn.
    if (!resume && initialize && !noSession) await session.request("new_session");
    const commands = (await session.request("get_available_commands")).data.commands;
    for (const name of ["tibo-rush", "rush-smoke-probe"]) assert.ok(commands.some(command => command.name === name && command.source === "extension"), `${label}: /${name} must be registered before any prompt; extension package failed to load`);
    return session;
  }
  const first = await start("first", true, sol);
  const second = await start("second", false, astra);
  const sessions = [first, second];
  const baselines = await Promise.all(sessions.map(session => session.snapshot("seed")));
  assert.notEqual(baselines[0].sessionId, baselines[1].sessionId);
  assert.notDeepEqual(baselines[0].model, baselines[1].model);
  assert.equal(baselines[0].settings.modelRoles.provenance, "runtime");
  assert.notEqual(baselines[1].settings.modelRoles.provenance, "runtime");
  verify("two real RPC sessions and package commands registered; distinct baselines captured", { sessions: baselines.map(item => item.sessionId) });
  const saved = new Map();
  for (const mode of ["regular", "fast", "extreme"]) {
    // Exercise extension command registration and its actual shared CLI/lib state contract.
    await first.local("tibo-rush", mode);
    const requested = await readState(rush);
    assert.equal(requested.mode, mode);
    await aligned(sessions, requested);
    const policy = await policyFor(mode, rush);
    for (let index = 0; index < sessions.length; index++) {
      assertPolicy(await sessions[index].snapshot(), baselines[index], policy);
      const file = baselineFile(baselines[index].sessionId);
      const bytes = await fs.readFile(file, "utf8");
      const persisted = JSON.parse(bytes);
      assert.equal(persisted.version, 1);
      assert.deepEqual(persisted.model, baselines[index].model);
      assert.equal(persisted.thinking, baselines[index].configured);
      assert.deepEqual(persisted.tiers, baselines[index].tiers);
      if (saved.has(file)) assert.equal(bytes, saved.get(file), "mode changes must not overwrite original baseline");
      else saved.set(file, bytes);
    }
    verify(`both sessions actually applied ${mode}`, { main: policy.main, tier: policy.tier, revision: requested.revision });
  }
  await first.snapshot("cancel-switch");
  const cancelled = await first.request("new_session");
  assert.equal(cancelled.data.cancelled, true, "later extension veto must cancel the transition");
  await aligned(sessions, await readState(rush));
  assert.equal((await first.snapshot()).sessionId, baselines[0].sessionId);
  await aligned(sessions, await setMode("off", rush));
  assertRestored(await first.snapshot(), baselines[0]);
  await aligned(sessions, await setMode("extreme", rush));
  await first.snapshot("branch");
  await aligned(sessions, await readState(rush));
  const branched = await first.snapshot();
  assert.notEqual(branched.sessionId, baselines[0].sessionId);
  assert.ok(branched.transitions.some(event => event.type === "session_branch" && event.sessionId === branched.sessionId));
  assertPolicy(branched, baselines[0], await policyFor("extreme", rush));
  const transferred = JSON.parse(await fs.readFile(baselineFile(branched.sessionId), "utf8"));
  assert.deepEqual(transferred.model, baselines[0].model, "branch inherits ORIGINAL model baseline");
  assert.equal(transferred.thinking, baselines[0].configured);
  assert.deepEqual(transferred.tiers, baselines[0].tiers);
  const forkResult = await first.request("fork");
  assert.equal(forkResult.data.cancelled, false);
  await aligned(sessions, await readState(rush));
  const forked = await first.snapshot();
  assert.notEqual(forked.sessionId, branched.sessionId);
  assertPolicy(forked, baselines[0], await policyFor("extreme", rush));
  const forkBaseline = JSON.parse(await fs.readFile(baselineFile(forked.sessionId), "utf8"));
  assert.deepEqual(forkBaseline.model, baselines[0].model);
  assert.equal(forkBaseline.thinking, baselines[0].configured);
  baselines[0] = { ...baselines[0], sessionId: forked.sessionId };
  verify("later veto leaves original session controllable; committed new, branch and full fork preserve the original baseline", { sessionId: forked.sessionId });
  const sessionPath = (await second.request("get_state")).data.sessionFile;
  assert.ok(sessionPath, "persistent session path required for cold resume");
  await second.close();
  const secondBaselineFile = baselineFile(baselines[1].sessionId);
  assert.equal(await fs.readFile(secondBaselineFile, "utf8"), saved.get(secondBaselineFile), "shutdown while active preserves baseline for cold resume");
  const resumed = await start("second-resumed", false, astra, sessionPath);
  sessions[1] = resumed;
  await aligned(sessions, await readState(rush));
  const resumedActive = await resumed.snapshot();
  assert.equal(resumedActive.sessionId, baselines[1].sessionId);
  assertPolicy(resumedActive, baselines[1], await policyFor("extreme", rush));
  assert.equal(await fs.readFile(secondBaselineFile, "utf8"), saved.get(secondBaselineFile));
  verify("cold resume reuses original baseline and reapplies active policy", { sessionId: resumedActive.sessionId });
  // Even a broken user override must not prevent OFF from restoring either session.
  await fs.writeFile(path.join(rush, "policies.json"), "{malformed");
  const off = await setMode("off", rush);
  await aligned(sessions, off);
  for (let index = 0; index < sessions.length; index++) {
    assertRestored(await sessions[index].snapshot(), baselines[index]);
    await assert.rejects(fs.access(baselineFile(baselines[index].sessionId)), { code: "ENOENT" });
  }
  verify("off restores exact main, thinking, all tiers, roles, agent routing and override provenance despite malformed policies", { sessions: 2 });
  await fs.unlink(path.join(rush, "policies.json"));
  await resumed.close();
  for (const operation of ["auto", "unset"]) {
    const original = await first.snapshot(operation);
    assert.equal(original.configured, operation === "auto" ? "auto" : null);
    if (operation === "unset") assert.equal(original.thinking, null);
    await aligned([first], await setMode("fast", rush));
    assertPolicy(await first.snapshot(), original, await policyFor("fast", rush));
    await aligned([first], await setMode("off", rush));
    assertRestored(await first.snapshot(), original);
    verify("configured " + operation + " selector round-trips through real OMP", { version: original.hostVersion });
  }
  const original = await first.snapshot();
  for (const operation of ["drift-model", "drift-thinking", "drift-tier"]) {
    await aligned([first], await setMode("extreme", rush));
    const changed = await first.snapshot(operation);
    await until("manual drift is reported honestly", async () => {
      first.healthy();
      const rows = await listClients(rush);
      return rows.length === 1 && rows[0].status === "error" && /changed outside/.test(rows[0].error);
    });
    const retained = await first.snapshot();
    assert.deepEqual(retained.model, changed.model);
    assert.equal(retained.configured, changed.configured);
    assert.deepEqual(retained.tiers, changed.tiers);
  }
  await aligned([first], await setMode("off", rush));
  assertRestored(await first.snapshot(), original);
  verify("model, configured thinking and tier drift report error without overwriting user choices");

  await aligned([first], await setMode("extreme", rush));
  const crashPath = (await first.request("get_state")).data.sessionFile;
  await first.snapshot("fault");
  const recoveryOff = await setMode("off", rush);
  await until("failed journal writes retain recoverable OFF", async () => {
    first.healthy();
    const rows = await listClients(rush);
    return rows.length === 1 && rows[0].revision === recoveryOff.revision && ["pending", "error"].includes(rows[0].status);
  });
  const failed = await first.snapshot();
  assert.ok(failed.writeFailures > 0, "actual host append/rewrite failures were injected");
  const recoveryFile = baselineFile(failed.sessionId);
  const recoveryBytes = await fs.readFile(recoveryFile, "utf8");
  assert.deepEqual(JSON.parse(recoveryBytes).model, original.model);
  await first.crash();
  const recovered = await start("fault-resumed", true, sol, crashPath, { retainBaseline: true });
  await until("durable restoration survives baseline unlink failure", async () => {
    recovered.healthy();
    const rows = await listClients(rush);
    return rows.length === 1 && rows[0].revision === recoveryOff.revision && rows[0].status === "error" &&
      /baseline deletion failure/.test(rows[0].error);
  });
  const recoveredState = await recovered.snapshot();
  assertRestored(recoveredState, original);
  assert.ok(recoveredState.unlinkFailures > 0);
  const acknowledged = JSON.parse(await fs.readFile(recoveryFile, "utf8"));
  assert.equal(acknowledged.restored, true, "only a confirmed host flush can acknowledge restoration");
  verify("OFF host append/rewrite failures retain recovery through SIGKILL and cold resume", { writeFailures: failed.writeFailures });
  await recovered.snapshot("drift-model");
  const userChoice = await recovered.snapshot("drift-thinking");
  await delay(1100);
  const retainedChoice = await recovered.snapshot();
  assert.deepEqual(retainedChoice.model, userChoice.model);
  assert.equal(retainedChoice.configured, userChoice.configured);
  await recovered.close();
  const acknowledgedResumed = await start("acknowledged-resumed", true, sol, crashPath);
  await aligned([acknowledgedResumed], recoveryOff);
  const afterAcknowledgement = await acknowledgedResumed.snapshot();
  assert.deepEqual(afterAcknowledgement.model, userChoice.model);
  assert.equal(afterAcknowledgement.configured, userChoice.configured);
  await assert.rejects(fs.access(recoveryFile), { code: "ENOENT" });
  verify("failed baseline deletion leaves a durable acknowledgement that never replays OFF over later user edits");
  await aligned([acknowledgedResumed], await setMode("fast", rush));
  const recaptured = JSON.parse(await fs.readFile(recoveryFile, "utf8"));
  assert.deepEqual(recaptured.model, userChoice.model);
  assert.equal(recaptured.thinking, userChoice.configured);
  await aligned([acknowledgedResumed], await setMode("off", rush));
  const recapturedOff = await acknowledgedResumed.snapshot();
  assert.deepEqual(recapturedOff.model, userChoice.model);
  assert.equal(recapturedOff.configured, userChoice.configured);
  verify("a later active mode captures the legitimate post-OFF user selection, not a retired baseline");
  acknowledgedResumed.healthy();
  await acknowledgedResumed.close();
  const lazy = await start("lazy", false, sol, undefined, { initialize: false, thinking: "auto" });
  const lazyBaseline = await lazy.snapshot("seed");
  assert.equal(lazyBaseline.configured, "auto", "fresh pre-turn auto must not be inferred from an absent journal entry");
  await aligned([lazy], await setMode("extreme", rush));
  assertPolicy(await lazy.snapshot(), lazyBaseline, await policyFor("extreme", rush));
  await aligned([lazy], await setMode("off", rush));
  const lazyRestored = await lazy.snapshot();
  assertRestored(lazyRestored, lazyBaseline);
  await fs.access(lazyRestored.state.sessionFile);
  await assert.rejects(fs.access(baselineFile(lazyBaseline.sessionId)), { code: "ENOENT" });
  verify("fresh pre-turn auto is captured exactly; OFF materializes and flushes a lazy journal");
  await lazy.snapshot("drift-thinking");
  await lazy.close();
  const startupOverride = await start("auto-resumed", false, sol, lazyRestored.state.sessionFile, { thinking: "auto" });
  const startupBaseline = await startupOverride.snapshot();
  assert.equal(startupBaseline.configured, "auto", "CLI auto overrides stale persisted effort");
  await aligned([startupOverride], await setMode("fast", rush));
  await aligned([startupOverride], await setMode("off", rush));
  assertRestored(await startupOverride.snapshot(), startupBaseline);
  verify("resumed CLI auto captures the actual selector rather than stale journal effort");
  await startupOverride.close();
  const ephemeral = await start("ephemeral", false, sol, undefined, { noSession: true });
  const ephemeralBaseline = await ephemeral.snapshot("seed");
  assert.ok(!ephemeralBaseline.state.sessionFile);
  await aligned([ephemeral], await setMode("extreme", rush));
  await aligned([ephemeral], await setMode("off", rush));
  assertRestored(await ephemeral.snapshot(), ephemeralBaseline);
  await assert.rejects(fs.access(baselineFile(ephemeralBaseline.sessionId)), { code: "ENOENT" });
  verify("true no-session roots restore in memory without a nonexistent cold journal");
  await ephemeral.close();

  const lifecycle = await start("lifecycle-faults", true, sol);
  await lifecycle.snapshot("seed");
  const lifecycleSource = await lifecycle.snapshot("prepare-branch");
  assert.ok(lifecycleSource.branchEntryId);
  const lifecycleActive = await setMode("extreme", rush);
  await aligned([lifecycle], lifecycleActive);
  await lifecycle.snapshot("fault-intent");
  assert.equal((await lifecycle.request("branch", { entryId: lifecycleSource.branchEntryId })).data.cancelled, true);
  const intentRejected = await lifecycle.snapshot("read");
  assert.equal(intentRejected.sessionId, lifecycleSource.sessionId);
  assert.ok(intentRejected.intentWriteFailures > 0, "real precommit intent failure must cancel instead of being swallowed as a hook error");
  await lifecycle.snapshot("heal-intent");
  await until("source remains attached after failed intent", async () => (await listClients(rush)).find(row =>
    row.sessionId === lifecycleSource.sessionId && row.status === "applied" && row.revision === lifecycleActive.revision));
  await lifecycle.snapshot("cancel-branch");
  const vetoedBranch = await lifecycle.request("branch", { entryId: lifecycleSource.branchEntryId });
  assert.equal(vetoedBranch.data.cancelled, true);
  await aligned([lifecycle], lifecycleActive);
  assert.equal((await lifecycle.snapshot("read")).sessionId, lifecycleSource.sessionId);
  await until("vetoed branch intent retired", async () => (await sourceIntents(lifecycleSource.sessionId)).length === 0);
  const blockedClient = await lifecycle.snapshot("fault-transition-cleanup");
  assert.equal((await lifecycle.request("branch", { entryId: lifecycleSource.branchEntryId })).data.cancelled, false);
  const lifecycleChild = await lifecycle.snapshot();
  assert.notEqual(lifecycleChild.sessionId, lifecycleSource.sessionId);
  await until("old-client deletion fault reported", async () => (await listClients(rush)).find(row =>
    row.sessionId === lifecycleChild.sessionId && row.status === "error" && /Stale OMP client cleanup failed/.test(row.error ?? "")));
  const lifecycleOff = await setMode("off", rush);
  await until("new owner restores despite old-client cleanup failure", async () => (await listClients(rush)).find(row =>
    row.sessionId === lifecycleChild.sessionId && row.revision === lifecycleOff.revision &&
    row.appliedMode === "off" && row.status === "error"));
  const lifecycleRestored = await lifecycle.snapshot();
  assertRestored(lifecycleRestored, lifecycleSource);
  assert.ok(lifecycleRestored.clientUnlinkFailures > 0);
  assert.ok(lifecycleRestored.intentUnlinkFailures > 0);
  const resolvedIntents = await sourceIntents(lifecycleSource.sessionId);
  assert.equal(resolvedIntents.length, 1);
  assert.equal(resolvedIntents[0].resolved, true, "failed unlink leaves durable resolution, not ambiguous inherited state");
  await assert.rejects(fs.access(baselineFile(lifecycleChild.sessionId)), { code: "ENOENT" });
  await fs.access(blockedClient.blockedClient);
  await lifecycle.snapshot("heal-transition-cleanup");
  await until("transition cleanup retries succeed", async () => (await listClients(rush)).find(row =>
    row.sessionId === lifecycleChild.sessionId && row.status === "applied" && row.revision === lifecycleOff.revision));
  await aligned([lifecycle], lifecycleOff);
  await assert.rejects(fs.access(blockedClient.blockedClient), { code: "ENOENT" });
  assert.equal((await sourceIntents(lifecycleSource.sessionId)).length, 0);
  verify("intent failure explicitly vetoes; later branch veto retires intent; committed owner restores while stale-client/intent cleanup fails and retries");

  const handoffSource = await lifecycle.snapshot("prepare-branch");
  await aligned([lifecycle], await setMode("extreme", rush));
  const retainedSource = await fs.readFile(baselineFile(handoffSource.sessionId), "utf8");
  await lifecycle.snapshot("fault-inherited-baseline");
  assert.equal((await lifecycle.request("branch", { entryId: handoffSource.branchEntryId })).data.cancelled, false);
  const handoffChild = await lifecycle.snapshot();
  assert.notEqual(handoffChild.sessionId, handoffSource.sessionId);
  assert.ok(handoffChild.baselineWriteFailures > 0, "real shared baseline publication must fail");
  assert.deepEqual(handoffChild.ownHandoff.baseline.model, handoffSource.model);
  assert.equal(handoffChild.ownHandoff.source.sourceId, handoffSource.sessionId);
  await assert.rejects(fs.access(baselineFile(handoffChild.sessionId)), { code: "ENOENT" });
  assert.equal(await fs.readFile(baselineFile(handoffSource.sessionId), "utf8"), retainedSource);
  await lifecycle.crash();
  const handoffOff = await setMode("off", rush);
  const handoffRecovered = await start("handoff-cold", true, sol, handoffChild.state.sessionFile);
  await aligned([handoffRecovered], handoffOff);
  const handoffRestored = await handoffRecovered.snapshot();
  assertRestored(handoffRestored, handoffSource);
  assert.equal(handoffRestored.ownHandoff.baseline, null);
  assert.equal(handoffRestored.ownHandoff.token, handoffChild.ownHandoff.token);
  await assert.rejects(fs.access(baselineFile(handoffChild.sessionId)), { code: "ENOENT" });
  assert.equal(await fs.readFile(baselineFile(handoffSource.sessionId), "utf8"), retainedSource);
  const laterChildChoice = await handoffRecovered.snapshot("drift-thinking");
  await handoffRecovered.close();
  const reenteredSource = await start("source-reentered", true, sol, handoffSource.state.sessionFile);
  await aligned([reenteredSource], handoffOff);
  await reenteredSource.snapshot("auto");
  await aligned([reenteredSource], await setMode("fast", rush));
  assert.equal(JSON.parse(await fs.readFile(baselineFile(handoffSource.sessionId), "utf8")).thinking, "auto");
  await reenteredSource.close();
  const childOnlyOff = await setMode("off", rush);
  const childAgain = await start("child-after-parent-reentry", true, sol, handoffChild.state.sessionFile);
  await aligned([childAgain], childOnlyOff);
  const childAgainState = await childAgain.snapshot();
  assert.equal(childAgainState.configured, laterChildChoice.configured, "durable child tombstone must not replay parent or old child baseline");
  assert.deepEqual(childAgainState.model, laterChildChoice.model);
  assert.equal(JSON.parse(await fs.readFile(baselineFile(handoffSource.sessionId), "utf8")).thinking, "auto");
  await childAgain.close();
  verify("durable own-ID child handoff survives shared-write failure plus SIGKILL; matching OFF tombstone protects later edits and parent reentry");

  const ambiguous = await start("handoff-host-fault", true, sol);
  await ambiguous.snapshot("seed");
  const ambiguousSource = await ambiguous.snapshot("prepare-branch");
  await aligned([ambiguous], await setMode("extreme", rush));
  const ambiguousRetained = await fs.readFile(baselineFile(ambiguousSource.sessionId), "utf8");
  await ambiguous.snapshot("fault-inherited-both");
  assert.equal((await ambiguous.request("branch", { entryId: ambiguousSource.branchEntryId })).data.cancelled, false);
  const ambiguousChild = await ambiguous.snapshot();
  assert.notEqual(ambiguousChild.sessionId, ambiguousSource.sessionId);
  assert.ok(ambiguousChild.writeFailures > 0, "real child marker journal write must fail after native branch commit");
  await assert.rejects(fs.access(baselineFile(ambiguousChild.sessionId)), { code: "ENOENT" });
  const ambiguousIntents = await sourceIntents(ambiguousSource.sessionId);
  assert.equal(ambiguousIntents.length, 1);
  assert.equal(ambiguousIntents[0].confirmed, true);
  await ambiguous.crash();
  const ambiguousOff = await setMode("off", rush);
  const ambiguousCold = await start("ambiguous-cold", true, sol, ambiguousChild.state.sessionFile);
  await until("unproven inherited state fails closed", async () => (await listClients(rush)).find(row =>
    row.sessionId === ambiguousChild.sessionId && row.revision === ambiguousOff.revision &&
    row.status === "error" && /inherited recovery is ambiguous/.test(row.error ?? "")));
  const ambiguousRows = await listClients(rush);
  assert.notEqual(ambiguousRows.find(row => row.sessionId === ambiguousChild.sessionId)?.appliedRevision, ambiguousOff.revision);
  assert.equal(await fs.readFile(baselineFile(ambiguousSource.sessionId), "utf8"), ambiguousRetained);
  await ambiguousCold.snapshot();
  await ambiguousCold.close();
  verify("failed committed child-journal handoff preserves source proof and reports blocked OFF after crash instead of guessing a baseline");

  const plain = await start("plain-off-branch", false, sol);
  const plainSource = await plain.snapshot("prepare-branch");
  assert.equal((await plain.request("branch", { entryId: plainSource.branchEntryId })).data.cancelled, false);
  await aligned([plain], ambiguousOff);
  const plainChild = await plain.snapshot();
  assert.notEqual(plainChild.sessionId, plainSource.sessionId);
  assert.equal(plainChild.ownHandoff.baseline, null);
  assert.equal((await sourceIntents(plainSource.sessionId)).length, 0);
  verify("never-enabled plain OFF branches remain usable without an active-mode transition intent");
  const resumeActive = await setMode("extreme", rush);
  await aligned([plain], resumeActive);
  assert.equal((await plain.request("switch_session", { sessionPath: handoffChild.state.sessionFile })).data.cancelled, false);
  await aligned([plain], resumeActive);
  const resumedTarget = await plain.snapshot();
  assert.equal(resumedTarget.sessionId, handoffChild.sessionId);
  const resumedBaseline = JSON.parse(await fs.readFile(baselineFile(resumedTarget.sessionId), "utf8"));
  assert.equal(resumedBaseline.thinking, laterChildChoice.configured, "ordinary resume captures target's own selector, not the previous owner's");
  assert.deepEqual(resumedBaseline.tiers, laterChildChoice.tiers);
  await aligned([plain], await setMode("off", rush));
  const resumedOff = await plain.snapshot();
  assert.equal(resumedOff.configured, laterChildChoice.configured);
  assert.deepEqual(resumedOff.model, laterChildChoice.model);
  assert.deepEqual(resumedOff.tiers, laterChildChoice.tiers);
  await plain.close();
  verify("ordinary committed resume preserves target model/thinking/tiers rather than writing the departed owner's baseline into it");

  const timed = await start("native-transition-timeout", true, sol);
  const timedBaseline = await timed.snapshot("seed");
  await aligned([timed], await setMode("extreme", rush));
  const timedSaved = await fs.readFile(baselineFile(timedBaseline.sessionId), "utf8");
  await timed.snapshot("block-model-refresh");
  timed.expectedNativeTimeouts = 1;
  assert.equal((await timed.request("new_session")).data.cancelled, true, "synchronous gate must cancel after the real async hook times out");
  assert.equal(timed.expectedNativeTimeouts, 0);
  assert.equal(timed.nativeTimeouts.length, 1, "the native 30-second timeout must actually fire");
  const timedPending = await timed.snapshot();
  assert.equal(timedPending.sessionId, timedBaseline.sessionId);
  assert.equal(timedPending.modelRefreshWaiting, true);
  assert.equal(timedPending.modelRefreshBlocks, 1);
  assert.equal(await fs.readFile(baselineFile(timedBaseline.sessionId), "utf8"), timedSaved);
  assert.equal((await timed.request("new_session")).data.cancelled, true, "later transitions cannot outrun the outstanding host setter");
  assert.equal((await timed.request("switch_session", { sessionPath: handoffChild.state.sessionFile })).data.cancelled, true);
  assert.equal((await timed.snapshot()).sessionId, timedBaseline.sessionId);
  assert.equal(timed.nativeTimeouts.length, 1, "subsequent attempts must cancel promptly, not restart preparation");
  const timedOff = await setMode("off", rush);
  await until("OFF waits for the expired host setter to settle", async () => (await listClients(rush)).find(row =>
    row.sessionId === timedBaseline.sessionId && row.revision === timedOff.revision && row.status === "pending"));
  assert.equal(await fs.readFile(baselineFile(timedBaseline.sessionId), "utf8"), timedSaved);
  await timed.snapshot("release-model-refresh");
  await aligned([timed], timedOff);
  const timedRestored = await timed.snapshot();
  assertRestored(timedRestored, timedBaseline);
  assert.equal(timedRestored.modelRefreshWaiting, false);
  assert.equal(timedRestored.modelRefreshReleases, 1);
  await assert.rejects(fs.access(baselineFile(timedBaseline.sessionId)), { code: "ENOENT" });
  assert.equal((await timed.request("new_session")).data.cancelled, false, "settled attempts must not permanently block transitions");
  await aligned([timed], timedOff);
  assert.notEqual((await timed.snapshot()).sessionId, timedBaseline.sessionId);
  await timed.close();
  verify("real native 30-second before-switch timeout is vetoed by a second synchronous handler; late model completion stays on its original owner and OFF remains recoverable");
}

const onSignal = () => { interrupted = true; for (const session of children) session.kill("SIGTERM"); };
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
let failure;
try { await main(); }
catch (error) { failure = error; }
finally {
  const cleanup = await Promise.allSettled([...children].map(session => session.close()));
  for (const result of cleanup) if (result.status === "rejected") failure ||= result.reason;
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}
if (failure) {
  console.error(`OMP RPC smoke failed: ${failure instanceof Error ? failure.message : String(failure)}`);
  process.exitCode = 1;
}
else {
  console.log(JSON.stringify({ ok: true, verifiedChecks: evidence.length, modelCalls: 0, cleaned: true, busyStreaming: "Not exercised: no model turn is permitted; cold resume is exercised with real sessions." }));
}
