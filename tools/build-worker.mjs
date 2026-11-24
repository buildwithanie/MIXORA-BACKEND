import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// OpenNext embeds values from Next .env files in its Worker output. Keep local
// development credentials out of the build without changing their contents.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hold = path.join(root, ".worker-build-env-hold");
const candidates = [".env", ".env.local", ".env.production", ".env.production.local",
  ".env.development", ".env.development.local", ".env.test", ".env.test.local"];
const moved = [];
const sensitiveValues = [];

function collectSensitiveValues(file) {
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match && /(TOKEN|SECRET|HMAC|KEY)/.test(match[1]) && match[2].trim().length >= 16) {
      sensitiveValues.push(match[2].trim());
    }
  }
}

function scanForSecrets(directory) {
  if (!existsSync(directory)) return false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (scanForSecrets(target)) return true;
    } else if (entry.isFile() && /\.(?:js|mjs|json)$/.test(entry.name)) {
      const bytes = readFileSync(target);
      if (sensitiveValues.some((value) => bytes.includes(Buffer.from(value)))) return true;
    }
  }
  return false;
}

async function main() {
  if (existsSync(hold)) throw new Error("A previous Worker build left held .env files. Restore them before retrying.");
  const present = candidates.filter((name) => existsSync(path.join(root, name)));
  if (present.length) mkdirSync(hold, { mode: 0o700 });
  try {
    for (const name of present) {
      const source = path.join(root, name);
      if (!statSync(source).isFile()) throw new Error(`Expected a regular ${name} file`);
      collectSensitiveValues(source);
      renameSync(source, path.join(hold, name));
      moved.push(name);
    }
    const staleEnv = path.join(root, ".open-next", "cloudflare", "next-env.mjs");
    if (existsSync(staleEnv)) rmSync(staleEnv);
    const command = path.join(root, "node_modules", "@opennextjs", "cloudflare", "dist", "cli", "index.js");
    const child = spawn(process.execPath, [command, "build"], { cwd: root, stdio: "inherit" });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (status) => resolve(status ?? 1));
    });
    if (scanForSecrets(path.join(root, ".open-next"))) {
      throw new Error("Sensitive local value found in Worker output; do not upload this build");
    }
    if (code !== 0) process.exitCode = code;
  } finally {
    for (const name of moved.reverse()) {
      const destination = path.join(root, name);
      if (existsSync(destination)) throw new Error(`Cannot restore ${name}: destination unexpectedly exists`);
      renameSync(path.join(hold, name), destination);
    }
    if (existsSync(hold) && readdirSync(hold).length === 0) rmdirSync(hold);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Worker build failed");
  process.exitCode = 1;
});
