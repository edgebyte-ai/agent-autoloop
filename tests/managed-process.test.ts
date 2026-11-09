// Failure modes: a resident server loses JSON-RPC bytes in a platform wrapper, or keeps its descendants running after
// its worker crashes or requests shutdown.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { spawnManaged } from "../host/command.ts";

const delay = () => new Promise((resolve) => setTimeout(resolve, 50));
const present = (pid: number) => {
  try {
    process.kill(pid, 0);
    return (
      process.platform === "win32" ||
      !execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" })
        .trim()
        .startsWith("Z")
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH" || (error as { status?: number }).status === 1) return false;
    throw error;
  }
};

test("a managed server preserves literal stdin and stdout and confirms shutdown", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "autoloop-stdio-"));
  const server = spawnManaged([process.execPath, "-e", "process.stdin.pipe(process.stdout)"], {
    cwd: dir,
    env: process.env,
    record: path.join(dir, "server.json"),
  });
  let output = "";
  server.child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    const line = '中文 "quotes" & %PATH%\n';
    server.child.stdin.write(line);
    const end = Date.now() + 15_000;
    while (output !== line && Date.now() < end) await delay();
    assert.equal(output, line);
    await server.stop();
    assert.notEqual(server.child.exitCode, null);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a managed server and its child stop after the worker is killed", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "autoloop-managed-crash-"));
  const record = path.join(dir, "server.json");
  const pids = path.join(dir, "processes.json");
  const launcher = path.join(dir, "worker.mjs");
  const server = path.join(dir, "server.mjs");
  writeFileSync(
    server,
    `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);`,
  );
  writeFileSync(
    launcher,
    `import { spawnManaged } from ${JSON.stringify(pathToFileURL(path.resolve("host/command.ts")).href)};
spawnManaged([process.execPath, ${JSON.stringify(server)}], { cwd: ${JSON.stringify(dir)}, env: process.env, record: ${JSON.stringify(record)} });
setInterval(() => {}, 1000);`,
  );
  const child = spawn(process.execPath, [launcher], { windowsHide: true, stdio: "ignore" });
  let running: number[] = [];
  try {
    const end = Date.now() + 15_000;
    while (!existsSync(pids) && Date.now() < end) await delay();
    assert.ok(existsSync(pids));
    running = JSON.parse(readFileSync(pids, "utf8"));
    child.kill("SIGKILL");
    const stopped = Date.now() + 10_000;
    while (running.some(present) && Date.now() < stopped) await delay();
    assert.ok(
      running.every((pid) => !present(pid)),
      `left running: ${running.filter(present)}`,
    );
  } finally {
    child.kill();
    for (const pid of running) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopping while the managed launcher starts does not miss the new process tree", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "autoloop-managed-start-"));
  const server = spawnManaged([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    cwd: dir,
    env: process.env,
    record: path.join(dir, "server.json"),
  });
  try {
    await server.stop();
    assert.notEqual(server.child.exitCode, null);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
