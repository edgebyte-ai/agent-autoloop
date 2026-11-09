// Failure modes: a vanished supervisor PID is mistaken for an empty process tree; stopping during launch misses the
// tree; worker restart loses the ability to inspect and stop descendants; a successful exit is published before cleanup.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import * as commands from "../host/command.ts";

const windows = process.platform === "win32";
const delay = () => new Promise((resolve) => setTimeout(resolve, 50));

test(
  "Windows job identity survives a worker restart and cancellation confirms all descendants exited",
  { skip: !windows },
  async () => {
    const inspect = (commands as any).windowsJobState;
    assert.equal(typeof inspect, "function");
    const dir = mkdtempSync(path.join(tmpdir(), "autoloop-job-中文 & "));
    const file = path.join(dir, "command.json");
    const pidFile = path.join(dir, "descendant.pid");
    const script = path.join(dir, "parent.mjs");
    const exit = path.join(dir, "exit");
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
child.unref();
setInterval(() => {}, 1000);`,
    );
    writeFileSync(file, JSON.stringify({ argv: [process.execPath, script], cwd: dir, exit }));
    assert.equal(await inspect(file), null, "an uncreated job has unknown state");
    const out = openSync(path.join(dir, "output.log"), "w");
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dirname, "../worker/run.ts"), "--supervise", file, "test-job"],
      {
        env: { ...process.env, AGENT_AUTOLOOP_NODE: process.execPath },
        windowsHide: true,
        stdio: ["ignore", out, out],
      },
    );
    closeSync(out);
    let descendant = 0;
    try {
      const end = Date.now() + 20_000;
      while (!existsSync(pidFile) && Date.now() < end) await delay();
      assert.ok(existsSync(pidFile), readFileSync(path.join(dir, "output.log"), "utf8"));
      descendant = Number(readFileSync(pidFile, "utf8"));
      assert.equal(await inspect(file), true);
      await inspect(file, true);
      const stopped = Date.now() + 10_000;
      while ((await inspect(file)) !== false && Date.now() < stopped) await delay();
      assert.equal(await inspect(file), false);
      assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
    } finally {
      child.kill();
      if (descendant) {
        try {
          process.kill(descendant);
        } catch {}
      }
      await new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", () => resolve())));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("a managed Windows server preserves bidirectional stdio and stops its whole job", { skip: !windows }, async () => {
  const managed = (commands as any).spawnManaged;
  assert.equal(typeof managed, "function");
  const dir = mkdtempSync(path.join(tmpdir(), "autoloop-stdio-"));
  const record = path.join(dir, "server.json");
  const server = managed([process.execPath, "-e", "process.stdin.pipe(process.stdout)"], {
    cwd: dir,
    env: process.env,
    record,
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
    assert.equal(await (commands as any).windowsJobState(record), false);
    assert.notEqual(server.child.exitCode, null);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "a crashed worker does not leave a managed Windows server or its descendants running",
  { skip: !windows },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "autoloop-managed-crash-"));
    const record = path.join(dir, "server.json");
    const pidFile = path.join(dir, "descendant.pid");
    const launcher = path.join(dir, "worker.mjs");
    const server = path.join(dir, "server.mjs");
    writeFileSync(
      server,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
child.unref();
setInterval(() => {}, 1000);`,
    );
    writeFileSync(
      launcher,
      `import { spawnManaged } from ${JSON.stringify(pathToFileURL(path.resolve("host/command.ts")).href)};
spawnManaged([process.execPath, ${JSON.stringify(server)}], { cwd: ${JSON.stringify(dir)}, env: process.env, record: ${JSON.stringify(record)} });
setInterval(() => {}, 1000);`,
    );
    const child = spawn(process.execPath, [launcher], { windowsHide: true, stdio: "ignore" });
    let descendant = 0;
    try {
      const end = Date.now() + 15_000;
      while (!existsSync(pidFile) && Date.now() < end) await delay();
      assert.ok(existsSync(pidFile));
      descendant = Number(readFileSync(pidFile, "utf8"));
      child.kill("SIGKILL");
      const stopped = Date.now() + 10_000;
      while ((await commands.windowsJobState(record)) !== false && Date.now() < stopped) await delay();
      assert.equal(await commands.windowsJobState(record), false);
      assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
    } finally {
      child.kill();
      if (descendant) {
        try {
          process.kill(descendant);
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "the login manager job stops its supervisor while an admitted detached task survives",
  { skip: !windows },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "autoloop-login-job-"));
    const record = path.join(dir, "service-job");
    const pids = path.join(dir, "pids.json");
    const script = path.join(dir, "manager.mjs");
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
child.unref();
setInterval(() => {}, 1000);`,
    );
    const command = `"${process.execPath}" "${script}"`;
    const code = `& ${commands.psQuote(path.resolve("worker/windows.ps1"))} -Action own -Breakaway -RunFile ${commands.psQuote(record)} -JobName ${commands.psQuote(commands.windowsJobName(record))}; exit ([TurnJob]::Run(${commands.psQuote(process.execPath)}, ${commands.psQuote(command)}, ${commands.psQuote(dir)}))`;
    const supervisor = spawn(
      commands.POWERSHELL,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")],
      { windowsHide: true, stdio: "ignore" },
    );
    let running: number[] = [];
    try {
      const end = Date.now() + 15_000;
      while (!existsSync(pids) && Date.now() < end) await delay();
      assert.ok(existsSync(pids));
      running = JSON.parse(readFileSync(pids, "utf8"));
      await commands.windowsJobState(record, true);
      const stopped = Date.now() + 10_000;
      while ((await commands.windowsJobState(record)) !== false && Date.now() < stopped) await delay();
      assert.equal(await commands.windowsJobState(record), false);
      assert.throws(() => process.kill(running[0], 0), { code: "ESRCH" });
      assert.doesNotThrow(() => process.kill(running[1], 0), "a service restart killed an independent task");
    } finally {
      supervisor.kill();
      for (const pid of running) {
        try {
          process.kill(pid);
        } catch {}
      }
      const released = Date.now() + 10_000;
      while (Date.now() < released) {
        const alive = running.some((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });
        if (!alive) break;
        await delay();
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },
);
