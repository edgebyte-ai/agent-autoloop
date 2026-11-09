import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseRules } from "../../protocol/rules.ts";

export function configure(home: string, examples: string, worker: string) {
  const template = readFileSync(path.join(examples, "rules.json"), "utf8");
  const repository = JSON.stringify(JSON.parse(readFileSync(path.join(examples, "repository.example.json"), "utf8")));
  const publisher = JSON.stringify(JSON.parse(readFileSync(path.join(examples, "publish.example.json"), "utf8")));
  const rules = JSON.parse(template, (_key, value) => {
    if (value === "{repository}") return repository;
    if (value === "{publisher}") return publisher;
    return typeof value === "string" ? value.replaceAll("{examples}", examples) : value;
  });
  for (const agent of Object.values(rules.agents) as { worker: string }[]) agent.worker = worker;
  const cwd = path.join(home, "workflows", "{item}");
  for (const rule of rules.rules) rule.cwd = cwd;
  for (const workflow of Object.values(rules.workflows) as { cwd: string }[]) workflow.cwd = cwd;
  parseRules(JSON.stringify(rules), Date.now(), "UTC");
  return rules;
}

if (import.meta.main) {
  const home = path.resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("用法：node configure.ts <已经 init 的测试数据目录>");
  const config = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"));
  if (!config.worker?.name) throw new Error("测试中台没有配置本机 worker");
  const examples = path.dirname(path.resolve(process.argv[1]));
  const rules = configure(home, examples, config.worker.name);
  const file = path.join(home, "rules.workflows.json");
  writeFileSync(file, JSON.stringify(rules, null, 2) + "\n");
  console.log(`已生成 ${file}。检查后将它复制为该测试目录的 rules.json。`);
}
