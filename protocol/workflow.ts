// Workflow definitions contain authority; outputs only select named edges and approved child templates.
import type { Agent } from "../kernel/rules.ts";
import { InputError } from "../kernel/errors.ts";
import type { Job } from "./job.ts";
import { isAsk, parseResult, type Ask, type Usage } from "./validate.ts";

export type WorkflowBudget = { turns: number; activeMs: number; concurrency: number; depth: number; children: number };
export type WorkflowRole = { agent: string; prompt?: string; skill?: string; model?: string; effort?: string };
export type WorkflowChild = { id: string; template: string; after?: string[]; input?: unknown; goal?: string };
type StepFlow = {
  after?: string[];
  next?: string | string[];
  on?: Record<string, string | string[]>;
  maxAttempts: number;
  input?: string[];
  output?: string[];
};
export type WorkflowStep = StepFlow &
  (
    | { kind: "agent"; role: string; prompt?: string; skill?: string }
    | { kind: "command"; command: string[]; reconcile?: string[] }
    | { kind: "workflow"; template?: string; templates?: string[]; planFrom?: string; children?: WorkflowChild[] }
  );
export type WorkflowDefinition = {
  start: string | string[];
  roles: Record<string, WorkflowRole>;
  steps: Record<string, WorkflowStep>;
  budget: WorkflowBudget;
  cwd?: string;
  to?: string;
};
export type WorkflowExecution = {
  id: number;
  step: string;
  attempt: number;
  kind: WorkflowStep["kind"];
  role?: string;
  agent?: Job["agent"];
  cwd: string;
  prompt?: string;
  skill?: string;
  session: string | null;
  command?: string[];
  reconcile?: string[];
  input: unknown;
  outputs: Record<string, unknown>;
  goal: string;
  decisions?: string[];
  timeLimitMs?: number;
};
export type WorkflowCompletion = {
  execution: number;
  outcome: "done" | "failed" | "waiting" | "cancelled" | "blocked";
  decision?: string;
  summary?: string;
  output?: unknown;
  session?: string;
  usage?: Usage;
  activeMs?: number;
  ask?: Ask[];
};
export type WorkflowAdvance = {
  completed?: WorkflowCompletion[];
  started?: { execution: number; session: string; turn?: string }[];
  progress?: { execution: number; summary: string }[];
  blocked?: { execution: number; summary: string }[];
  capacity?: number;
};
export type WorkflowAdvanceResult = {
  item: number;
  root: number;
  state: string;
  release: boolean;
  cancel: boolean;
  executions: WorkflowExecution[];
};

type Check = (value: unknown) => boolean;
type Field = [string, Check, string, boolean?];
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text: Check = (value) => typeof value === "string" && value.trim().length > 0;
const words: Check = (value) => Array.isArray(value) && value.length > 0 && value.every(text);
const dependencies: Check = (value) => Array.isArray(value) && value.every(text);
const count: Check = (value) => Number.isSafeInteger(value) && (value as number) > 0;
const nonnegative: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 0;
const id: Check = (value) => typeof value === "string" && /^[a-z][a-z0-9_-]*$/.test(value);
const folder: Check = (value) =>
  typeof value === "string" && /^(~[/\\]|\/|[a-z]:[/\\]|\\\\[^\\]+\\[^\\]+)/i.test(value);
const list = (value: string | string[]) => (Array.isArray(value) ? value : [value]);
const shortText: Check = (value) => typeof value === "string" && [...value].length <= 500;

function fields(issues: string[], where: string, value: unknown, spec: Field[]): value is Record<string, any> {
  if (!object(value)) {
    issues.push(`${where}要是一个对象`);
    return false;
  }
  for (const [name, check, problem, optional] of spec) {
    if (!Object.hasOwn(value, name)) {
      if (!optional) issues.push(`${where}缺少 ${name}`);
    } else if (!check(value[name])) issues.push(`${where}的 ${name} ${problem}`);
  }
  for (const name of Object.keys(value))
    if (!spec.some(([known]) => known === name)) issues.push(`${where}有不认识的字段 ${name}`);
  return true;
}

export function parseWorkflowAdvance(value: unknown): WorkflowAdvance {
  const issues: string[] = [];
  if (
    !fields(issues, "工作流回报 ", value, [
      ["completed", Array.isArray, "要是列表", true],
      ["started", Array.isArray, "要是列表", true],
      ["progress", Array.isArray, "要是列表", true],
      ["blocked", Array.isArray, "要是列表", true],
      ["capacity", nonnegative, "要是非负整数", true],
    ])
  )
    throw new InputError(issues.join("；"));
  for (const completion of Array.isArray(value.completed) ? value.completed : []) {
    if (
      !fields(issues, "步骤结果 ", completion, [
        ["execution", count, "要是正整数"],
        ["outcome", (v) => ["done", "failed", "waiting", "cancelled", "blocked"].includes(v as string), "不是已知状态"],
        ["decision", (v) => text(v) && shortText(v), "要是500字以内的文字", true],
        ["summary", shortText, "要是500字以内的文字", true],
        ["output", () => true, "", true],
        ["session", (v) => text(v) && shortText(v), "要是500字以内的会话编号", true],
        ["usage", object, "要是用量对象", true],
        ["activeMs", nonnegative, "要是非负整数", true],
        ["ask", (v) => Array.isArray(v) && v.length <= 5 && v.every(isAsk), "要是最多5个有效问题", true],
      ])
    )
      continue;
    if (completion.usage !== undefined) parseResult({ outcome: "done", usage: completion.usage });
  }
  for (const started of Array.isArray(value.started) ? value.started : [])
    fields(issues, "步骤会话 ", started, [
      ["execution", count, "要是正整数"],
      ["session", (v) => text(v) && shortText(v), "要是500字以内的会话编号"],
      ["turn", (v) => text(v) && shortText(v), "要是500字以内的执行轮编号", true],
    ]);
  for (const kind of ["progress", "blocked"])
    for (const update of Array.isArray(value[kind]) ? value[kind] : [])
      fields(issues, `步骤 ${kind} `, update, [
        ["execution", count, "要是正整数"],
        ["summary", (v) => text(v) && shortText(v), "要是500字以内的说明"],
      ]);
  if (issues.length) throw new InputError(issues.join("；"));
  return value as WorkflowAdvance;
}

function dependencyIssues(entries: { id: string; after?: string[] }[]): string[] {
  const issues: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const visit = (name: string) => {
    if (visiting.has(name)) return void issues.push(`依赖有循环：${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of byId.get(name)?.after ?? []) {
      if (!byId.has(dependency)) issues.push(`${name} 的 after 没有定义：${dependency}`);
      else visit(dependency);
    }
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of byId.keys()) visit(name);
  return issues;
}

/** Child plans are data, not instructions: only template names and dependency/input data cross this boundary. */
export function checkWorkflowChildren(value: unknown, allowed: string[]): string[] {
  const issues: string[] = [];
  if (!Array.isArray(value) || !value.length) return ["子项计划要是非空列表"];
  const names = new Set<string>();
  for (const child of value) {
    if (
      !fields(issues, `子项 ${object(child) ? (child.id ?? "") : ""} `, child, [
        ["id", id, "只能用小写字母、数字、- 和 _"],
        ["template", (v) => typeof v === "string" && allowed.includes(v), "不是允许的模板"],
        ["after", dependencies, "要是子项编号列表", true],
        ["input", () => true, "", true],
        ["goal", text, "不能为空", true],
      ])
    )
      continue;
    if (names.has(child.id)) issues.push(`子项编号重复：${child.id}`);
    names.add(child.id);
  }
  const entries = value
    .filter(object)
    .map((child) => ({ id: child.id, after: Array.isArray(child.after) ? child.after : [] }));
  issues.push(...dependencyIssues(entries).map((problem) => `子项${problem}`));
  return issues;
}

export function checkWorkflows(value: unknown, agents: Record<string, Agent>): string[] {
  const issues: string[] = [];
  if (!object(value)) return ["workflows 要是一个对象"];
  const templates = Object.keys(value);
  const registered = (v: unknown) => typeof v === "string" && Object.hasOwn(agents, v) && object(agents[v]);
  for (const [name, definition] of Object.entries(value)) {
    const where = `工作流 ${name} `;
    if (!id(name)) issues.push(`${where}编号只能用小写字母、数字、- 和 _`);
    if (
      !fields(issues, where, definition, [
        ["start", (v) => text(v) || words(v), "要是步骤编号或列表"],
        ["roles", object, "要是一个对象"],
        ["steps", (v) => object(v) && Object.keys(v).length > 0, "要是非空对象"],
        ["budget", object, "要是一个对象"],
        ["cwd", folder, "要是绝对目录", true],
        ["to", registered, "不是已登记的 Agent", true],
      ])
    )
      continue;
    fields(issues, `${where}的 budget `, definition.budget, [
      ["turns", count, "要是正整数"],
      ["activeMs", count, "要是正整数"],
      ["concurrency", count, "要是正整数"],
      ["depth", nonnegative, "要是非负整数"],
      ["children", nonnegative, "要是非负整数"],
    ]);
    const roles = object(definition.roles) ? definition.roles : {};
    const workers = new Set<string>();
    if (registered(definition.to)) workers.add(agents[definition.to].worker);
    for (const [role, config] of Object.entries(roles)) {
      if (!id(role)) issues.push(`${where}角色编号不正确：${role}`);
      if (
        fields(issues, `${where}角色 ${role} `, config, [
          ["agent", registered, `不是已登记的 Agent：${object(config) ? config.agent : ""}`],
          ...["prompt", "skill", "model", "effort"].map((field): Field => [field, text, "不能为空", true]),
        ]) &&
        registered(config.agent)
      )
        workers.add(agents[config.agent].worker);
    }
    if (!Object.keys(roles).length && !definition.to) issues.push(`${where}没有角色时要写 to`);
    if (workers.size > 1) issues.push(`${where}同一工作项的角色要使用同一个 worker`);
    const steps = object(definition.steps) ? definition.steps : {};
    const edge: Check = (v) =>
      (text(v) || words(v)) && list(v as string | string[]).every((target) => Object.hasOwn(steps, target));
    if (!edge(definition.start)) issues.push(`${where}的 start 不是已定义步骤：${definition.start}`);
    for (const [step, config] of Object.entries(steps)) {
      const here = `${where}步骤 ${step} `;
      if (!id(step)) issues.push(`${here}编号不正确`);
      const kind = object(config) ? config.kind : undefined;
      const common: Field[] = [
        ["kind", (v) => ["agent", "command", "workflow"].includes(v as string), "只能是 agent、command 或 workflow"],
        [
          "after",
          (v) => dependencies(v) && (v as string[]).every((s) => s !== step && Object.hasOwn(steps, s)),
          "要是其他已定义步骤的列表",
          true,
        ],
        ["next", edge, `不是已定义步骤：${object(config) ? config.next : ""}`, true],
        [
          "on",
          (v) => object(v) && Object.values(v).every(edge),
          `要指向已定义步骤：${JSON.stringify(object(config) ? config.on : null)}`,
          true,
        ],
        ["maxAttempts", count, "要是正整数", true],
        ["input", words, "要是资料名称列表", true],
        ["output", words, "要是产物名称列表", true],
      ];
      const specific: Field[] =
        kind === "agent"
          ? [
              ["role", (v) => typeof v === "string" && Object.hasOwn(roles, v), `不是已定义角色：${config.role}`],
              ["prompt", text, "不能为空", true],
              ["skill", text, "不能为空", true],
            ]
          : kind === "command"
            ? [
                ["command", words, "要是命令与参数的列表"],
                ["reconcile", words, "要是核对命令与参数的列表", true],
              ]
            : [
                ["template", (v) => typeof v === "string" && templates.includes(v), "不是已定义模板", true],
                [
                  "templates",
                  (v) => words(v) && (v as string[]).every((t) => templates.includes(t)),
                  "要是已定义模板的列表",
                  true,
                ],
                ["planFrom", (v) => typeof v === "string" && Object.hasOwn(steps, v), "不是已定义步骤", true],
                ["children", Array.isArray, "要是子项列表", true],
              ];
      if (!fields(issues, here, config, [...common, ...specific])) continue;
      config.maxAttempts ??= 1;
      if (kind !== "workflow") continue;
      const choices =
        Number(config.template !== undefined) +
        Number(config.children !== undefined) +
        Number(config.planFrom !== undefined);
      if (choices !== 1) issues.push(`${here}template、children、planFrom 只能且必须选一个`);
      if (config.planFrom !== undefined && !config.templates?.length)
        issues.push(`${here}planFrom 要配 templates 白名单`);
      if (config.templates !== undefined && config.planFrom === undefined)
        issues.push(`${here}templates 只能与 planFrom 一起使用`);
      if (Array.isArray(config.children))
        issues.push(...checkWorkflowChildren(config.children, templates).map((problem) => `${here}${problem}`));
      const used = [
        config.template,
        ...(Array.isArray(config.templates) ? config.templates : []),
        ...(Array.isArray(config.children) ? config.children.filter(object).map((c: any) => c.template) : []),
      ].filter((t): t is string => typeof t === "string");
      for (const template of used) {
        const child = value[template];
        if (object(child) && (typeof child.cwd !== "string" || !child.cwd.includes("{item}")))
          issues.push(`${here}子项模板 ${template} 的 cwd 要含 {item}，每个工作项使用自己的目录`);
      }
    }
    const entries = Object.entries(steps).map(([id, step]) => ({
      id,
      after: object(step) && Array.isArray(step.after) ? step.after : [],
    }));
    issues.push(...dependencyIssues(entries).map((problem) => `${where}步骤${problem}`));
  }
  return issues;
}
