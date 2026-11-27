#!/usr/bin/env node
/**
 * Runs Vitest. On Windows, a lowercase drive letter in the working directory
 * (VS Code opens terminals at "c:\...") makes Vitest load itself twice and fail
 * with "Vitest failed to find the runner". Starting it from the same folder
 * spelled with an uppercase drive letter avoids that. Elsewhere this is a no-op.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const cwd = process.cwd().replace(/^[a-z]:/, (d) => d.toUpperCase());
const bin = join(cwd, "node_modules", "vitest", "vitest.mjs");
const r = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { cwd, stdio: "inherit" });
process.exit(r.status ?? 1);
