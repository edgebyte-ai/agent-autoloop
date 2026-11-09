// `agent-autoloop mcp`: the hub's doors as MCP tools over stdio, using the keys already in this machine's config.json.
import { readConfig } from "../host/config.ts";
import { eachLine } from "../host/lines.ts";
import { versionName } from "../host/version.ts";
import { hubClient, type Hub } from "../protocol/client.ts";

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
    "用本机来源发送事件；相同编号只记一次",
    { id: string, type: string, subject: string, summary: string, detail: string, link: string },
    ["id", "type"],
  ],
  ["tell", "用本机来源发送通知；相同编号只发一次", { key: string, text: string }, ["key", "text"]],
] as const;

const usesSourceKey = (name: string) => ["emit", "tell"].includes(name);

function toolsFor(config: ReturnType<typeof readConfig>) {
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

export async function mcp() {
  const config = readConfig();
  const tools = toolsFor(config);
  const reply = (id: unknown, body: object) => console.log(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
  const refuse = (id: unknown, code: number, message: string) => reply(id, { error: { code, message } });

  async function answerCall(id: unknown, params: any) {
    const tool = tools.find((tool) => tool.name === params?.name);
    const args = params?.arguments ?? {};
    if (!tool || !validArguments(tool, args)) return refuse(id, -32602, "工具名或参数不正确");
    const hub = hubClient(config.url, usesSourceKey(tool.name) ? config.source!.key : config.owner!);
    try {
      const result = await callTool(hub, tool.name, args);
      reply(id, { result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } catch (error) {
      reply(id, { result: { isError: true, content: [{ type: "text", text: (error as Error).message }] } });
    }
  }

  eachLine(process.stdin, (line) => {
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      return refuse(null, -32700, "不是 JSON");
    }
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return refuse(request?.id ?? null, -32600, "请求格式不正确");
    }
    const { id, method, params } = request;
    if (id === undefined) return;
    if (method === "initialize") {
      const serverInfo = { name: "agent-autoloop", version: versionName() };
      reply(id, { result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo } });
    } else if (method === "ping") reply(id, { result: {} });
    else if (method === "tools/list") reply(id, { result: { tools } });
    // Each answers by itself, however long it takes: a client's ping has to get through meanwhile.
    else if (method === "tools/call") void answerCall(id, params);
    else refuse(id, -32601, "没有这个方法");
  });
}
