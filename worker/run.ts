// A Windows turn outlives its worker. Its supervisor owns the process tree; this child preserves output and the exit code.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { commandLine, POWERSHELL, stopProcessGroup, windowsJobName } from "../host/command.ts";

if (process.argv[2] === "--managed") {
  const file = process.argv[3];
  const { argv, cwd, exit } = JSON.parse(readFileSync(file, "utf8"));
  const [program, args] = commandLine(argv);
  const child = spawn(program, args, { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  let finishing = false;
  const finish = async (code: number) => {
    if (finishing) return;
    finishing = true;
    try {
      if (child.pid) await stopProcessGroup(child.pid);
      await closed;
      writeFileSync(`${file}.closed`, "stopped", { mode: 0o600 });
      writeFileSync(`${exit}.tmp`, String(code), { mode: 0o600 });
      renameSync(`${exit}.tmp`, exit);
      process.stdin.destroy();
      process.exitCode = code;
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }
  };
  // A killed worker closes this pipe. The supervisor survives long enough to reap the entire server group.
  process.stdin.on("end", () => void finish(0));
  process.on("SIGTERM", () => void finish(0));
  process.on("SIGINT", () => void finish(0));
  child.stdin.on("error", () => void finish(1));
  child.on("error", (error) => {
    console.error(error.message);
    void finish(127);
  });
  child.on("exit", (code) => void finish(code ?? 1));
} else if (process.argv[2] === "--supervise") {
  // PowerShell cannot run detached; Node can. Its non-detached child is kept in Node's Windows job, so killing this
  // supervisor also closes PowerShell's job and its entire Agent tree.
  const child = spawn(
    POWERSHELL,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(import.meta.dirname, "windows.ps1"),
      "-RunFile",
      process.argv[3],
      "-Marker",
      process.argv[4],
      "-JobName",
      windowsJobName(process.argv[3]),
    ],
    { stdio: "inherit", windowsHide: true },
  );
  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.on("exit", (code) => {
    const file = process.argv[3];
    if (!existsSync(`${file}.ready`)) {
      // No command was admitted. Keep a startup failure separate from a turn whose process state is unknown.
      writeFileSync(`${file}.closed`, "startup failed", { mode: 0o600 });
      const { exit } = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(`${exit}.tmp`, String(code || 1), { mode: 0o600 });
      renameSync(`${exit}.tmp`, exit);
    }
    process.exit(code ?? 1);
  });
} else {
  const { argv, cwd, exit } = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const publish = (code: number) => {
    writeFileSync(`${exit}.tmp`, String(code), { mode: 0o600 });
    renameSync(`${exit}.tmp`, exit);
  };
  try {
    const [program, args] = commandLine(argv);
    const child = spawn(program, args, { cwd, stdio: "inherit", windowsHide: true });
    child.on("error", (error) => {
      console.error(error.message);
      publish(127);
    });
    child.on("exit", (code) => publish(code ?? 1));
  } catch (error) {
    console.error((error as Error).message);
    publish(127);
  }
}
