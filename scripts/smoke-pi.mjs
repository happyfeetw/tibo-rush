// Real Pi RPC host validation. No user credentials, provider sockets, or model billing.
// Reference: Pi docs/rpc.md, rpc-commands.md, custom-provider.md (Pi 1.4.0).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson, listClients, policyFor, setMode } from "../src/core/lib.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const timeout = Number(process.env.PI_SMOKE_TIMEOUT_MS || 20_000);
assert(Number.isFinite(timeout) && timeout >= 1000, "PI_SMOKE_TIMEOUT_MS must be at least 1000");
assert(process.env.PI_BIN || process.env.PI_CLI_JS, "Set PI_BIN to a Pi executable or PI_CLI_JS to its CLI JavaScript file");
const executable = process.env.PI_BIN || process.env.NODE_BIN || "node";
const prefix = process.env.PI_BIN ? [] : [path.resolve(process.env.PI_CLI_JS)];
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tibo-impact-pi-smoke-"));
const home = path.join(temporary, "impact");
const workspace = path.join(temporary, "workspace");
const agentDir = path.join(temporary, "pi-agent");
const journal = path.join(temporary, "fixture.jsonl");
const release = path.join(temporary, "release");
const malformedPayload = path.join(temporary, "malformed-payload");
const blockedNetwork = path.join(temporary, "blocked-network.jsonl");
const children = new Set();

async function waitFor(label, probe) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(60);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function entries() {
  try {
    return (await fs.readFile(journal, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

class Rpc {
  constructor(args, env) {
    this.pending = new Map();
    this.events = [];
    this.stderr = "";
    this.nextId = 0;
    this.failure = null;
    this.child = spawn(executable, [...prefix, ...args], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
    children.add(this);
    this.exited = new Promise(resolve => {
      this.child.once("exit", (code, signal) => {
        this.fail(new Error(`Pi exited (${code ?? signal})${this.stderr ? `: ${this.stderr}` : ""}`));
        resolve({ code, signal });
      });
      this.child.once("error", error => { this.fail(error); resolve({ error }); });
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-16000); });
    this.child.stdin.on("error", error => this.fail(error));
    this.child.stdout.setEncoding("utf8");
    let buffer = "";
    this.child.stdout.on("data", chunk => {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, boundary).replace(/\r$/, "");
        buffer = buffer.slice(boundary + 1);
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); }
        catch { this.fail(new Error(`Non-JSON Pi stdout: ${line}`)); continue; }
        if (record.type === "response" && this.pending.has(record.id)) {
          const pending = this.pending.get(record.id);
          this.pending.delete(record.id);
          clearTimeout(pending.timer);
          if (record.success) pending.resolve(record.data);
          else pending.reject(new Error(`${record.command}: ${record.error}`));
        } else this.events.push(record);
      }
    });
  }
  fail(error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  request(type, fields = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = `smoke-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi ${type} timed out; stderr: ${this.stderr}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, error => {
        if (error) this.fail(error);
      });
    });
  }
  async close(signal) {
    if (!this.failure) {
      if (signal) this.child.kill(signal);
      else this.child.stdin.end();
    }
    let timer;
    try {
      await Promise.race([
        this.exited,
        new Promise(resolve => { timer = setTimeout(() => { this.child.kill("SIGKILL"); resolve(); }, 3000); }),
      ]);
      await this.exited;
    } finally { clearTimeout(timer); children.delete(this); }
  }
}

// A custom provider replaces the entire openai-codex catalog and API implementation.
// onPayload is honored, but this synthetic transport is NOT OpenAI SDK verification.
function fixtureSource(modelIds) {
  return `import fs from "node:fs/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const log = value => fs.appendFile(process.env.TIBO_PI_FIXTURE_JOURNAL, JSON.stringify(value) + "\\n");
export default function(pi) {
  pi.registerProvider("openai-codex", {
    name: "Offline smoke fixture", baseUrl: "https://chatgpt.com/backend-api", apiKey: "synthetic-not-a-credential",
    api: "openai-codex-responses",
    models: ${JSON.stringify(modelIds)}.map(id => ({ id, name: id, reasoning: true,
      thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 })),
    streamSimple(model, context, options = {}) {
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        try {
          const payload = { model: model.id, stream: true, input: [], store: false, service_tier: "default" };
          const transformed = await options.onPayload?.(payload, model);
          await log({ type: "request", model: model.id, reasoning: options.reasoning,
            payload: transformed === undefined ? payload : transformed });
          stream.push({ type: "start", partial: message });
          const lastUser = [...context.messages].reverse().find(item => item.role === "user");
          const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
          if (text?.includes("SMOKE_HOLD")) {
            if (text.includes("SMOKE_HOLD_MALFORMED")) {
              while (true) {
                if (options.signal?.aborted) throw new Error("fixture aborted");
                try { await fs.access(process.env.TIBO_PI_FIXTURE_MALFORMED); break; }
                catch (error) { if (error.code !== "ENOENT") throw error; }
                await new Promise(resolve => setTimeout(resolve, 40));
              }
              // Exercise Pi's actual before_provider_request hook for the old run
              // only after the adapter has observed the newer pending revision.
              const malformed = { ...payload, input: null };
              const rejected = await options.onPayload?.(malformed, model);
              await log({ type: "malformed-request", model: model.id,
                payload: rejected === undefined ? malformed : rejected });
              // A later valid payload from the same run must retain its old tier.
              const retry = await options.onPayload?.(payload, model);
              await log({ type: "held-retry", model: model.id,
                payload: retry === undefined ? payload : retry });
            }
            while (true) {
              if (options.signal?.aborted) throw new Error("fixture aborted");
              try { await fs.access(process.env.TIBO_PI_FIXTURE_RELEASE); break; }
              catch (error) { if (error.code !== "ENOENT") throw error; }
              await new Promise(resolve => setTimeout(resolve, 40));
            }
          }
          message.content.push({ type: "text", text: "local fixture completed" });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "local fixture completed", partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: "local fixture completed", partial: message });
          stream.push({ type: "done", reason: "stop", message });
        } catch (error) {
          message.stopReason = options.signal?.aborted ? "aborted" : "error";
          message.errorMessage = String(error);
          stream.push({ type: "error", reason: message.stopReason, error: message });
        } finally { stream.end(); }
      })();
      return stream;
    },
  });
}
`;
}

// Fail closed even if the host or one of its dependencies attempts startup telemetry.
const networkGuard = `const fs = require("node:fs");
function blocked() {
  fs.appendFileSync(process.env.TIBO_PI_NETWORK_LOG, JSON.stringify({ attempted: true }) + "\\n");
  throw new Error("smoke-pi forbids all network access");
}
require("node:net").Socket.prototype.connect = blocked;
require("node:net").connect = blocked;
require("node:net").createConnection = blocked;
require("node:tls").connect = blocked;
for (const name of ["node:http", "node:https"]) {
  require(name).request = blocked;
  require(name).get = blocked;
}
require("node:dgram").createSocket = blocked;
globalThis.fetch = blocked;
require("node:module").syncBuiltinESMExports();
`;

let failure;
try {
  await Promise.all([workspace, agentDir, home, path.join(temporary, "user-home")].map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
  const policies = JSON.parse(await fs.readFile(path.join(root, "presets/tibo-impact.json"), "utf8"));
  await atomicJson(path.join(home, "policies.json"), policies);
  const baseline = { provider: "openai-codex", id: "tibo-smoke-baseline", thinking: "low" };
  const modelIds = [...new Set([baseline.id, ...Object.values(policies.modes).map(policy => policy.main.id)])];
  const fixture = path.join(temporary, "fixture.ts");
  const guard = path.join(temporary, "network-guard.cjs");
  await fs.writeFile(fixture, fixtureSource(modelIds), { mode: 0o600 });
  await fs.writeFile(guard, networkGuard, { mode: 0o600 });
  await atomicJson(path.join(agentDir, "settings.json"), { autoCompaction: { enabled: false }, autoRetry: { enabled: false } });
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin", HOME: path.join(temporary, "user-home"),
    TMPDIR: temporary, XDG_CONFIG_HOME: path.join(temporary, "config"),
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0",
    TIBO_IMPACT_HOME: home, TIBO_PI_FIXTURE_JOURNAL: journal,
    TIBO_PI_FIXTURE_RELEASE: release, TIBO_PI_FIXTURE_MALFORMED: malformedPayload,
    TIBO_PI_NETWORK_LOG: blockedNetwork,
    NODE_OPTIONS: `--require=${JSON.stringify(guard)}`, NO_COLOR: "1",
  };
  const commonArgs = ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-tools",
    "--extension", fixture, "--extension", path.join(root, "src/hosts/tibo-impact-pi/index.ts"),
    "--session-dir", path.join(temporary, "sessions")];
  function start(args = []) { return new Rpc([...commonArgs, ...args], env); }
  async function client(rpc, requested, status = "applied") {
    return waitFor(`Pi ${requested.mode} ${status} revision ${requested.revision}`, async () => {
      if (rpc.failure) throw rpc.failure;
      const row = (await listClients(home)).find(item => item.pid === rpc.child.pid && item.host === "pi");
      if (row?.status === "error" && status !== "error") throw new Error(`Pi adapter error: ${row.error}`);
      return row?.revision === requested.revision && row.requestedMode === requested.mode && row.status === status && row;
    });
  }
  async function actual(rpc, expected) {
    const state = await rpc.request("get_state");
    assert.equal(state.model?.provider, expected.provider);
    assert.equal(state.model?.id, expected.id);
    assert.equal(state.thinkingLevel, expected.thinking);
    return state;
  }
  async function command(rpc, argument) {
    // Never let an unknown slash command fall through as a billed/model prompt.
    const { commands } = await rpc.request("get_commands");
    assert(commands.some(item => item.name === "tibo-impact" && item.source === "extension"), "tibo-impact extension command is not registered");
    const before = (await entries()).length;
    const response = await rpc.request("prompt", { message: `/tibo-impact ${argument}` });
    assert.equal(response?.disposition, "handled", "extension command unexpectedly started a provider run");
    assert.equal((await entries()).length, before, "extension command invoked the fixture model");
  }
  async function turn(rpc, marker) {
    const eventIndex = rpc.events.length;
    const before = (await entries()).length;
    const response = await rpc.request("prompt", { message: marker });
    assert.equal(response?.disposition, "started");
    await waitFor("synthetic provider request", async () => (await entries()).length > before);
    return { before, eventIndex };
  }
  async function settled(rpc, eventIndex) {
    await waitFor("agent_settled", async () => {
      if (rpc.failure) throw rpc.failure;
      return rpc.events.slice(eventIndex).some(event => event.type === "agent_settled");
    });
    const { text } = await rpc.request("get_last_assistant_text");
    assert.equal(text, "local fixture completed", "provider run did not complete successfully");
  }

  let rpc = start(["--provider", baseline.provider, "--model", baseline.id, "--thinking", baseline.thinking]);
  const off = { mode: "off", revision: "initial" };
  await client(rpc, off);
  await actual(rpc, baseline);
  await command(rpc, "status");
  const regular = await setMode("regular", home);
  await client(rpc, regular);
  await actual(rpc, (await policyFor("regular", home)).main);
  const fast = await setMode("fast", home);
  await client(rpc, fast);
  const fastPolicy = await policyFor("fast", home);
  await actual(rpc, fastPolicy.main);

  // A live stream must retain its model and thinking while a newer revision waits.
  const held = await turn(rpc, "SMOKE_HOLD: deterministic offline busy interval");
  assert.equal((await entries())[held.before].model, fastPolicy.main.id);
  assert.equal((await rpc.request("get_state")).isStreaming, true);
  const queued = await setMode("regular", home);
  const pending = await client(rpc, queued, "pending");
  assert.equal(pending.appliedMode, "fast");
  await actual(rpc, fastPolicy.main);
  await delay(1200); // Cross the adapter's idle-poll interval while still busy.
  assert.equal((await rpc.request("get_state")).isStreaming, true);
  await actual(rpc, fastPolicy.main);
  await fs.writeFile(release, "release");
  await settled(rpc, held.eventIndex);
  await client(rpc, queued);
  await actual(rpc, (await policyFor("regular", home)).main);

  // This checks the Pi hook path with synthetic payloads only, not OpenAI SDK serialization.
  const extreme = await setMode("extreme", home);
  const extremeRow = await client(rpc, extreme);
  assert.equal(extremeRow.capabilities?.routing, false);
  assert.equal(extremeRow.capabilities?.priority, true);
  await actual(rpc, (await policyFor("extreme", home)).main);
  const priorityTurn = await turn(rpc, "SMOKE_PRIORITY: synthetic payload observation only");
  await settled(rpc, priorityTurn.eventIndex);
  const priorityPayload = (await entries())[priorityTurn.before].payload;
  assert.equal(priorityPayload.service_tier, "priority", "real Pi before_provider_request hook did not transform the synthetic payload");

  async function stalePayloadFailure(mode, applied) {
    await fs.rm(release, { force: true });
    await fs.rm(malformedPayload, { force: true });
    const busy = await turn(rpc, `SMOKE_HOLD_MALFORMED: old extreme request before ${mode}`);
    assert.equal((await entries())[busy.before].payload.service_tier, "priority");
    const next = await setMode(mode, home);
    const waiting = await client(rpc, next, "pending");
    assert.equal(waiting.appliedRevision, applied.revision);
    await fs.writeFile(malformedPayload, "invoke malformed old payload hook");
    await waitFor("malformed old payload diagnostic", async () => {
      const row = (await listClients(home)).find(item => item.pid === rpc.child.pid && item.host === "pi");
      return row?.revision === next.revision && row.error?.includes(`applied extreme revision ${applied.revision}`) && row;
    });
    await waitFor("old request retry hook", async () => (await entries()).slice(busy.before).some(item => item.type === "held-retry"));
    const payloads = (await entries()).slice(busy.before);
    assert.equal(payloads.find(item => item.type === "malformed-request").payload.service_tier, "default", "malformed payload must not be transformed");
    assert.equal(payloads.find(item => item.type === "held-retry").payload.service_tier, "priority", "pending revision changed the in-flight tier");
    await delay(1200); // Ensure the old hook failure cannot poison the next poll.
    const pendingAfterFailure = await client(rpc, next, "pending");
    assert.equal(pendingAfterFailure.appliedRevision, applied.revision);
    assert.equal(pendingAfterFailure.tier, "priority");
    assert(pendingAfterFailure.error.includes(applied.revision), "hook diagnostic lost its actual applied revision");
    assert.equal((await rpc.request("get_state")).isStreaming, true);
    await actual(rpc, (await policyFor("extreme", home)).main);
    await fs.writeFile(release, "release");
    await settled(rpc, busy.eventIndex);
    const completed = await client(rpc, next);
    assert.equal(completed.appliedRevision, next.revision, "pending revision required reissue after a stale payload failure");
    assert.equal(completed.error, undefined, "old hook error was attributed to the new revision");
    await actual(rpc, mode === "off" ? baseline : (await policyFor(mode, home)).main);
    return completed;
  }

  // OFF must restore on this exact revision after an old extreme hook fails.
  const offAfterFailure = await stalePayloadFailure("off", extreme);
  assert.equal(offAfterFailure.tier, "none");
  // A newer active revision must not be blamed for that same old-request error.
  const nextExtreme = await setMode("extreme", home);
  await client(rpc, nextExtreme);
  await stalePayloadFailure("regular", nextExtreme);

  // Restoration must not depend on policy parsing.
  await fs.writeFile(path.join(home, "policies.json"), "{ malformed policy");
  const restored = await setMode("off", home);
  await client(rpc, restored);
  await actual(rpc, baseline);
  await atomicJson(path.join(home, "policies.json"), policies);

  // Persist a real session, leave it under an active override, then emulate a crash.
  const active = await setMode("fast", home);
  await client(rpc, active);
  const savedTurn = await turn(rpc, "SMOKE_PERSIST: create a resumable private session");
  await settled(rpc, savedTurn.eventIndex);
  const saved = await actual(rpc, fastPolicy.main);
  assert(saved.sessionFile, "Pi did not persist a resumable session");
  await fs.access(saved.sessionFile);
  await rpc.close("SIGKILL");
  const coldOff = await setMode("off", home);
  rpc = start(["--session", saved.sessionFile]);
  await client(rpc, coldOff);
  const resumed = await actual(rpc, baseline);
  assert.equal(resumed.sessionId, saved.sessionId, "cold resume opened a different session");
  await command(rpc, "status");
  await rpc.close();
} catch (error) {
  failure = error;
} finally {
  await Promise.all([...children].map(rpc => rpc.close()));
  try {
    const attempts = await fs.readFile(blockedNetwork, "utf8");
    if (attempts.trim()) failure = new Error(`Pi attempted forbidden network access (${attempts.trim().split("\n").length} attempts)`, { cause: failure });
  } catch (error) { if (error.code !== "ENOENT") failure ??= error; }
  await fs.rm(temporary, { recursive: true, force: true });
}
if (failure) {
  console.error(failure.stack || failure);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    host: "pi", result: "passed", checks: ["registered-command", "real-model-and-thinking", "busy-pending-preservation", "synthetic-provider-hook", "stale-payload-off-restoration", "stale-payload-active-revision", "off-with-malformed-policy", "cold-resume-restoration"],
    priority: { hook: "verified against real Pi with a synthetic provider payload", nativeOpenAiTransport: "unverified: no OpenAI SDK or external request is exercised" },
    routing: "unsupported on Pi; no frontend/subagent routing claimed", authentication: "isolated; synthetic provider key only", network: "forbidden",
  }, null, 2));
}
