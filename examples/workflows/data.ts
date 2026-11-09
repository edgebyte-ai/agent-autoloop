import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

type Row = { label: string; value: number };
const read = (name: string) => JSON.parse(readFileSync(name, "utf8"));
const write = (name: string, value: unknown) => writeFileSync(name, JSON.stringify(value, null, 2) + "\n");
const clean = (rows: Row[]) => {
  if (!Array.isArray(rows) || !rows.length) throw new Error("input.json 要有至少一条记录");
  return rows.map((row) => {
    if (typeof row.label !== "string" || !row.label.trim() || !Number.isFinite(row.value)) {
      throw new Error("每条记录都要有 label 文字和有限数值 value");
    }
    return { label: row.label.trim(), value: row.value };
  });
};
const calculate = (rows: Row[]) => {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return { count: rows.length, total, average: total / rows.length };
};

const step = process.argv[2];
let artifact: string;
switch (step) {
  case "seed":
    artifact = "input.json";
    write(artifact, read(process.argv[3]));
    break;
  case "clean":
    artifact = "cleaned.json";
    write(artifact, clean(read("input.json")));
    break;
  case "calculate":
    artifact = "totals.json";
    write(artifact, calculate(read("cleaned.json")));
    break;
  case "check": {
    const totals = read("totals.json");
    assert.deepEqual(totals, calculate(clean(read("input.json"))), "计算结果与原始输入不一致");
    artifact = "checked.json";
    write(artifact, totals);
    break;
  }
  case "export":
    artifact = "result.json";
    write(artifact, read("checked.json"));
    break;
  default:
    throw new Error("步骤要是 seed、clean、calculate、check 或 export");
}
console.log(`已完成 ${step}：${artifact}`);
console.log(
  `\n\`\`\`agent-autoloop-workflow\n${JSON.stringify({ output: { artifact, data: read(artifact) } })}\n\`\`\``,
);
