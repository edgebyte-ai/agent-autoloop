// Failure modes: the native client only surfaces input during a model turn; a card response never reaches the real hub;
// forms lose string choices or notice acknowledgments; acceptance borrows the user's configuration or leaves a process.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { spawnManaged } from "../host/command.ts";

const program = process.argv[2];
assert.ok(
  program && isAbsolute(program),
  "用法：node scripts/real-mcp-elicitation.ts <原生 Codex 可执行文件的绝对路径>",
);
if (process.platform === "win32") assert.ok(program.toLowerCase().endsWith(".exe"), "Windows 请指定原生 codex.exe");
const version = execFileSync(program, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
const temporary = process.platform === "win32" ? join(homedir(), "AppData", "Local", "Temp") : tmpdir();
const home = mkdtempSync(join(temporary, "agent-autoloop-real-elicitation-"));
const started = Date.now();
const work = join(home, "work");
const codexHome = join(home, "codex");
mkdirSync(work);
mkdirSync(codexHome);
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
process.env.AGENT_AUTOLOOP_PUBLIC_URL = "http://127.0.0.1";
writeFileSync(
  process.env.AGENT_AUTOLOOP_RULES,
  JSON.stringify({
    sources: { test: { name: "原生接入验收" } },
    agents: { test: { name: "未启动的执行者", worker: "offline", use: "command", command: ["node", "--version"] } },
    channels: {},
    rules: [
      {
        name: "接入验收",
        when: { source: "test", types: ["test.start"] },
        to: "test",
        cwd: work,
        prompt: "核对接入，不调用模型。",
      },
    ],
  }),
);

type Message = Record<string, any>;
type Pending = { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout };
let native: ReturnType<typeof spawnManaged> | undefined;
let server: ReturnType<(typeof import("../host/http.ts"))["serve"]> | undefined;
let hub: typeof import("../host/runtime.ts") | undefined;
let retain = false;
let report: Record<string, unknown> | undefined;
let serial = 0;
const requests = new Map<number, Pending>();
const incoming: Message[] = [];
let disconnected: Error | undefined;

function send(message: Message) {
  assert.ok(native && !native.child.stdin.destroyed, "app-server 的输入已关闭");
  native.child.stdin.write(JSON.stringify(message) + "\n");
}

function request(method: string, params: Message) {
  assert.notEqual(method, "turn/start", "此验收不允许启动模型轮次");
  return new Promise<any>((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {
      requests.delete(id);
      reject(new Error(`${method} 在 30 秒内没有回应`));
    }, 30_000);
    requests.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}

async function until<T>(read: () => T | undefined, description: string): Promise<T> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const value = read();
    if (value !== undefined) return value;
    if (disconnected) throw disconnected;
    await delay(20);
  }
  throw new Error(`${description} 在 30 秒内没有完成`);
}

async function main() {
  hub = await import("../host/runtime.ts");
  const { serve } = await import("../host/http.ts");
  server = serve(0, "127.0.0.1");
  await new Promise((resolve) => server!.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const owner = hub.addKey("owner", "native-elicitation");
  writeFileSync(
    join(codexHome, "config.toml"),
    `sandbox_mode = "read-only"\n` +
      `approval_policy = { granular = { sandbox_approval = false, rules = false, mcp_elicitations = true, request_permissions = false, skill_approval = false } }\n` +
      `[mcp_servers.agent_autoloop]\nurl = ${JSON.stringify(url)}\n` +
      `bearer_token_env_var = "AGENT_AUTOLOOP_ELICITATION_TEST_TOKEN"\nrequired = true\n`,
    { mode: 0o600 },
  );
  native = spawnManaged([program, "app-server", "--listen", "stdio://"], {
    cwd: work,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      AGENT_AUTOLOOP_ELICITATION_TEST_TOKEN: owner,
      RUST_LOG: "warn",
    },
    record: join(home, "app-server.json"),
  });
  native.child.stderr.on("data", (chunk) => appendFileSync(join(home, "app-server.stderr.log"), chunk));
  const disconnectedWith = (error: Error) => {
    disconnected = error;
    for (const pending of requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    requests.clear();
  };
  native.child.on("error", disconnectedWith);
  native.child.once("close", (code) => disconnectedWith(new Error(`app-server 已退出：${code}`)));
  createInterface({ input: native.child.stdout }).on("line", (line) => {
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      disconnectedWith(new Error("app-server 返回了非 JSON 消息"));
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = requests.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      requests.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    } else if (message.method === "mcpServer/elicitation/request") incoming.push(message);
    else if (message.id !== undefined)
      send({ id: message.id, error: { code: -32601, message: "无模型验收只接受 MCP 卡片" } });
  });
  await request("initialize", {
    clientInfo: { name: "autoloop_elicitation_acceptance", title: "原生卡片验收", version: "1" },
    capabilities: { experimentalApi: true },
  });
  send({ method: "initialized", params: {} });
  const created = await request("thread/start", { cwd: work, sandbox: "read-only", ephemeral: true });
  const thread = created.thread.id;
  assert.ok(thread);

  async function answer(kind: "ask" | "notice", content: Message) {
    const title = `原生无模型卡片-${kind}`;
    const { card } = hub!.execute("createCard", [
      {
        key: `native-${kind}`,
        kind,
        title,
        text: "只验证卡片传输和回答，不运行项目代码。",
        ...(kind === "ask" && {
          options: ["甲", "乙"],
          source: "test",
          rule: "接入验收",
          grp: "接入验收",
          lane: "",
          agent: "test",
        }),
      },
    ]);
    const elicitation = await until(
      () => incoming.find((message) => message.params?.message?.includes(title)),
      `${kind} 卡片的原生 Elicitation`,
    );
    assert.equal(elicitation.params.threadId, thread);
    assert.equal(elicitation.params.turnId, null, "没有模型轮次时应收到独立 Elicitation");
    assert.equal(elicitation.params.mode, "form");
    const fields = elicitation.params.requestedSchema.properties;
    assert.equal(fields[kind === "ask" ? "choice" : "ack"].type, kind === "ask" ? "string" : "boolean");
    send({ id: elicitation.id, result: { action: "accept", content, _meta: null } });
    const settled = await until(() => {
      const value = hub!.getView().get("cards", card);
      return value?.state !== "open" ? value : undefined;
    }, `${kind} 卡片回传`);
    if (kind === "ask") {
      assert.equal(settled.state, "decided");
      assert.equal(settled.choice, 1);
      assert.ok(settled.answer_event, "问题回答必须唤醒原事项");
    } else {
      assert.equal(settled.state, "closed");
      assert.equal(settled.answer, "原生客户端已核对。");
    }
    return card;
  }
  const question = await answer("ask", { choice: "1" });
  const notice = await answer("notice", { ack: true, text: "原生客户端已核对。" });
  report = {
    passed: true,
    client: version,
    node: process.version,
    transport: "Streamable HTTP",
    protocol: "2025-11-25",
    modelTurns: 0,
    idleElicitations: 2,
    question,
    notice,
    ms: Date.now() - started,
  };
}

try {
  await main();
} finally {
  for (const pending of requests.values()) clearTimeout(pending.timer);
  if (native) {
    try {
      native.child.stdin.end();
      await native.stop();
    } catch (error) {
      retain = true;
      console.error(`无法确认原生进程树已退出，保留：${home}`);
      console.error((error as Error).message);
    }
  }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (hub?.db.isOpen) hub.db.close();
  if (!retain) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch (error) {
      console.error(`临时目录未清理：${home}`);
      throw error;
    }
  }
}
assert.ok(!retain, `原生进程树退出状态未确认，保留：${home}`);
console.log(JSON.stringify(report));
