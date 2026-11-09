// Both MCP transports expose the same typed operations and leave business decisions to the hub HTTP API.
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

export async function mcpHttp(
  request: Request,
  handle: Handle,
  whose: (kind: string, key: string) => string | null,
  publicUrl: string,
) {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
  const key = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1] ?? "";
  const owner = whose("owner", key);
  const source = owner ? null : whose("source", key);
  if (!owner && !source) return json({ error: "要本人或来源自己的密钥" }, 401, { "www-authenticate": "Bearer" });
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(publicUrl).origin) return json({ error: "不允许这个 Origin" }, 403);
  if (request.method !== "POST") return json({ error: "这个 MCP 入口只接受 POST" }, 405, { allow: "POST" });
  const version = request.headers.get("mcp-protocol-version");
  if (version !== null && version !== MCP_VERSION) return json({ error: "不支持这个 MCP 协议版本" }, 400);
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
  )
    return new Response(null, { status: 202 });
  const identity = owner ? { owner: key } : { source: { key } };
  // Stay on the existing API without connecting back over the network or trusting the incoming Host header.
  const answer = await createMcp(identity, (token) =>
    hubClient("http://hub", token, (input, init) => handle(new Request(input, init))),
  )(message);
  if (!answer) return new Response(null, { status: 202 });
  return json(answer, "error" in answer && answer.error.code === -32600 ? 400 : 200);
}
