import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_CATALOG, getCommandCompletions } from "../src/core/commands.mjs";
import { MODES } from "../src/core/lib.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = new Set();
afterEach(async () => {
  await Promise.all([...temporary].map((home) => fs.rm(home, { recursive: true, force: true })));
  temporary.clear();
});
async function home() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tibo-rush-complete-"));
  temporary.add(dir);
  return dir;
}

/**
 * Dedicated spawn for non-JSON CLI paths.
 * Do not reuse behavior.test.mjs `cli()` (it always appends `--json` and JSON.parse's).
 */
async function spawnCli(dir, ...args) {
  const child = Bun.spawn([process.execPath, path.join(root, "src/cli/controller.mjs"), ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, TIBO_RUSH_HOME: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function catalogValues() {
  return COMMAND_CATALOG.map((item) => item.value);
}

describe("command catalog", () => {
  test("five tokens in README order, covering MODES plus status", () => {
    expect(catalogValues()).toEqual(["regular", "fast", "extreme", "off", "status"]);
    for (const mode of MODES) expect(catalogValues()).toContain(mode);
    expect(MODES).not.toContain("status");
    expect(COMMAND_CATALOG).toHaveLength(5);
  });

  test("value equals label, with no trailing space", () => {
    for (const item of COMMAND_CATALOG) {
      expect(item.value).toBe(item.label);
      expect(item.value).not.toMatch(/\s/);
      expect(item.label).not.toMatch(/\s/);
      expect(typeof item.description).toBe("string");
      expect(item.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("getCommandCompletions", () => {
  test("empty prefix returns all five items in catalog order", () => {
    const items = getCommandCompletions("");
    expect(Array.isArray(items)).toBe(true);
    expect(items.map((item) => item.value)).toEqual(catalogValues());
  });

  test("prefix match is case-sensitive startsWith", () => {
    expect(getCommandCompletions("f").map((item) => item.value)).toEqual(["fast"]);
    expect(getCommandCompletions("ex").map((item) => item.value)).toEqual(["extreme"]);
    expect(getCommandCompletions("fast").map((item) => item.value)).toEqual(["fast"]);
    expect(getCommandCompletions("off").map((item) => item.value)).toEqual(["off"]);
    expect(getCommandCompletions("s").map((item) => item.value)).toEqual(["status"]);
    expect(getCommandCompletions("r").map((item) => item.value)).toEqual(["regular"]);
  });

  test("no match, wrong case, whitespace, and non-strings return null", () => {
    expect(getCommandCompletions("z")).toBeNull();
    expect(getCommandCompletions("warp")).toBeNull();
    expect(getCommandCompletions("Fast")).toBeNull();
    expect(getCommandCompletions("OFF")).toBeNull();
    expect(getCommandCompletions("fast ")).toBeNull();
    expect(getCommandCompletions(" fast")).toBeNull();
    expect(getCommandCompletions("fa st")).toBeNull();
    expect(getCommandCompletions("fast\t")).toBeNull();
    expect(getCommandCompletions("\n")).toBeNull();
    expect(getCommandCompletions(null)).toBeNull();
    expect(getCommandCompletions(undefined)).toBeNull();
    expect(getCommandCompletions(1)).toBeNull();
    expect(getCommandCompletions({})).toBeNull();
  });

  test("oversized prefix returns null without throwing", () => {
    expect(getCommandCompletions("a".repeat(1e6))).toBeNull();
  });

  test("completer is synchronous and returns a copy", () => {
    const result = getCommandCompletions("");
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).not.toBe(COMMAND_CATALOG);
    result[0].value = "mutated";
    expect(COMMAND_CATALOG[0].value).toBe("regular");
  });
});

describe("CLI has no --complete", () => {
  test("CLI with no args still prints usage and exits 1", async () => {
    const dir = await home();
    const result = await spawnCli(dir);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Usage");
    expect(result.stdout).not.toContain("--complete");
    expect(await fs.readdir(dir)).toEqual([]);
  });

  test("--help does not list --complete", async () => {
    const dir = await home();
    const result = await spawnCli(dir, "--help");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage");
    expect(result.stdout).not.toContain("--complete");
  });

  test("--complete is an unknown command", async () => {
    const dir = await home();
    const result = await spawnCli(dir, "--complete");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown command or mode");
    expect(await fs.readdir(dir)).toEqual([]);
  });

  test("--json --complete is an unknown command", async () => {
    const dir = await home();
    const result = await spawnCli(dir, "--json", "--complete");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown command or mode");
  });
});
