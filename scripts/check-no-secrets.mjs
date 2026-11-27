#!/usr/bin/env node
/**
 * Guard rail run in CI: fails if anything that looks like a secret is
 * committed, with extra-strict rules for the exported n8n workflows (the
 * brief requires that exported workflow JSON never contains secrets).
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "_generated", ".convex"]);
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|css|example|txt)$/;

const PATTERNS = [
  [/\bsk_(live|test)_[A-Za-z0-9]{10,}/, "Clerk secret key"],
  [/\bpk_live_[A-Za-z0-9]{10,}/, "Clerk live publishable key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\b(c2n|n2c)-[\w-]+:[A-Za-z0-9_-]{32,}/, "LendLoop HMAC key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/https:\/\/discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]+/, "Discord webhook URL"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (TEXT_EXT.test(name) && s.size < 2_000_000) out.push(p);
  }
  return out;
}

const problems = [];

for (const file of walk(root)) {
  const rel = relative(root, file);
  if (rel === "package-lock.json" || rel === "scripts/check-no-secrets.mjs") continue;
  const text = readFileSync(file, "utf8");
  for (const [re, label] of PATTERNS) if (re.test(text)) problems.push(`${rel}: looks like a ${label}`);
}

// Stricter rules for exported workflows.
const wfDir = join(root, "n8n/workflows");
for (const name of readdirSync(wfDir).filter((f) => f.endsWith(".json"))) {
  const wf = JSON.parse(readFileSync(join(wfDir, name), "utf8"));
  for (const node of wf.nodes) {
    if (node.credentials && Object.values(node.credentials).some((c) => typeof c !== "object" || !c.id))
      problems.push(`${name} / ${node.name}: inline credential data`);
    const params = JSON.stringify(node.parameters ?? {});
    // Header values / URLs must come from expressions, not literals.
    if (/x-lendloop-signature"\s*:\s*"[0-9a-f]{16,}/i.test(params)) problems.push(`${name} / ${node.name}: literal signature`);
    if (/\.convex\.(site|cloud)/.test(params)) problems.push(`${name} / ${node.name}: hard-coded Convex URL (use $env)`);
    const code = node.parameters?.jsCode ?? "";
    if (/['"`][A-Za-z0-9+/_-]{32,}['"`]/.test(code)) problems.push(`${name} / ${node.name}: long literal in Code node`);
  }
}

// Committed env files (only *.example are allowed).
try {
  const tracked = execSync("git ls-files", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n");
  for (const f of tracked) if (/(^|\/)\.env(\.|$)/.test(f) && !f.endsWith(".example")) problems.push(`${f}: env file is tracked by git`);
} catch {
  /* not a git checkout; skip */
}

if (problems.length) {
  console.error("Possible secrets found:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("No secrets found (repo + exported n8n workflows).");
