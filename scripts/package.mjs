#!/usr/bin/env bun
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const output = path.join(root, "dist");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "tibo-impact-pack-"));
try {
  await fs.mkdir(output, { recursive: true });
  for (const host of ["omp", "pi"]) {
    const name = `tibo-impact-${host}`;
    const staging = path.join(temporary, name);
    await fs.mkdir(staging);
    for (const relative of ["src/core", "src/cli", `src/hosts/${name}`, "bin", "presets", "README.md", "LICENSE"]) {
      await fs.cp(path.join(root, relative), path.join(staging, relative), { recursive: true });
    }
    const { omp, pi, scripts, ...metadata } = manifest;
    const packaged = {
      ...metadata,
      name,
      keywords: host === "pi" ? ["pi-package", "tibo-impact"] : ["omp", "tibo-impact"],
      [host]: host === "pi" ? pi : omp,
    };
    await fs.writeFile(path.join(staging, "package.json"), `${JSON.stringify(packaged, null, 2)}\n`);
    const { stdout } = await exec("npm", ["pack", "--json", "--pack-destination", output], { cwd: staging });
    const [result] = JSON.parse(stdout);
    console.log(JSON.stringify({ name, filename: result.filename, integrity: result.integrity, files: result.files.map(file => file.path) }));
  }
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
