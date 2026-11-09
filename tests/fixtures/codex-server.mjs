// A protocol peer with durable history: tests exercise the real stdio transport and response-loss recovery.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const stateFile = process.env.FAKE_CODEX_STATE;
const logFile = process.env.FAKE_CODEX_LOG;
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : { threads: {}, nextThread: 0, nextTurn: 0 };
const timers = new Map();
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const log = (event) => appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...event }) + "\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const event = (method, params) => send({ method, params });
const reply = (id, result) => send({ id, result });
const error = (id, message) => send({ id, error: { code: -32600, message } });
const threadResult = (thread) => ({
  thread,
  model: thread.model,
  modelProvider: "user-provider",
  cwd: thread.cwd,
  approvalPolicy: "never",
  sandbox: { type: "readOnly" },
  reasoningEffort: thread.reasoningEffort,
});
log({ method: "process", argv: process.argv.slice(2) });

function finish(thread, turn, status = "completed") {
  clearTimeout(timers.get(turn.id));
  timers.delete(turn.id);
  turn.status = status;
  turn.completedAt = Date.now() / 1000;
  turn.durationMs = 100;
  if (status === "completed") {
    const text = `完成:${turn.testName}`;
    const item = { type: "agentMessage", id: `answer-${turn.id}`, text, phase: "final_answer" };
    turn.items.push(item);
    event("item/completed", { threadId: thread.id, turnId: turn.id, item });
    for (const last of [
      { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, totalTokens: 12 },
      { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2, totalTokens: 10 },
    ]) {
      thread.usage ??= { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 };
      for (const key of Object.keys(last)) thread.usage[key] += last[key];
      const usage = {
        threadId: thread.id,
        turnId: turn.id,
        tokenUsage: { total: thread.usage, last, modelContextWindow: null },
      };
      event("thread/tokenUsage/updated", usage);
      event("thread/tokenUsage/updated", usage);
    }
  }
  save();
  event("turn/completed", { threadId: thread.id, turn });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  log(message);
  if (!method) return;
  if (id === undefined) return;
  if (method === "initialize") {
    setTimeout(
      () => reply(id, { userAgent: "fake-codex", platformFamily: process.platform }),
      Number(process.env.FAKE_CODEX_INIT_DELAY_MS ?? 0),
    );
    return;
  }
  if (method === "thread/start") {
    const thread = {
      id: `thread-${++state.nextThread}`,
      cwd: params.cwd,
      model: params.model ?? "configured-model",
      reasoningEffort: params.config?.model_reasoning_effort ?? null,
      modelProvider: "user-provider",
      status: { type: "idle" },
      turns: [],
    };
    state.threads[thread.id] = thread;
    save();
    if (process.env.FAKE_CODEX_LOSE_THREAD === "1") return process.exit(8);
    event("thread/started", { thread: { ...thread, turns: [] } });
    setTimeout(() => reply(id, threadResult(thread)), state.nextThread === 1 ? 25 : 5);
    return;
  }
  if (method === "thread/list") return reply(id, { data: Object.values(state.threads), nextCursor: null });
  if (method === "thread/loaded/list")
    return reply(id, { data: Object.keys(state.threads), nextCursor: null });
  if (method === "thread/unsubscribe") return reply(id, {});
  const thread = state.threads[params.threadId];
  if (!thread) return error(id, "thread does not exist");
  if (method === "thread/read") return reply(id, { thread });
  if (method === "thread/resume") return reply(id, threadResult(thread));
  if (method === "thread/turns/list") return reply(id, { data: thread.turns, nextCursor: null });
  if (method === "thread/items/list")
    return reply(id, { data: thread.turns.flatMap((turn) => turn.items), nextCursor: null });
  if (method === "turn/start") {
    if (thread.turns.some((turn) => turn.status === "inProgress")) return error(id, "thread already has a turn");
    const prompt = params.input.map((input) => input.text ?? "").join("\n");
    const turn = {
      id: `turn-${++state.nextTurn}`,
      rootTurnId: null,
      status: "inProgress",
      items: [{ type: "userMessage", id: `user-${state.nextTurn}`, clientId: params.clientUserMessageId, content: params.input }],
      itemsView: { type: "full" },
      error: null,
      startedAt: Date.now() / 1000,
      completedAt: null,
      durationMs: null,
      testName: /TEST:([a-z0-9-]+)/.exec(prompt)?.[1] ?? "unknown",
    };
    thread.turns.push(turn);
    if (prompt.includes("LOSE_REPLY")) {
      turn.status = "completed";
      turn.durationMs = 100;
      turn.items.push({ type: "agentMessage", id: `answer-${turn.id}`, text: `完成:${turn.testName}`, phase: "final_answer" });
      save();
      return process.exit(9);
    }
    if (prompt.includes("PARTIAL_LOST")) {
      event("turn/started", { threadId: thread.id, turn });
      reply(id, { turn });
      event("thread/tokenUsage/updated", {
        threadId: thread.id,
        turnId: turn.id,
        tokenUsage: {
          total: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, totalTokens: 12 },
          last: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, totalTokens: 12 },
          modelContextWindow: null,
        },
      });
      turn.status = "completed";
      turn.durationMs = 100;
      turn.items.push({ type: "agentMessage", id: `answer-${turn.id}`, text: `完成:${turn.testName}`, phase: "final_answer" });
      thread.usage = { inputTokens: 17, outputTokens: 5, cachedInputTokens: 5, totalTokens: 22 };
      save();
      return setTimeout(() => process.exit(9), 30);
    }
    save();
    event("turn/started", { threadId: thread.id, turn });
    reply(id, { turn });
    event("item/completed", {
      threadId: "unrelated-thread",
      turnId: turn.id,
      item: { type: "agentMessage", id: "foreign", text: "不能串进来的结果", phase: "final_answer" },
    });
    event("turn/completed", {
      threadId: thread.id,
      turn: { id: "stale-turn", status: "completed", items: [{ type: "agentMessage", id: "stale", text: "旧轮次的结果" }] },
    });
    if (prompt.includes("ASK_INPUT")) {
      send({
        id: `question-${turn.id}`,
        method: "item/tool/requestUserInput",
        params: {
          threadId: thread.id,
          turnId: turn.id,
          itemId: `question-${turn.id}`,
          isBlocking: true,
          questions: [{
            id: "continue",
            header: "继续处理",
            question: "是否继续处理这份资料？",
            isOther: false,
            isSecret: false,
            options: prompt.includes("ASK_TEXT") ? null : [
              { label: "继续", description: "完成余下工作" },
              { label: "停止", description: "保留已有结果" },
            ],
          }, ...(prompt.includes("ASK_TWO") ? [{
            id: "output",
            header: "输出位置",
            question: "结果放在哪个位置？",
            isOther: false,
            isSecret: false,
            options: [{ label: "原目录", description: "保留现有位置" }, { label: "新目录", description: "另存一份" }],
          }] : [])],
        },
      });
      return;
    }
    if (prompt.includes("ASK_PERMISSION")) {
      send({
        id: `permission-${turn.id}`,
        method: "item/permissions/requestApproval",
        params: {
          threadId: thread.id,
          turnId: turn.id,
          itemId: `permission-${turn.id}`,
          environmentId: null,
          startedAtMs: Date.now(),
          cwd: thread.cwd,
          reason: "这一步需要额外网络权限",
          permissions: { network: { enabled: true }, fileSystem: null },
        },
      });
      return;
    }
    if (!prompt.includes("HOLD")) timers.set(turn.id, setTimeout(() => finish(thread, turn), prompt.includes("SLOW") ? 250 : 40));
    return;
  }
  if (method === "turn/interrupt") {
    const turn = thread.turns.find((turn) => turn.id === params.turnId);
    if (!turn) return error(id, "turn does not exist");
    reply(id, {});
    if (process.env.FAKE_CODEX_LOSE_INTERRUPT === "1") return process.exit(9);
    finish(thread, turn, "interrupted");
    return;
  }
  error(id, `unsupported method ${method}`);
});

process.stdin.on("end", () => process.exit(0));
