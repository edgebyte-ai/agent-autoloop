// One worker owns this connection. Requests are journaled before they cross the pipe; recovery reads history first.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawnManaged } from "../../host/command.ts";
import type { Reading, Resident, ResidentOptions, Turn } from "../../worker/agents.ts";

type Json = Record<string, any>;
type Saved = Json & {
  phase: "new" | "creating" | "ready" | "starting" | "running" | "ended";
  requestId: string;
  threadId?: string;
  turnId?: string;
  reading: Reading;
};
type Active = {
  saved: Saved;
  persist: (checkpoint: Json) => void;
  resolve: (reading: Reading) => void;
  reject: (error: Error) => void;
  text?: string;
};
const SANDBOX = { read: "read-only", edit: "workspace-write", full: "danger-full-access" };
export const backgroundPrompt = (prompt: string) =>
  "本轮通过后台 codex app-server 运行，不要假定桌面应用的浏览器连接已带到本轮。" +
  "网页操作使用本轮实际可用的浏览器工具，或使用规则或 Skill 中已明确配置的浏览器入口。" +
  "沿用该入口的会话，只交网页步骤，业务处理和中台回执仍由本轮负责；没有可用入口或需要本人恢复连接时，按待你处理的约定交回。\n\n" +
  prompt;

const sandbox = (turn: Turn) =>
  turn.access === "full"
    ? { type: "dangerFullAccess" }
    : turn.access === "read"
      ? { type: "readOnly", networkAccess: false }
      : {
          type: "workspaceWrite",
          writableRoots: [turn.cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        };

class Disconnected extends Error {}

export function resident(options: ResidentOptions, command: (turn: Turn) => string[]): Resident {
  let process: ReturnType<typeof spawnManaged> | undefined;
  let opening: Promise<void> | undefined;
  let program: string | undefined;
  let serial = 0;
  let closing = false;
  const requests = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  const active = new Map<string, Active>();
  const loaded = new Map<string, { cwd: string; timer?: NodeJS.Timeout }>();
  const queues = new Map<string, Promise<unknown>>();
  const cancellations = new Set<string>();
  const interrupts = new Set<string>();
  mkdirSync(options.folder, { recursive: true });

  const save = (run: Active) => run.persist(structuredClone(run.saved));
  function write(message: Json) {
    if (!process || process.child.stdin.destroyed) throw new Disconnected("app-server 连接已断开");
    process.child.stdin.write(JSON.stringify(message) + "\n");
  }
  function rpc(method: string, params: Json): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Disconnected(`${method} 未收到响应，须先核对已执行的结果`));
      }, 30_000);
      requests.set(id, { resolve, reject, timer });
      try {
        write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        requests.delete(id);
        reject(error);
      }
    });
  }
  function lost(error: Error) {
    for (const pending of requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    requests.clear();
    for (const run of active.values()) run.reject(error);
    active.clear();
    for (const info of loaded.values()) clearTimeout(info.timer);
    loaded.clear();
  }
  async function interruptTurn(saved: Saved) {
    if (saved.phase === "ended" || !saved.threadId || !saved.turnId || !process) return;
    const key = `${saved.threadId}:${saved.turnId}`;
    if (interrupts.has(key)) return;
    interrupts.add(key);
    try {
      await rpc("turn/interrupt", { threadId: saved.threadId, turnId: saved.turnId });
    } catch (error) {
      interrupts.delete(key);
      throw error;
    }
  }
  function complete(run: Active, turn: Json) {
    if (run.saved.turnId && run.saved.turnId !== turn.id) return;
    run.saved.turnId = turn.id;
    for (const item of turn.items ?? []) {
      if (item.type === "agentMessage" && item.phase !== "commentary") run.text = item.text;
    }
    const text = run.saved.questionReceipt ?? run.text ?? run.saved.reading.text;
    run.saved.phase = "ended";
    run.saved.reading = {
      ...run.saved.reading,
      session: run.saved.threadId,
      turn: turn.id,
      started: true,
      finished: true,
      ...(typeof turn.durationMs === "number"
        ? { activeMs: turn.durationMs }
        : typeof turn.startedAt === "number" && typeof turn.completedAt === "number"
          ? { activeMs: Math.max(0, (turn.completedAt - turn.startedAt) * 1000) }
          : {}),
      ...((turn.status === "completed" || run.saved.questionReceipt) && text?.trim()
        ? { text }
        : {
            error:
              turn.error?.message ??
              (turn.status === "interrupted" ? "Codex 这一轮已中断" : "Codex 没有完成并留下实际结果"),
          }),
    };
    delete run.saved.reading.blocked;
    if (run.saved.reading.text) delete run.saved.reading.error;
    save(run);
    run.resolve(run.saved.reading);
  }
  function notification(method: string, params: Json) {
    if (method === "thread/closed") {
      const info = loaded.get(params.threadId);
      clearTimeout(info?.timer);
      loaded.delete(params.threadId);
      return;
    }
    const run = active.get(params.threadId);
    if (!run) return;
    const turnId = params.turnId ?? params.turn?.id;
    if (run.saved.turnId && turnId !== run.saved.turnId) return;
    if (!run.saved.turnId && method !== "turn/started") return;
    if (method === "turn/started") {
      run.saved.turnId = params.turn.id;
      run.saved.reading.turn = params.turn.id;
      run.saved.phase = "running";
      run.saved.reading.started = true;
      if (cancellations.has(run.saved.requestId)) void interruptTurn(run.saved).catch(run.reject);
    } else if (method === "item/completed") {
      const item = params.item;
      if (item.type === "agentMessage" && item.phase !== "commentary") {
        run.text = item.text;
        run.saved.lastMessage = item.text;
      }
      run.saved.reading.progress = `已完成 ${item.type}`;
      run.saved.progressAt = Date.now();
    } else if (method === "thread/tokenUsage/updated") {
      const usage = params.tokenUsage?.total;
      if (usage) {
        const known: Record<string, number> = {};
        for (const [from, to] of [
          ["inputTokens", "input"],
          ["outputTokens", "output"],
          ["cachedInputTokens", "cached"],
        ])
          if (typeof usage[from] === "number") known[to] = usage[from];
        run.saved.reading.sessionUsage = known;
      }
    } else if (method === "turn/completed") return complete(run, params.turn);
    else return;
    save(run);
  }
  async function incoming(message: Json) {
    if (message.id !== undefined && !message.method) {
      const pending = requests.get(message.id);
      if (!pending) return;
      requests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined) {
      const run = active.get(message.params?.threadId);
      const belongs = run && (!run.saved.turnId || run.saved.turnId === message.params?.turnId);
      if (belongs && message.method === "item/tool/requestUserInput") {
        const ask = (message.params.questions ?? []).slice(0, 5).map((question: Json, index: number) => ({
          title: String(question.header || "需要你回答").slice(0, 100),
          text: String(question.question).slice(0, 4000),
          options:
            question.options?.length >= 2
              ? question.options.slice(0, 5).map((option: Json) => String(option.label).slice(0, 200))
              : ["已在文字回答中补充", "暂不继续"],
          key: `${createHash("sha256").update(run.saved.requestId).digest("hex")}:${index}`,
        }));
        run.saved.questionReceipt = "问了一个问题\n\n```agent-autoloop\n" + JSON.stringify({ ask }) + "\n```";
        save(run);
        await rpc("turn/interrupt", { threadId: run.saved.threadId, turnId: run.saved.turnId });
        write({ id: message.id, error: { code: -32601, message: "问题已交回中台，本轮已结束" } });
        return;
      }
      const approval = /requestApproval$/.test(message.method);
      const elicitation = message.method === "mcpServer/elicitation/request";
      if (belongs && (approval || elicitation)) {
        run.saved.questionReceipt =
          "问了一个问题\n\n```agent-autoloop\n" +
          JSON.stringify({
            ask: [
              {
                title: "需要你处理权限或登录",
                text: (
                  String(
                    message.params?.reason ?? message.params?.message ?? "本轮遇到需要本人处理的权限或登录请求。",
                  ) + "\n请先在本机处理登录或可信规则中的权限配置，再回答继续。回答本身不会扩大原权限。 "
                ).slice(0, 4000),
                options: ["已处理，继续", "暂不继续"],
                key: createHash("sha256").update(`${run.saved.requestId}:permission`).digest("hex"),
              },
            ],
          }) +
          "\n```";
        save(run);
        await interruptTurn(run.saved);
      }
      if (message.method === "item/permissions/requestApproval")
        write({ id: message.id, result: { permissions: {}, scope: "turn" } });
      else if (approval) write({ id: message.id, result: { decision: "cancel" } });
      else if (elicitation) write({ id: message.id, result: { action: "cancel", content: null, _meta: null } });
      else write({ id: message.id, error: { code: -32601, message: "后台任务不能阻塞等待交互，请交回问题卡片" } });
      return;
    }
    notification(message.method, message.params ?? {});
  }
  async function connect(turn: Turn) {
    const argv = command(turn);
    if (program && program !== argv[0]) throw new Error("同一 worker 的常驻 Agent 只能使用同一个 program");
    program = argv[0];
    if (opening) return opening;
    if (process) return;
    closing = false;
    opening = (async () => {
      const managed = spawnManaged(argv, {
        cwd: options.folder,
        env: options.environment,
        record: path.join(options.folder, `server-${randomUUID()}.json`),
      });
      process = managed;
      options.log(`app-server started, pid ${managed.child.pid}`);
      managed.child.stderr.on("data", (chunk) => appendFileSync(path.join(options.folder, "server.stderr.log"), chunk));
      managed.child.on("error", (error) => lost(new Disconnected(error.message)));
      managed.child.once("close", (code) => {
        if (process === managed) {
          process = undefined;
          lost(new Disconnected(`app-server 已退出（${code}），须核对原 thread/turn`));
        }
      });
      createInterface({ input: managed.child.stdout }).on("line", (line) => {
        try {
          const message = JSON.parse(line);
          if (message && typeof message === "object") void incoming(message).catch((error) => lost(error));
        } catch {
          lost(new Disconnected("app-server 返回了读不懂的消息"));
        }
      });
      await rpc("initialize", {
        clientInfo: { name: "agent_autoloop", title: "Agent Autoloop", version: "1" },
        capabilities: { experimentalApi: true },
      });
      write({ method: "initialized", params: {} });
    })();
    try {
      await opening;
    } finally {
      opening = undefined;
    }
  }
  const threadParams = (turn: Turn) => ({
    cwd: turn.cwd,
    approvalPolicy: "never",
    sandbox: SANDBOX[turn.access],
    ...(turn.model && { model: turn.model }),
    ...(turn.effort && { config: { model_reasoning_effort: turn.effort } }),
  });
  async function load(turn: Turn, id: string) {
    const info = loaded.get(id);
    if (info) {
      if (info.cwd !== turn.cwd) throw new Error("原 thread 的工作目录与本轮不一致，不能混用工作区");
      clearTimeout(info.timer);
      return;
    }
    const result = await rpc("thread/resume", { ...threadParams(turn), threadId: id });
    if (result.thread.id !== id) throw new Error("恢复的 thread 编号不一致");
    loaded.set(id, { cwd: turn.cwd });
  }
  async function history(run: Active) {
    await rpc("thread/read", { threadId: run.saved.threadId, includeTurns: false });
    let cursor: string | undefined;
    do {
      const page = await rpc("thread/turns/list", {
        threadId: run.saved.threadId,
        itemsView: "full",
        sortDirection: "desc",
        limit: 50,
        ...(cursor && { cursor }),
      });
      const found = page.data.find((turn: Json) =>
        run.saved.turnId
          ? turn.id === run.saved.turnId
          : turn.items?.some((item: Json) => item.type === "userMessage" && item.clientId === run.saved.requestId),
      );
      if (found) return found;
      cursor = page.nextCursor;
    } while (cursor);
    return undefined;
  }
  function blocked(run: Active, error: unknown): Reading {
    run.saved.reading = { ...run.saved.reading, blocked: true, error: String((error as Error).message ?? error) };
    save(run);
    return run.saved.reading;
  }
  async function execute(
    turn: Turn,
    saved: Saved,
    persist: (checkpoint: Json) => void,
    recovering = false,
  ): Promise<Reading> {
    let resolve!: (reading: Reading) => void;
    let reject!: (error: Error) => void;
    const ended = new Promise<Reading>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // A disconnect can arrive while a request is still being awaited.
    void ended.catch(() => {});
    const run: Active = { saved, persist, resolve, reject, text: saved.lastMessage };
    if (saved.phase === "ended") return saved.reading;
    save(run);
    try {
      await connect(turn);
      saved.serverPid = process!.child.pid;
      if (cancellations.has(saved.requestId) && (saved.phase === "new" || saved.phase === "ready")) {
        saved.phase = "ended";
        saved.reading = { ...saved.reading, finished: true, error: "本轮在执行前已取消" };
        save(run);
        return saved.reading;
      }
      if (saved.phase === "creating" && !saved.threadId) {
        const candidates = await rpc("thread/list", { cwd: turn.cwd, limit: 100 });
        saved.recoveryCandidates = candidates.data.map((item: Json) => item.id);
        return blocked(run, "新 thread 的创建结果不确定，已核对历史但无法唯一认领；没有重新执行任务");
      }
      if (!saved.threadId) {
        saved.phase = "creating";
        save(run);
        const result = await rpc("thread/start", threadParams(turn));
        saved.threadId = result.thread.id;
        saved.reading.session = saved.threadId;
        saved.phase = "ready";
        loaded.set(saved.threadId!, { cwd: turn.cwd });
        save(run);
      } else await load(turn, saved.threadId);
      saved.reading.session = saved.threadId;
      active.set(saved.threadId!, run);
      if (cancellations.has(saved.requestId) && saved.phase === "ready") {
        saved.phase = "ended";
        saved.reading = { ...saved.reading, finished: true, error: "本轮在执行前已取消" };
        save(run);
        return saved.reading;
      }
      if (saved.phase === "starting" || saved.phase === "running") {
        const found = await history(run);
        if (!found) return blocked(run, "原 Turn 的提交结果不确定，历史中未能核对；没有重新执行任务");
        saved.turnId = found.id;
        saved.reading.turn = found.id;
        saved.phase = "running";
        saved.reading.started = true;
        save(run);
        if (found.status !== "inProgress") {
          // History has no token total. An earlier notification may cover only part of this turn.
          delete saved.reading.usage;
          saved.reading.sessionUsage = {};
          complete(run, found);
        } else if (cancellations.has(saved.requestId)) await interruptTurn(saved);
      } else {
        saved.phase = "starting";
        save(run);
        const response = await rpc("turn/start", {
          threadId: saved.threadId,
          clientUserMessageId: saved.requestId,
          input: [{ type: "text", text: backgroundPrompt(turn.prompt), text_elements: [] }],
          cwd: turn.cwd,
          approvalPolicy: "never",
          sandboxPolicy: sandbox(turn),
          ...(turn.model && { model: turn.model }),
          ...(turn.effort && { effort: turn.effort }),
        });
        saved.turnId = response.turn.id;
        saved.reading.turn = response.turn.id;
        if ((saved as Saved).phase !== "ended") {
          saved.phase = "running";
          saved.reading.started = true;
          save(run);
          if (cancellations.has(saved.requestId)) await interruptTurn(saved);
          if (response.turn.status !== "inProgress") complete(run, response.turn);
        }
      }
      return await ended;
    } catch (error) {
      if (error instanceof Disconnected && !recovering && !closing) return await execute(turn, saved, persist, true);
      return blocked(run, error);
    } finally {
      if (saved.threadId && active.get(saved.threadId) === run && !saved.reading.blocked) active.delete(saved.threadId);
      if ((saved as Saved).phase === "ended") cancellations.delete(saved.requestId);
      const info = saved.threadId && loaded.get(saved.threadId);
      if (info && (saved as Saved).phase === "ended" && !closing) {
        clearTimeout(info.timer);
        info.timer = setTimeout(
          () => {
            if (active.has(saved.threadId!)) return;
            void rpc("thread/unsubscribe", { threadId: saved.threadId }).then(
              () => loaded.delete(saved.threadId!),
              (error) => options.log(String(error)),
            );
          },
          (turn.threadIdleMinutes ?? 120) * 60_000,
        );
        info.timer.unref();
      }
    }
  }
  return {
    async start(turn, checkpoint, persist) {
      const saved: Saved = checkpoint
        ? (structuredClone(checkpoint) as Saved)
        : {
            phase: "new",
            requestId: turn.id ?? randomUUID(),
            ...(turn.resume && { threadId: turn.resume }),
            reading: {},
          };
      const key = saved.threadId ?? turn.session;
      const previous = queues.get(key) ?? Promise.resolve();
      const running = previous.catch(() => {}).then(() => execute(turn, saved, persist));
      queues.set(key, running);
      try {
        return await running;
      } finally {
        if (queues.get(key) === running) queues.delete(key);
      }
    },
    async interrupt(checkpoint) {
      const saved = checkpoint as Saved;
      cancellations.add(saved.requestId);
      await interruptTurn(saved);
    },
    async close() {
      closing = true;
      for (const info of loaded.values()) clearTimeout(info.timer);
      const current = process;
      if (!current) return;
      for (const run of active.values()) {
        if (run.saved.turnId)
          await rpc("turn/interrupt", { threadId: run.saved.threadId, turnId: run.saved.turnId }).catch(() => {});
      }
      current.child.stdin.end();
      await current.stop();
      process = undefined;
      lost(new Disconnected("worker 已停止，原执行记录保留供恢复"));
    },
  };
}
