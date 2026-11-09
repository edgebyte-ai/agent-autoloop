// Codex uses the user's installed CLI and provider configuration. The worker owns one resident connection.
import { execFileSync } from "node:child_process";
import { commandLine, powershell, psQuote } from "../../host/command.ts";
import { findProgram, tail, type Adapter } from "../../worker/agents.ts";
import { resident } from "./server.ts";

export const IN_THE_APP = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];

const adapter: Adapter = {
  command: (turn) => {
    // The elevated Windows sandbox runs as CodexSandboxUsers. Share only the supplied data, never the run token or key.
    if (process.platform === "win32" && turn.contextFile)
      powershell(`
      try { $sid = ([Security.Principal.NTAccount]::new($env:COMPUTERNAME, 'CodexSandboxUsers')).Translate([Security.Principal.SecurityIdentifier]) }
      catch [Security.Principal.IdentityNotMappedException] { return }
      $file = ${psQuote(turn.contextFile)}
      $acl = [IO.File]::GetAccessControl($file)
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'Read', 'Allow'))
      [IO.File]::SetAccessControl($file, $acl)
    `);
    return [turn.program ?? findProgram("codex", () => IN_THE_APP), "app-server", "--listen", "stdio://"];
  },
  open: (options) => resident(options, adapter.command),
  // Old run folders still contain exec JSON; reading them does not launch the retired backend.
  read(stdout, code, stderr) {
    const seen: {
      text?: string;
      session?: string;
      sessionUsage?: object;
      error?: string;
      finished?: boolean;
      started?: boolean;
      completed?: boolean;
    } = {};
    for (const line of stdout.split("\n")) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      // A login shell's profile prints here too, and `null` is valid JSON.
      if (!event) continue;
      if (event.type === "thread.started") seen.session = event.thread_id;
      else if (event.type === "turn.started") seen.started = true;
      else if (event.type === "item.completed" && event.item?.type === "agent_message") seen.text = event.item.text;
      else if (event.type === "turn.completed") {
        seen.completed = seen.finished = true;
        const { input_tokens = 0, output_tokens = 0, cached_input_tokens = 0 } = event.usage ?? {};
        seen.sessionUsage = { input: input_tokens, output: output_tokens, cached: cached_input_tokens };
      } else if (event.type === "turn.failed") {
        seen.finished = true;
        seen.error = event.error?.message || "Codex 没跑完这一轮";
      } else if (event.type === "error") seen.error = event.message;
    }
    const { completed, ...reading } = seen;
    // Only a finished turn's last message is its answer; before that it's only as far as it had got.
    if (!completed) delete reading.text;
    if (code !== null && !completed && !reading.error) reading.error = tail(stderr) || "Codex 没有完成并留下实际结果";
    if (completed && !reading.text?.trim()) reading.error = "Codex 没有完成并留下实际结果";
    return reading;
  },
  link: (session) => `codex://threads/${session}`,
  check(program) {
    try {
      execFileSync(...commandLine([program ?? findProgram("codex", () => IN_THE_APP), "login", "status"]), {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return null;
    } catch (error) {
      return `Codex 没有登录或用不了：运行 codex login（${(error as Error).message.split("\n")[0]}）`;
    }
  },
};
export default adapter;
