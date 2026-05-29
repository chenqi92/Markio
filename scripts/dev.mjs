// Pre-flight: free port 18642 if a stale process is squatting on it,
// then spawn `vite`. Forwards stdio + exit code + signals so behavior
// is identical to running `vite` directly.
//
// Why: `vite.config.ts` uses `strictPort: true` and Tauri's `devUrl`
// points at a fixed `http://127.0.0.1:18642` — letting Vite pick a
// random free port would break the IPC handshake. So instead of
// changing the port, kill whoever is on it.
//
// Production builds (`tauri build`) ship `dist/` as embedded assets
// served via Tauri's custom protocol — no dev server, no port.
//
// External tools required:
//   - macOS / Linux: `lsof` (usually pre-installed)
//   - Windows: `netstat` + `taskkill` (built-in)
// If `lsof` is missing on a stripped Linux image, install it via the
// distro's package manager (e.g. `apt-get install lsof`).

import { execSync, spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = 18642;
const HOST = "127.0.0.1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isPortFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

function findPidsOnPort(port) {
  try {
    if (process.platform === "win32") {
      const out = execSync(`netstat -ano -p TCP`, { encoding: "utf8" });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        // Proto  Local Address   Foreign Address   State    PID
        const m = line.match(/\s+\S+:(\d+)\s+\S+\s+(LISTENING|ESTABLISHED)\s+(\d+)\s*$/);
        if (m && Number(m[1]) === port) pids.add(m[3]);
      }
      return [...pids];
    }
    // mac / linux
    const out = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -t`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

function killPid(pid) {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

async function ensurePortFree() {
  if (await isPortFree(PORT, HOST)) return;
  const pids = findPidsOnPort(PORT);
  if (pids.length === 0) {
    console.warn(
      `[dev] port ${PORT} appears busy but no PID found — vite will likely fail to bind.`,
    );
    return;
  }
  const ownPid = String(process.pid);
  for (const pid of pids) {
    if (pid === ownPid) continue;
    process.stderr.write(`[dev] freeing port ${PORT} (killing PID ${pid})\n`);
    killPid(pid);
  }
  // small grace period for the OS to release the socket
  for (let i = 0; i < 20; i++) {
    if (await isPortFree(PORT, HOST)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.warn(`[dev] port ${PORT} still busy after kill; vite may error.`);
}

await ensurePortFree();

// Run vite's actual JS entry via node — avoids the `.cmd` shell wrapper
// on Windows (which triggers Node's shell=true deprecation warning).
const viteEntry = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const child = spawn(process.execPath, [viteEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: ROOT,
});
const forward = (sig) => () => {
  if (!child.killed) child.kill(sig);
};
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
child.on("exit", (code, sig) => {
  if (sig) process.kill(process.pid, sig);
  else process.exit(code ?? 0);
});
