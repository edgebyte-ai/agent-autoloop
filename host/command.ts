// Node cannot exec a Windows npm .cmd shim. Run what it points at (a JavaScript entry or a native program) directly so
// multiline arguments never become cmd source.
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Windows looks for a bare program name in its working folder first, and an Agent can write to a turn's folder. */
export const POWERSHELL = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

/**
 * The file Windows runs for `name` from PATH, trying extensions in PATHEXT's order. Not where.exe: it prints in the console's
 * code page, so a folder outside it (a Chinese user name) came back as a path that isn't there. The current folder isn't
 * searched, so a project can't put its own program in place of the one installed.
 */
export function findOnPath(name: string, extensions = [".exe", ".com", ".cmd", ".bat", ".ps1"]) {
  if (/[\\/]/.test(name)) return null;
  const listed = (process.env.PATHEXT ?? "").toLowerCase().split(";");
  const order = [
    ...listed.filter((ext) => extensions.includes(ext)),
    ...extensions.filter((ext) => !listed.includes(ext)),
  ];
  const names = [
    ...(extensions.includes(path.extname(name).toLowerCase()) ? [name] : []),
    ...order.map((ext) => name + ext),
  ];
  for (const entry of (process.env.PATH ?? "").split(";")) {
    const folder = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!folder) continue;
    for (const file of names.map((each) => path.join(folder, each))) if (existsSync(file)) return file;
  }
  return null;
}

export function commandLine(argv: string[]): [string, string[]] {
  if (process.platform !== "win32") return [argv[0], argv.slice(1)];
  let program = argv[0];
  if (!path.isAbsolute(program)) program = findOnPath(program) ?? program;
  if (/\.cmd$/i.test(program)) {
    const shim = readFileSync(program, "utf8");
    const entry = /"%(?:dp0%|~dp0)\\?([^"\r\n]+\.(?:[cm]?js|exe))"\s+%\*/i.exec(shim);
    if (!entry) throw new Error(`不能直接运行 ${program}：请在 command 写可执行文件，或用 node 运行脚本。`);
    // A package whose bin is a native program (Claude Code from npm) gets a shim that runs it with no node in front.
    if (/\.exe$/i.test(entry[1])) return [path.resolve(path.dirname(program), entry[1]), argv.slice(1)];
    const adjacentNode = path.join(path.dirname(program), "node.exe");
    return [
      existsSync(adjacentNode) ? adjacentNode : process.execPath,
      [path.resolve(path.dirname(program), entry[1]), ...argv.slice(1)],
    ];
  }
  if (/\.ps1$/i.test(program))
    return [POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", program, ...argv.slice(1)]];
  if (/\.bat$/i.test(program))
    throw new Error(`不能直接运行 ${program}：请在 command 写可执行文件，或用 node 运行脚本。`);
  return [program, argv.slice(1)];
}

const encoded = (script: string) => [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " + script,
    "utf16le",
  ).toString("base64"),
];

export function powershell(script: string) {
  return execFileSync(POWERSHELL, encoded(script), {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export const psQuote = (word: string) => `'${word.replaceAll("'", "''")}'`;

const commandOf = (pid: number): [string, string[]] =>
  process.platform === "win32"
    ? [POWERSHELL, encoded(`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`)]
    : ["ps", ["-p", String(pid), "-o", "command="]];

export function processCommandSync(pid: number) {
  return execFileSync(...commandOf(pid), { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

/** Without stopping the process while it looks: the worker shares one with the hub, and PowerShell takes over a second to start. */
export async function processCommand(pid: number) {
  return (await execFileAsync(...commandOf(pid), { encoding: "utf8", windowsHide: true })).stdout;
}

export const windowsJobName = (file: string) =>
  `Local\\agent-autoloop-${createHash("sha256").update(path.resolve(file).toLowerCase()).digest("hex")}`;

/** A PID can disappear before its descendants. The named job, including its startup receipt, identifies the whole turn. */
export async function windowsJobState(file: string, terminate = false): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync(
      POWERSHELL,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(import.meta.dirname, "../worker/windows.ps1"),
        "-Action",
        terminate ? "stop" : "inspect",
        "-JobName",
        windowsJobName(file),
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const count = Number(stdout.trim());
    if (count >= 0 && stdout.trim()) return count > 0;
    if (count === -1) return existsSync(`${file}.ready`) || existsSync(`${file}.closed`) ? false : null;
    return null;
  } catch {
    return null;
  }
}

export async function processGroupState(pid: number): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pgid=", "-o", "stat="], { encoding: "utf8" });
    return stdout.split("\n").some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === pid && !state.startsWith("Z");
    });
  } catch {
    return null;
  }
}

export async function stopProcessGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    if ((await processGroupState(pid)) === false) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`无法确认进程组已退出：${pid}`);
}

/** `record` is unique to this launch and remains available for inspecting its process tree after a crash. */
export function spawnManaged(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; record: string }) {
  const windows = process.platform === "win32";
  const { record, cwd, env } = options;
  writeFileSync(record, JSON.stringify({ argv, cwd, exit: `${record}.exit` }), { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, "../worker/run.ts"), windows ? "--supervise" : "--managed", record, record],
    {
      cwd,
      env: { ...env, AGENT_AUTOLOOP_NODE: process.execPath },
      windowsHide: true,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  let stopped = false;
  const waitForExit = async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`进程监管尚未退出：${record}`)), 15_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  async function stop() {
    if (stopped) return;
    const end = Date.now() + 15_000;
    if (windows) {
      while (Date.now() < end) {
        if ((await windowsJobState(record, true)) === false) {
          await waitForExit();
          stopped = true;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`无法确认进程树已退出：${record}`);
    }
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    await waitForExit();
    if (!existsSync(`${record}.closed`)) throw new Error(`无法确认进程树已退出：${record}`);
    stopped = true;
  }
  return { child, stop, record };
}
