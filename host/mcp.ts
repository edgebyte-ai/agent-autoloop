// Both MCP transports expose the same typed operations and leave business decisions to the hub HTTP API.
import { randomUUID } from "node:crypto";
import type { Card } from "./channels.ts";
import { versionName } from "./version.ts";
import { hubClient, type Hub } from "../protocol/client.ts";

type Identity = { owner?: string; source?: { key: string } };
export const MCP_VERSION = "2025-11-25";

const positive = { type: "integer", minimum: 1 };
const string = { type: "string", minLength: 1 };
const specs = [
  ["status", "查看现在的事项和卡片", {}, []],
  ["why", "查看一轮的事件、规则和结果", { run: positive }, ["run"]],
  [
    "answer",
    "回答卡片；选项从 0 开始，也可以写自己的答案",
    { card: positive, choice: { type: "integer", minimum: 0 }, text: string },
    ["card"],
  ],
  ["resolve", "将卡片结案，写明已核实的结果", { card: positive, reason: string }, ["card", "reason"]],
  ["stop", "停止一轮", { run: positive }, ["run"]],
  ["workflow_list", "查看根工作流和累计用量", {}, []],
  ["workflow_show", "查看工作项、子项、角色会话和各次执行结果", { item: positive }, ["item"]],
  ["workflow_start", "按已有规则启动工作流", { rule: string, subject: string, reason: string }, ["rule"]],
  ["workflow_pause", "暂停工作项和子项的新步骤；已准入步骤收尾", { item: positive, reason: string }, ["item"]],
  ["workflow_resume", "恢复工作项和子项，继续未完成位置", { item: positive, reason: string }, ["item"]],
  ["workflow_cancel", "请求取消工作项和子项；实际退出后才算取消完成", { item: positive, reason: string }, ["item"]],
  [
    "emit",
    "用当前来源发送事件；相同编号只记一次",
    { id: string, type: string, subject: string, summary: string, detail: string, link: string },
    ["id", "type"],
  ],
  ["tell", "用当前来源发送通知；相同编号只发一次", { key: string, text: string }, ["key", "text"]],
] as const;

const usesSourceKey = (name: string) => ["emit", "tell"].includes(name);

function toolsFor(config: Identity) {
  return specs
    .filter(([name]) => (usesSourceKey(name) ? config.source : config.owner))
    .map(([name, description, properties, required]) => ({
      name,
      description,
      inputSchema: { type: "object", properties, required, additionalProperties: false },
      annotations: {
        readOnlyHint: ["status", "why", "workflow_list", "workflow_show"].includes(name),
        destructiveHint: ["stop", "workflow_cancel"].includes(name),
      },
    }));
}
type Tool = ReturnType<typeof toolsFor>[number];

function validArguments(tool: Tool, args: any) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (!tool.inputSchema.required.every((key) => Object.hasOwn(args, key))) return false;
  const properties = tool.inputSchema.properties as Record<string, any>;
  const fits = ([key, value]: [string, unknown]) => {
    const schema = properties[key];
    if (!schema) return false;
    if (schema.type === "integer") return Number.isSafeInteger(value) && (value as number) >= schema.minimum;
    return typeof value === "string" && value.trim().length > 0;
  };
  if (!Object.entries(args).every(fits)) return false;
  return tool.name !== "answer" || (args.choice !== undefined) !== (args.text !== undefined);
}

function callTool(hub: Hub, name: Tool["name"], args: any) {
  switch (name) {
    case "status":
      return hub.state();
    case "why":
      return hub.why(args.run);
    case "answer": {
      const { card, ...answer } = args;
      return hub.answer(card, answer);
    }
    case "resolve":
      return hub.resolve(args.card, args.reason);
    case "stop":
      return hub.cancel(args.run);
    case "workflow_list":
      return hub.workflows();
    case "workflow_show":
      return hub.workflow(args.item);
    case "workflow_start":
      return hub.run(args.rule, { subject: args.subject, reason: args.reason });
    case "workflow_pause":
    case "workflow_resume":
    case "workflow_cancel":
      return hub.workflowControl(args.item, name.slice("workflow_".length) as "pause" | "resume" | "cancel", {
        reason: args.reason,
      });
    case "emit":
      return hub.event(args);
    case "tell":
      return hub.tell(args);
  }
}

export const mcpError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

export function createMcp(identity: Identity, client: (key: string) => Hub) {
  const tools = toolsFor(identity);
  return async (request: any) => {
    if (
      !request ||
      request.jsonrpc !== "2.0" ||
      typeof request.method !== "string" ||
      (request.id !== undefined && typeof request.id !== "string" && typeof request.id !== "number")
    )
      return mcpError(null, -32600, "请求格式不正确");
    const { id, method, params } = request;
    if (id === undefined) return;
    const reply = (result: object) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      return reply({
        protocolVersion: MCP_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "agent-autoloop", version: versionName() },
      });
    }
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools });
    if (method !== "tools/call") return mcpError(id, -32601, "没有这个方法");
    const tool = tools.find((tool) => tool.name === params?.name);
    const args = params?.arguments ?? {};
    if (!tool || !validArguments(tool, args)) return mcpError(id, -32602, "工具名或参数不正确");
    const key = usesSourceKey(tool.name) ? identity.source!.key : identity.owner!;
    try {
      const result = await callTool(client(key), tool.name, args);
      return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
    } catch (error) {
      return reply({ isError: true, content: [{ type: "text", text: (error as Error).message }] });
    }
  };
}

type Handle = (request: Request) => Promise<Response>;

type Snapshot = { cards: Card[]; recentCards: Card[] };
type Session = {
  key: string;
  ready: boolean;
  seen: Map<number, number>;
  pending: Map<string, Card>;
  replies: Map<string, string>;
  send?: (message: object) => void;
  stop?: () => void;
  expires?: NodeJS.Timeout;
};

/** Sessions retain only transport state; open cards and accepted answers always come from the hub. */
export function createMcpHttp(
  handle: Handle,
  whose: (kind: string, key: string) => string | null,
  publicUrl: string,
  snapshot: () => Snapshot,
) {
  const sessions = new Map<string, Session>();
  const encoder = new TextEncoder();
  const client = (key: string) => hubClient("http://hub", key, (input, init) => handle(new Request(input, init)));
  function remove(id: string) {
    const session = sessions.get(id);
    if (!session) return;
    session.stop?.();
    clearTimeout(session.expires);
    sessions.delete(id);
  }
  function cancel(session: Session, id: string) {
    session.send?.({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: id, reason: "卡片已更新或回答" },
    });
    session.pending.delete(id);
    session.replies.set(id, "");
  }
  function sync(session: Session, state: Snapshot) {
    if (!session.ready || !session.send) return;
    const cards = [...state.cards, ...state.recentCards];
    const visible = new Map(cards.map((card) => [card.id, card]));
    for (const [id, card] of session.pending) {
      const current = visible.get(card.id);
      if (!current || current.state !== "open" || current.version !== card.version) cancel(session, id);
    }
    for (const card of cards) {
      if (session.seen.get(card.id) === card.version) continue;
      session.seen.set(card.id, card.version);
      if (card.state !== "open") {
        session.send({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level: "notice", logger: "cards", data: card },
        });
        continue;
      }
      const id = randomUUID();
      session.pending.set(id, card);
      const text = { type: "string", title: "补充文字", maxLength: 4000 };
      const properties =
        card.kind === "ask"
          ? {
              choice: {
                type: "string",
                title: "请选择",
                oneOf: [
                  ...card.options.map((title, index) => ({ const: String(index), title })),
                  { const: "free", title: "用文字回答" },
                ],
                ...(card.recommend !== null && { default: String(card.recommend) }),
              },
              text,
            }
          : { ack: { type: "boolean", title: "已处理" }, text };
      session.send({
        jsonrpc: "2.0",
        id,
        method: "elicitation/create",
        params: {
          mode: "form",
          message: `中台卡片 #${card.id}：${card.title}\n${card.text}`,
          requestedSchema: { type: "object", properties, required: [card.kind === "ask" ? "choice" : "ack"] },
        },
      });
    }
    for (const id of session.seen.keys()) if (!visible.has(id)) session.seen.delete(id);
  }
  function refresh() {
    let state: Snapshot | undefined;
    for (const [id, session] of sessions) {
      if (!whose("owner", session.key)) {
        remove(id);
        continue;
      }
      if (session.send && session.ready) sync(session, (state ??= snapshot()));
    }
  }
  function openStream(session: Session, signal: AbortSignal) {
    session.stop?.();
    clearTimeout(session.expires);
    let cancelled = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const finish = (close: boolean) => {
          if (closed) return;
          closed = true;
          signal.removeEventListener("abort", stop);
          session.send = undefined;
          session.stop = undefined;
          if (close) controller.close();
          // HTTP MCP permits session expiry; keep a disconnected client long enough to reconnect.
          session.expires = setTimeout(() => {
            for (const [id, saved] of sessions) if (saved === session) remove(id);
          }, 30 * 60_000).unref();
        };
        const stop = () => finish(true);
        cancelled = () => finish(false);
        session.stop = stop;
        session.send = (message) =>
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
        signal.addEventListener("abort", stop, { once: true });
        controller.enqueue(encoder.encode(": connected\n\n"));
        for (const id of session.pending.keys()) cancel(session, id);
        session.seen.clear();
        if (signal.aborted) stop();
        else sync(session, snapshot());
      },
      cancel() {
        cancelled();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
    });
  }
  async function respond(session: Session, message: any) {
    const id = message.id;
    const encoded = JSON.stringify(message);
    const saved = session.replies.get(id);
    const error = (status: number, text: string) => Response.json({ error: text }, { status });
    if (saved !== undefined)
      return saved === "" || saved === encoded
        ? new Response(null, { status: 202 })
        : error(409, "同一次提问不能换一个回答");
    const card = session.pending.get(id);
    if (!card) return error(400, "不是发给本客户端的提问");
    const result = message.result;
    if (message.error || result?.action === "decline" || result?.action === "cancel") {
      session.pending.delete(id);
      session.replies.set(id, encoded);
      return new Response(null, { status: 202 });
    }
    const content = result?.content;
    const allowed = card.kind === "ask" ? ["choice", "text"] : ["ack", "text"];
    if (
      result?.action !== "accept" ||
      !content ||
      typeof content !== "object" ||
      Array.isArray(content) ||
      Object.keys(content).some((key) => !allowed.includes(key)) ||
      (content.text !== undefined && typeof content.text !== "string")
    )
      return error(400, "卡片回答格式不正确");
    let given: { choice?: number; text?: string };
    if (card.kind === "ask") {
      if (content.choice === "free") {
        if (!content.text?.trim()) return error(400, "文字回答不能为空");
        given = { text: content.text };
      } else {
        const choice = card.options.findIndex((_option, index) => String(index) === content.choice);
        if (choice < 0) return error(400, "没有这个选项");
        given = { choice, ...(content.text !== undefined && { text: content.text }) };
      }
    } else {
      if (content.ack !== true) return error(400, "未确认已处理");
      given = { ...(content.text !== undefined && { text: content.text }) };
    }
    try {
      await client(session.key).answer(card.id, given);
    } catch (failure) {
      return error(400, (failure as Error).message);
    }
    session.pending.delete(id);
    session.replies.set(id, encoded);
    return new Response(null, { status: 202 });
  }
  return {
    refresh,
    close() {
      for (const id of sessions.keys()) remove(id);
    },
    async handle(request: Request) {
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
      const key = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1] ?? "";
      const owner = whose("owner", key);
      const source = owner ? null : whose("source", key);
      if (!owner && !source) return json({ error: "要本人或来源自己的密钥" }, 401, { "www-authenticate": "Bearer" });
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== new URL(publicUrl).origin) return json({ error: "不允许这个 Origin" }, 403);
      const sessionId = request.headers.get("mcp-session-id");
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && (!session || session.key !== key)) return json({ error: "没有这个 MCP 会话" }, 404);
      const version = request.headers.get("mcp-protocol-version");
      if (version !== null && version !== MCP_VERSION) return json({ error: "不支持这个 MCP 协议版本" }, 400);
      if (request.method === "GET" && session) {
        if (version !== MCP_VERSION) return json({ error: "要提供 MCP-Protocol-Version" }, 400);
        if (!request.headers.get("accept")?.includes("text/event-stream"))
          return json({ error: "Accept 要包含 text/event-stream" }, 406);
        return openStream(session, request.signal);
      }
      if (request.method === "DELETE" && sessionId) {
        remove(sessionId);
        return new Response(null, { status: 204 });
      }
      if (request.method !== "POST") return json({ error: "这个 MCP 入口只接受 POST" }, 405, { allow: "POST" });
      if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        return json({ error: "Content-Type 要是 application/json" }, 415);
      }
      const accept = request.headers
        .get("accept")
        ?.split(",")
        .map((part) => part.split(";", 1)[0].trim());
      if (!accept?.includes("application/json") || !accept.includes("text/event-stream")) {
        return json({ error: "Accept 要包含 application/json 和 text/event-stream" }, 406);
      }
      const limit = 1024 * 1024;
      if (Number(request.headers.get("content-length")) > 8 * limit) return json({ error: "请求最多 1024 KB" }, 413);
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = request.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          // Drain modest excess so closing the unread upload does not reset the client's 413 response.
          if (size > 8 * limit) return json({ error: "请求最多 1024 KB" }, 413);
          if (size <= limit) chunks.push(value);
        }
      }
      if (size > limit) return json({ error: "请求最多 1024 KB" }, 413);
      let message: any;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return json(mcpError(null, -32700, "不是 JSON"), 400);
      }
      if (version === null && message?.method !== "initialize") {
        return json({ error: "要提供 MCP-Protocol-Version: 2025-11-25" }, 400);
      }
      if (
        message?.jsonrpc === "2.0" &&
        message.method === undefined &&
        (typeof message.id === "string" || typeof message.id === "number") &&
        Object.hasOwn(message, "result") !== Object.hasOwn(message, "error")
      ) {
        if (!session) return new Response(null, { status: 202 });
        return respond(session, message);
      }
      if (session && message?.method === "notifications/initialized") {
        session.ready = true;
        sync(session, snapshot());
      }
      const identity = owner ? { owner: key } : { source: { key } };
      // Stay on the existing API without connecting back over the network or trusting the incoming Host header.
      const answer = await createMcp(identity, (token) =>
        hubClient("http://hub", token, (input, init) => handle(new Request(input, init))),
      )(message);
      if (!answer) return new Response(null, { status: 202 });
      const elicitation = message?.params?.capabilities?.elicitation;
      const supportsForm =
        elicitation &&
        typeof elicitation === "object" &&
        !Array.isArray(elicitation) &&
        (Object.keys(elicitation).length === 0 || (elicitation.form && typeof elicitation.form === "object"));
      if (!sessionId && owner && message.method === "initialize" && supportsForm && "result" in answer) {
        const id = randomUUID();
        sessions.set(id, { key, ready: false, seen: new Map(), pending: new Map(), replies: new Map() });
        Object.assign(answer.result, {
          capabilities: { tools: {}, logging: {} },
          instructions:
            "本客户端已注册接收中台卡片。用户通过 Elicitation 表单回答，只有实际提交的回答生效。无需调用等待工具；不要替用户自动回答卡片。",
        });
        return json(answer, 200, { "mcp-session-id": id });
      }
      return json(answer, "error" in answer && answer.error.code === -32600 ? 400 : 200);
    },
  };
}
