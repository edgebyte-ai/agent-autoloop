// Failure modes: WScript expands a literal %NAME% in a Windows path or argument, and the hidden background launcher
// consequently starts the wrong program or uses another data directory; unreadable process identity is reported as stopped.
// No login task or real hub is installed here.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

test(
  "the native command entry puts Node flags before the script and CLI arguments after it",
  { skip: process.platform !== "win32" },
  () => {
    const command = join(import.meta.dirname, "../bin/agent-autoloop.cmd");
    const result = spawnSync(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
      ["/d", "/s", "/c", `""${command}" --version"`],
      { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /agent-autoloop/);
  },
);

test(
  "an unreadable Windows process identity stays unknown rather than stopped",
  { skip: process.platform !== "win32" },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-identity-"));
    writeFileSync(join(scratch, "up.pid"), String(process.pid));
    writeFileSync(join(scratch, "up-process.json"), "unfinished identity");
    try {
      const module = pathToFileURL(join(import.meta.dirname, "../host/service.ts")).href;
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import assert from 'node:assert/strict'; import { runningUp } from ${JSON.stringify(module)}; assert.throws(() => runningUp(), /无法核对中台进程身份/);`,
        ],
        {
          env: { ...process.env, AGENT_AUTOLOOP_HOME: scratch },
          encoding: "utf8",
          windowsHide: true,
        },
      );
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "the Windows hidden launcher preserves percent variables and special characters literally",
  { skip: process.platform !== "win32" },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-launcher-"));
    const probe = join(scratch, "probe.mjs");
    const output = join(scratch, "received.json");
    const words = ["中文 '%PATH%' & directory", "trailing\\"];
    writeFileSync(
      probe,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`,
    );
    const child = spawn(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe"),
      [
        "//B",
        "//Nologo",
        "//E:JScript",
        join(import.meta.dirname, "../host/background.js"),
        process.execPath,
        probe,
        ...words,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(output) && Date.now() < deadline && child.exitCode === null)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(existsSync(output), "the hidden launcher did not start its program");
      assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), words);
    } finally {
      child.kill();
      await ended;
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
