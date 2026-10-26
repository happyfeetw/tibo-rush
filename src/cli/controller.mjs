import process from "node:process";
import {
  MODES,
  TiboRushError,
  getHome,
  listClients,
  policyFor,
  readState,
  setMode,
} from "../core/lib.mjs";

const BOOTSTRAP_REMINDER =
  "提示：模式文件只控制已加载 tibo-rush 扩展的会话，不会把新扩展注入现有进程；" +
  "请对相关 OMP/Pi 主会话首次重启续接以加载对应扩展。当前无已注册且心跳有效的客户端。";

const USAGE = `tibo-rush — Tibo Rush shared mode CLI

用法 / Usage:
  tibo-rush <off|regular|fast|extreme>   设置请求模式 / set requested mode
  tibo-rush status                       只读状态 / read-only status
  tibo-rush --help                       显示帮助 / show help

选项 / Options:
  --json                                  JSON 输出（便于 smoke）/ machine-readable output

默认预设 / Bundled defaults (configurable):
  off       关闭（默认）/ disabled (default)
  regular   Sol high 主控 / Sol high main
  fast      Astra medium 主控 / Astra medium main
  extreme   fast mapping + OMP Codex Fast(priority), not ultrafast

配置 / Configuration:
  Bundled presets: presets/tibo-rush.json
  Override: <state-home>/policies.json (complete version:1 document, all three modes)
  State home: TIBO_RUSH_HOME or ~/.tibo-rush
  Reissue a mode after editing policies; each request creates a new revision.
  OFF restores without reading policies, even when the override is broken.
  Search routing and normal configured fallback chains are unchanged.
  Host capabilities differ: Pi does not apply OMP role routing or priority tiers.
  Client status rows report each host's actual capabilities.
`;

/** @typedef {{ total: number, byStatus: { applied: number, pending: number, error: number }, allKnownApplied: boolean, canClaimAllSessions: boolean }} ClientSummary */

/**
 * @param {Array<{ status: string, requestedMode: string, appliedMode: string, revision: string }>} clients
 * @param {{ mode: string, revision: string }} state
 */
function summarizeClients(clients, state) {
  const byStatus = { applied: 0, pending: 0, error: 0 };
  for (const client of clients) {
    const current = client.revision === state.revision && client.requestedMode === state.mode;
    const status = client.status === "error" ? "error" :
      current && client.appliedMode === state.mode && client.status === "applied" ? "applied" : "pending";
    byStatus[status] += 1;
  }

  const aligned =
    clients.length > 0 &&
    clients.every(
      (c) =>
        c.status === "applied" &&
        c.appliedMode === state.mode &&
        c.requestedMode === state.mode &&
        c.revision === state.revision,
    );

  return {
    total: clients.length,
    byStatus,
    allKnownApplied: aligned,
    canClaimAllSessions: clients.length > 0 && aligned,
  };
}

/**
 * @param {{ mode: string, revision: string, updatedAt: string }} state
 * @param {ClientSummary} summary
 * @param {Array<unknown>} clients
 */
async function buildPayload(state, summary, clients) {
  let policy = null;
  let policyError;
  try { policy = await policyFor(state.mode); }
  catch (error) { policyError = error instanceof Error ? error.message : String(error); }
  return {
    ok: true,
    home: getHome(),
    requested: {
      mode: state.mode,
      revision: state.revision,
      updatedAt: state.updatedAt,
    },
    // This is the current configured request, not a claim about any client's applied snapshot.
    policy,
    ...(policyError ? { policyError } : {}),
    clients: {
      live: summary.total,
      applied: summary.byStatus.applied,
      pending: summary.byStatus.pending,
      error: summary.byStatus.error,
      allKnownApplied: summary.allKnownApplied,
      rows: clients,
    },
    bootstrapReminder: summary.total === 0,
  };
}

/**
 * @param {{ mode: string, revision: string, updatedAt: string }} state
 * @param {ClientSummary} summary
 * @param {boolean} wrote
 */
function printHuman(state, summary, wrote) {
  const verb = wrote ? "已写入请求模式" : "当前请求模式";
  console.log(`${verb} / Requested mode: ${state.mode}`);
  console.log(`revision: ${state.revision}`);
  console.log(`updatedAt: ${state.revision === "initial" ? "尚未设置（默认 off）" : state.updatedAt}`);
  console.log(`home: ${getHome()}`);
  console.log("");

  if (summary.total === 0) {
    console.log("客户端 / Clients: 无有效心跳（0 live）");
    console.log(BOOTSTRAP_REMINDER);
    return;
  }

  console.log(
    `客户端 / Clients: ${summary.total} live — applied ${summary.byStatus.applied}, pending ${summary.byStatus.pending}, error ${summary.byStatus.error}`,
  );

  if (summary.canClaimAllSessions) {
    console.log("已知会话均已应用当前 revision / All known sessions report applied for this revision.");
  } else if (summary.byStatus.error > 0) {
    console.log("部分会话报错；未声称全部生效 / Some sessions errored; not claiming full rollout.");
  } else {
    console.log("仍有会话待同步；未声称全部生效 / Some sessions pending; not claiming full rollout.");
  }
}

/**
 * @param {Array<import("../core/types.ts").RushClient>} clients
 */
function printClientDetails(clients) {
  for (const client of clients) {
    const capabilities = client.capabilities
      ? `; routing ${client.capabilities.routing ? "supported" : "not supported"}; priority ${client.capabilities.priority ? "supported" : "not supported"}`
      : "; capabilities unknown";
    console.log(`${client.sessionId} [${client.host ?? "unknown host"}]: ${client.status}; main ${client.model}; routing mode ${client.routingMode ?? "unknown"}${capabilities}`);
    if (client.error) console.log(`  Error: ${client.error}`);
  }
}

/**
 * @param {boolean} jsonMode
 */
async function runStatus(jsonMode) {
  const state = await readState();
  const clients = await listClients();
  const summary = summarizeClients(clients, state);
  const payload = await buildPayload(state, summary, clients);

  if (jsonMode) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printHuman(state, summary, false);
  if (payload.policyError) console.log(`Policy error: ${payload.policyError}`);
  printClientDetails(clients);
}

/**
 * @param {string} mode
 * @param {boolean} jsonMode
 */
async function runSetMode(mode, jsonMode) {
  const state = await setMode(mode);
  const clients = await listClients();
  const summary = summarizeClients(clients, state);
  const payload = await buildPayload(state, summary, clients);

  if (jsonMode) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printHuman(state, summary, true);
  if (payload.policyError) console.log(`Policy error: ${payload.policyError}`);
  printClientDetails(clients);
}

/**
 * @param {string[]} argv
 */
async function run(argv) {
  const jsonMode = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE.trim());
    process.exit(args.length === 0 ? 1 : 0);
  }

  const command = args[0];
  if (command === "status") {
    if (args.length > 1) {
      throw new TiboRushError(`Unexpected arguments: ${args.slice(1).join(" ")}`, {
        code: "USAGE",
      });
    }
    await runStatus(jsonMode);
    return;
  }

  if (!MODES.includes(command)) {
    throw new TiboRushError(`Unknown command or mode: ${command}`, { code: "USAGE" });
  }

  if (args.length > 1) {
    throw new TiboRushError(`Unexpected arguments: ${args.slice(1).join(" ")}`, {
      code: "USAGE",
    });
  }

  await runSetMode(command, jsonMode);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    await run(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof TiboRushError ? err.code : "FATAL";
    if (argv.includes("--json")) {
      console.error(JSON.stringify({ ok: false, error: message, code }));
    } else {
      console.error(`错误 / Error: ${message}`);
    }
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
