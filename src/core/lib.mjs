import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const MODES = ["off", "regular", "fast", "extreme"];

const DEFAULT_HOME = path.join(homedir(), ".tibo-impact");
const BUNDLED_POLICIES = fileURLToPath(new URL("../../presets/tibo-impact.json", import.meta.url));
const HEARTBEAT_MAX_AGE_MS = 30_000;
const CLIENT_STATUSES = new Set(["applied", "pending", "error"]);


export class TiboImpactError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "TiboImpactError";
    this.code = code ?? "TIBO_IMPACT_ERROR";
  }
}

/** @returns {string} */
export function getHome() {
  const home = process.env.TIBO_IMPACT_HOME || DEFAULT_HOME;
  return path.resolve(home);
}

/**
 * @param {string} home
 */
async function ensureHomeDir(home) {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isIsoDateString(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

/**
 * @param {unknown} raw
 * @returns {{ version: 1, mode: string, revision: string, updatedAt: string }}
 */
function parseRequestedState(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TiboImpactError("state.json: root must be an object", { code: "STATE_MALFORMED" });
  }
  const record = raw;
  if (record.version !== 1) {
    throw new TiboImpactError("state.json: version must be 1", { code: "STATE_MALFORMED" });
  }
  if (typeof record.mode !== "string" || !MODES.includes(record.mode)) {
    throw new TiboImpactError(`state.json: invalid mode "${String(record.mode)}"`, {
      code: "STATE_MALFORMED",
    });
  }
  if (typeof record.revision !== "string" || record.revision.length === 0) {
    throw new TiboImpactError("state.json: revision must be a non-empty string", {
      code: "STATE_MALFORMED",
    });
  }
  if (!isIsoDateString(record.updatedAt)) {
    throw new TiboImpactError("state.json: updatedAt must be a valid ISO-8601 string", {
      code: "STATE_MALFORMED",
    });
  }
  return {
    version: 1,
    mode: record.mode,
    revision: record.revision,
    updatedAt: record.updatedAt,
  };
}

/**
 * @param {unknown} raw
 */
function parseClientRecord(raw, fileLabel) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TiboImpactError(`${fileLabel}: root must be an object`, { code: "CLIENT_MALFORMED" });
  }
  const record = raw;
  if (record.version !== 1) {
    throw new TiboImpactError(`${fileLabel}: version must be 1`, { code: "CLIENT_MALFORMED" });
  }
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) {
    throw new TiboImpactError(`${fileLabel}: pid must be a positive integer`, {
      code: "CLIENT_MALFORMED",
    });
  }
  for (const key of [
    "sessionId",
    "cwd",
    "revision",
    "requestedMode",
    "appliedMode",
    "model",
    "thinking",
    "tier",
  ]) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      throw new TiboImpactError(`${fileLabel}: ${key} must be a non-empty string`, {
        code: "CLIENT_MALFORMED",
      });
    }
  }
  if (!MODES.includes(record.requestedMode)) {
    throw new TiboImpactError(`${fileLabel}: invalid requestedMode`, { code: "CLIENT_MALFORMED" });
  }
  if (!MODES.includes(record.appliedMode)) {
    throw new TiboImpactError(`${fileLabel}: invalid appliedMode`, { code: "CLIENT_MALFORMED" });
  }
  if (!CLIENT_STATUSES.has(record.status)) {
    throw new TiboImpactError(`${fileLabel}: invalid status`, { code: "CLIENT_MALFORMED" });
  }
  if (record.error !== undefined && typeof record.error !== "string") {
    throw new TiboImpactError(`${fileLabel}: error must be a string when present`, {
      code: "CLIENT_MALFORMED",
    });
  }
  if (record.routingMode !== undefined && !MODES.includes(record.routingMode)) {
    throw new TiboImpactError(`${fileLabel}: invalid routingMode`, { code: "CLIENT_MALFORMED" });
  }
  for (const key of ["routingRevision", "appliedRevision"]) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      throw new TiboImpactError(`${fileLabel}: ${key} must be a string`, { code: "CLIENT_MALFORMED" });
    }
  }
  if (record.host !== undefined && record.host !== "omp" && record.host !== "pi") {
    throw new TiboImpactError(`${fileLabel}: host must be omp or pi`, { code: "CLIENT_MALFORMED" });
  }
  if (record.capabilities !== undefined &&
      (!isRecord(record.capabilities) || typeof record.capabilities.routing !== "boolean" ||
       typeof record.capabilities.priority !== "boolean" ||
       Object.keys(record.capabilities).some(key => key !== "routing" && key !== "priority"))) {
    throw new TiboImpactError(`${fileLabel}: capabilities must contain routing and priority booleans`, { code: "CLIENT_MALFORMED" });
  }
  if (!isIsoDateString(record.updatedAt)) {
    throw new TiboImpactError(`${fileLabel}: updatedAt must be a valid ISO-8601 string`, {
      code: "CLIENT_MALFORMED",
    });
  }
  return {
    version: 1,
    pid: record.pid,
    sessionId: record.sessionId,
    cwd: record.cwd,
    revision: record.revision,
    requestedMode: record.requestedMode,
    appliedMode: record.appliedMode,
    status: record.status,
    model: record.model,
    thinking: record.thinking,
    tier: record.tier,
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.routingMode !== undefined ? { routingMode: record.routingMode } : {}),
    ...(record.routingRevision !== undefined ? { routingRevision: record.routingRevision } : {}),
    ...(record.appliedRevision !== undefined ? { appliedRevision: record.appliedRevision } : {}),
    ...(record.host !== undefined ? { host: record.host } : {}),
    ...(record.capabilities !== undefined ? { capabilities: record.capabilities } : {}),
    updatedAt: record.updatedAt,
  };
}

/**
 * @param {number} pid
 */
function isLivePid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


/**
 * @param {string} filePath
 * @param {unknown} value
 */
export async function atomicJson(filePath, value) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await fs.writeFile(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * @param {string} [home]
 */
export async function readState(home = getHome()) {
  const statePath = path.join(home, "state.json");
  try {
    const raw = await fs.readFile(statePath, "utf8");
    try {
      return parseRequestedState(JSON.parse(raw));
    } catch (err) {
      if (err instanceof TiboImpactError) {
        throw err;
      }
      if (err instanceof SyntaxError) {
        throw new TiboImpactError("state.json: invalid JSON", { code: "STATE_MALFORMED" });
      }
      throw err;
    }
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return {
        version: 1,
        mode: "off",
        revision: "initial",
        updatedAt: new Date(0).toISOString(),
      };
    }
    throw err;
  }
}

/**
 * @param {string} mode
 * @param {string} [home]
 */
export async function setMode(mode, home = getHome()) {
  if (!MODES.includes(mode)) {
    throw new TiboImpactError(`Unknown mode: ${mode}`, { code: "INVALID_MODE" });
  }
  const resolvedHome = path.resolve(home);
  await policyFor(mode, resolvedHome);
  await ensureHomeDir(resolvedHome);
  const next = {
    version: 1,
    mode,
    revision: randomUUID(),
    updatedAt: new Date().toISOString(),
  };
  await atomicJson(path.join(resolvedHome, "state.json"), next);
  return next;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
const AGENT_TIERS = new Set(["none", "inherit", "auto", "default", "flex", "scale", "priority"]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const MODEL_ID = /^[^\s:@]+(?:\/[^\s:@]+)*$/;

/**
 * @param {string} label
 * @param {string} message
 * @returns {never}
 */
function invalidPolicy(label, message) {
  throw new TiboImpactError(`${label}: ${message}. Fix policies.json and reissue the mode; use off to restore.`, {
    code: "POLICY_MALFORMED",
  });
}

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function policyObject(value, keys, label) {
  if (!isRecord(value)) invalidPolicy(label, "must be an object");
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key) || !keys.includes(key)) invalidPolicy(`${label}.${key}`, "unknown or unsafe key");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) invalidPolicy(`${label}.${key}`, "is required");
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, string>}
 */
function policyMap(value, label) {
  if (!isRecord(value)) invalidPolicy(label, "must be a string map");
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key) || !NAME.test(key)) invalidPolicy(`${label}.${key}`, "invalid or unsafe name");
    if (typeof item !== "string" || item.trim() !== item || !item) {
      invalidPolicy(`${label}.${key}`, "must be a non-empty string without surrounding whitespace");
    }
  }
  return /** @type {Record<string, string>} */ (value);
}

/**
 * @param {string} value
 * @param {string} label
 */
function validateModelSelector(value, label) {
  const colon = value.lastIndexOf(":");
  const reference = colon < 0 ? value : value.slice(0, colon);
  if (colon >= 0 && value.slice(colon + 1) !== "inherit" && !THINKING_LEVELS.has(value.slice(colon + 1))) {
    invalidPolicy(label, "unknown thinking level suffix");
  }
  const slash = reference.indexOf("/");
  if (slash < 1 || !NAME.test(reference.slice(0, slash)) || !MODEL_ID.test(reference.slice(slash + 1))) {
    invalidPolicy(label, "use an explicit provider/model-id[:thinking] selector");
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {import("./types.ts").ImpactPolicy}
 */
function parsePolicy(value, label) {
  const policy = policyObject(value, ["main", "roles", "agentModels", "tier", "agentTiers", "instruction"], label);
  const main = policyObject(policy.main, ["provider", "id", "thinking"], `${label}.main`);
  if (main.provider !== "openai-codex") invalidPolicy(`${label}.main.provider`, "must be openai-codex (main service tier currently targets OpenAI only)");
  if (typeof main.id !== "string" || !MODEL_ID.test(main.id)) invalidPolicy(`${label}.main.id`, "invalid model id");
  if (typeof main.thinking !== "string" || !THINKING_LEVELS.has(main.thinking)) invalidPolicy(`${label}.main.thinking`, "unknown thinking level");
  const roles = policyMap(policy.roles, `${label}.roles`);
  for (const [role, selector] of Object.entries(roles)) validateModelSelector(selector, `${label}.roles.${role}`);
  const models = policyMap(policy.agentModels, `${label}.agentModels`);
  for (const [agent, selector] of Object.entries(models)) {
    if (selector.startsWith("@")) {
      const role = selector.slice(1);
      if (UNSAFE_KEYS.has(role) || !Object.hasOwn(roles, role)) invalidPolicy(`${label}.agentModels.${agent}`, `role ${selector} must be explicitly defined in roles`);
    } else validateModelSelector(selector, `${label}.agentModels.${agent}`);
  }
  if (policy.tier !== "default" && policy.tier !== "priority") invalidPolicy(`${label}.tier`, "must be default or priority");
  const tiers = policyMap(policy.agentTiers, `${label}.agentTiers`);
  for (const [agent, tier] of Object.entries(tiers)) {
    if (!AGENT_TIERS.has(tier)) invalidPolicy(`${label}.agentTiers.${agent}`, "unknown service tier");
    if (tier === "priority") {
      const selector = Object.hasOwn(models, agent) ? models[agent] : undefined;
      if (!selector) invalidPolicy(`${label}.agentTiers.${agent}`, "priority requires an explicit agentModels target");
      const target = selector.startsWith("@") ? roles[selector.slice(1)] : selector;
      const provider = target.slice(0, target.indexOf("/"));
      if (provider !== "openai" && provider !== "openai-codex") {
        invalidPolicy(`${label}.agentTiers.${agent}`, "priority is restricted to explicit OpenAI targets");
      }
    }
  }
  if (typeof policy.instruction !== "string" || !policy.instruction.trim()) invalidPolicy(`${label}.instruction`, "must be a non-empty string");
  return /** @type {import("./types.ts").ImpactPolicy} */ (/** @type {unknown} */ (policy));
}

/**
 * Load a complete policy document. OFF deliberately does not read policy files.
 * @param {string} mode
 * @param {string} [home]
 * @returns {Promise<import("./types.ts").ImpactPolicy | null>}
 */
export async function policyFor(mode, home = getHome()) {
  if (!MODES.includes(mode)) throw new TiboImpactError(`Unknown mode: ${mode}`, { code: "INVALID_MODE" });
  if (mode === "off") return null;
  let source = path.join(home, "policies.json");
  let text;
  try {
    text = await fs.readFile(source, "utf8");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw new TiboImpactError(`Cannot read ${source}: ${error instanceof Error ? error.message : String(error)}`, { code: "POLICY_READ" });
    }
    source = BUNDLED_POLICIES;
    try {
      text = await fs.readFile(source, "utf8");
    } catch (error) {
      throw new TiboImpactError(`Cannot read bundled policies ${source}: ${error instanceof Error ? error.message : String(error)}`, { code: "POLICY_READ" });
    }
  }
  let raw;
  try { raw = JSON.parse(text); }
  catch { invalidPolicy(source, "invalid JSON"); }
  const document = policyObject(raw, ["version", "modes"], source);
  if (document.version !== 1) invalidPolicy(`${source}.version`, "must be 1");
  const modes = policyObject(document.modes, ["regular", "fast", "extreme"], `${source}.modes`);
  /** @type {Record<string, import("./types.ts").ImpactPolicy>} */
  const policies = {};
  for (const name of ["regular", "fast", "extreme"]) policies[name] = parsePolicy(modes[name], `${source}.modes.${name}`);
  return policies[mode];
}

/**
 * @param {string} [home]
 */
export async function listClients(home = getHome()) {
  const clientsDir = path.join(home, "clients");
  let names;
  try {
    names = await fs.readdir(clientsDir);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const now = Date.now();
  /** @type {Array<import("./types.ts").ImpactClient>} */
  const live = [];

  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(clientsDir, name);
    let parsed;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      parsed = parseClientRecord(JSON.parse(raw), name);
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        continue;
      }
      if (err instanceof SyntaxError) {
        throw new TiboImpactError(`${name}: invalid JSON`, { code: "CLIENT_MALFORMED" });
      }
      throw err;
    }
    if (!isLivePid(parsed.pid)) {
      continue;
    }
    const ageMs = now - Date.parse(parsed.updatedAt);
    if (!Number.isFinite(ageMs) || ageMs > HEARTBEAT_MAX_AGE_MS || ageMs < 0) {
      continue;
    }
    live.push(parsed);
  }

  live.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return live;
}
