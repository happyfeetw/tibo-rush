import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { atomicJson, listClients, policyFor, readState, setMode } from "../src/core/lib.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = new Set();
afterEach(async () => {
  await Promise.all([...temporary].map(home => fs.rm(home, { recursive: true, force: true })));
  temporary.clear();
});
async function home() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-impact-test-"));
  temporary.add(dir);
  return dir;
}
async function cli(dir, ...args) {
  const child = Bun.spawn([process.execPath, path.join(root, "src/cli/controller.mjs"), ...args, "--json"], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, TIBO_IMPACT_HOME: dir },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { code, data: JSON.parse(code === 0 ? stdout : stderr) };
}
async function policies(dir) {
  const value = JSON.parse(await fs.readFile(path.join(root, "presets/tibo-impact.json"), "utf8"));
  await atomicJson(path.join(dir, "policies.json"), value);
  return value;
}
function client(state, patch = {}) {
  return {
    version: 1, pid: process.pid, sessionId: "session-live", cwd: os.tmpdir(),
    revision: state.revision, requestedMode: state.mode, appliedMode: state.mode,
    status: "applied", model: "openai-codex/gpt-6.1-sol", thinking: "high", tier: "default",
    updatedAt: new Date().toISOString(), ...patch,
  };
}
async function row(dir, name, value) {
  await atomicJson(path.join(dir, "clients", `${name}.json`), value);
}

// No process.env mutation: library calls take an explicit home, CLI runs in a private child.
describe("requested state and configurable policies", () => {
  test("missing state is off and a read creates nothing", async () => {
    const dir = await home();
    expect(await readState(dir)).toEqual({ version: 1, mode: "off", revision: "initial", updatedAt: new Date(0).toISOString() });
    expect(await fs.readdir(dir)).toEqual([]);
    const result = await cli(dir, "status");
    expect(result.code).toBe(0);
    expect(result.data.requested.mode).toBe("off");
    expect(result.data.policy).toBeNull();
    expect(await fs.readdir(dir)).toEqual([]);
  });

  test("invalid mode never creates or replaces a request", async () => {
    const dir = await home();
    await expect(setMode("warp", dir)).rejects.toMatchObject({ code: "INVALID_MODE" });
    expect(await fs.readdir(dir)).toEqual([]);
    const previous = await setMode("regular", dir);
    const bytes = await fs.readFile(path.join(dir, "state.json"), "utf8");
    expect((await cli(dir, "warp")).code).toBe(1);
    expect(await fs.readFile(path.join(dir, "state.json"), "utf8")).toBe(bytes);
    expect(await readState(dir)).toEqual(previous);
  });

  test.each(["{broken", JSON.stringify({ version: 1, modes: {} })])("bad policy rejects active request without advancing revision: %s", async invalid => {
    const dir = await home();
    const previous = await setMode("regular", dir);
    const bytes = await fs.readFile(path.join(dir, "state.json"), "utf8");
    await fs.writeFile(path.join(dir, "policies.json"), invalid);
    await expect(setMode("fast", dir)).rejects.toBeInstanceOf(Error);
    expect((await cli(dir, "extreme")).code).toBe(1);
    expect(await readState(dir)).toEqual(previous);
    expect(await fs.readFile(path.join(dir, "state.json"), "utf8")).toBe(bytes);
  });

  test("off bypasses malformed policies so restoration cannot be blocked", async () => {
    const dir = await home();
    const previous = await setMode("fast", dir);
    await fs.writeFile(path.join(dir, "policies.json"), "not json");
    expect(await policyFor("off", dir)).toBeNull();
    const result = await cli(dir, "off");
    expect(result.code).toBe(0);
    expect(result.data.requested.mode).toBe("off");
    expect(result.data.requested.revision).not.toBe(previous.revision);
    expect(result.data.policy).toBeNull();
  });

  test("custom full policy is selected by the library and real CLI", async () => {
    const dir = await home();
    const custom = await policies(dir);
    custom.modes.fast.main = { provider: "openai-codex", id: "gpt-6.1-sol", thinking: "low" };
    custom.modes.fast.roles.task = "openai-codex/gpt-6.1-sol:low";
    custom.modes.fast.tier = "priority";
    custom.modes.fast.instruction = "A custom local policy instruction.";
    await atomicJson(path.join(dir, "policies.json"), custom);
    expect(await policyFor("fast", dir)).toEqual(custom.modes.fast);
    const result = await cli(dir, "fast");
    expect(result.code).toBe(0);
    expect(result.data.policy).toEqual(custom.modes.fast);
    const revision = result.data.requested.revision;
    custom.modes.fast.instruction = "Updated local policy instruction.";
    await atomicJson(path.join(dir, "policies.json"), custom);
    const reapplied = await cli(dir, "fast");
    expect(reapplied.code).toBe(0);
    expect(reapplied.data.requested.revision).not.toBe(revision);
    expect(reapplied.data.policy.instruction).toBe(custom.modes.fast.instruction);
  });

  test.each(["roles", "agentModels", "agentTiers"])("prototype keys in %s are rejected before a write", async key => {
    const dir = await home();
    const custom = await policies(dir);
    const value = key === "agentTiers" ? "default" : key === "agentModels" ? "@task" : "openai-codex/gpt-6.1-sol:high";
    Object.defineProperty(custom.modes.regular[key], "__proto__", { value, enumerable: true });
    await atomicJson(path.join(dir, "policies.json"), custom);
    await expect(setMode("regular", dir)).rejects.toBeInstanceOf(Error);
    expect((await readState(dir)).revision).toBe("initial");
  });

  test("unsupported main providers fail rather than pretending the OpenAI tier applies", async () => {
    const dir = await home();
    const custom = await policies(dir);
    custom.modes.extreme.main.provider = "anthropic";
    await atomicJson(path.join(dir, "policies.json"), custom);
    await expect(setMode("extreme", dir)).rejects.toBeInstanceOf(Error);
    expect((await readState(dir)).revision).toBe("initial");
  });

  test.each(["ultrafast", "non-openai-role", "non-openai-direct", "implicit-target"])("unsafe agent tier is rejected without changing the request: %s", async scenario => {
    const dir = await home();
    const previous = await setMode("regular", dir);
    const custom = await policies(dir);
    const policy = custom.modes.extreme;
    if (scenario === "ultrafast") policy.agentTiers.task = "ultrafast";
    if (scenario === "non-openai-role") policy.roles.task = "anthropic/claude-opus:high";
    if (scenario === "non-openai-direct") policy.agentModels.task = "google/gemini-flash:high";
    if (scenario === "implicit-target") policy.agentTiers.unconfiguredAgent = "priority";
    await atomicJson(path.join(dir, "policies.json"), custom);
    await expect(setMode("extreme", dir)).rejects.toMatchObject({ code: "POLICY_MALFORMED" });
    expect(await readState(dir)).toEqual(previous);
    expect((await setMode("off", dir)).mode).toBe("off");
  });

  test("default shared home is portable and status remains read-only", async () => {
    const dir = await home();
    const child = Bun.spawn([process.execPath, path.join(root, "src/cli/controller.mjs"), "status", "--json"], {
      cwd: dir, env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, TMPDIR: dir },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const status = JSON.parse(stdout);
    expect(status.home).toBe(path.join(dir, ".tibo-impact"));
    expect(status.requested.mode).toBe("off");
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

describe("real CLI rollout accounting", () => {
  test("zero clients is not all applied", async () => {
    const result = await cli(await home(), "regular");
    expect(result.code).toBe(0);
    expect(result.data.clients.live).toBe(0);
    expect(result.data.clients.allKnownApplied).toBe(false);
    expect(result.data.bootstrapReminder).toBe(true);
  });

  test("matching mode with stale revision remains pending", async () => {
    const dir = await home();
    const state = await setMode("regular", dir);
    await row(dir, "stale-revision", client(state, { revision: "previous-revision" }));
    const result = await cli(dir, "status");
    expect(result.code).toBe(0);
    expect(result.data.clients).toMatchObject({ live: 1, applied: 0, pending: 1, error: 0, allKnownApplied: false });
  });

  test("only the exact request revision and mode counts as applied", async () => {
    const dir = await home();
    const state = await setMode("extreme", dir);
    await row(dir, "current", client(state));
    let result = await cli(dir, "status");
    expect(result.data.clients).toMatchObject({ live: 1, applied: 1, pending: 0, allKnownApplied: true });
    await row(dir, "wrong-request", client(state, { sessionId: "other", requestedMode: "fast" }));
    result = await cli(dir, "status");
    expect(result.data.clients).toMatchObject({ live: 2, applied: 1, pending: 1, allKnownApplied: false });
  });

  test("stale heartbeat and a known exited PID are omitted", async () => {
    const dir = await home();
    const state = await setMode("regular", dir);
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve, reject) => { exited.once("exit", resolve); exited.once("error", reject); });
    await row(dir, "live", client(state));
    await row(dir, "old-heartbeat", client(state, { sessionId: "old", updatedAt: new Date(Date.now() - 60_000).toISOString() }));
    await row(dir, "dead", client(state, { sessionId: "dead", pid: exited.pid }));
    expect((await listClients(dir)).map(item => item.sessionId)).toEqual(["session-live"]);
    const result = await cli(dir, "status");
    expect(result.data.clients.live).toBe(1);
    expect(result.data.clients.rows.map(item => item.sessionId)).toEqual(["session-live"]);
  });
});
