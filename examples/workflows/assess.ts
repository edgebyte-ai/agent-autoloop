import { readFileSync } from "node:fs";

type Review = { decision?: string; output?: { findings?: string[] } };

export function assess(outputs: Record<string, Review>, reviewers: string[]) {
  const findings: string[] = [];
  let decision = "pass";
  for (const reviewer of reviewers) {
    const review = outputs[reviewer];
    if (!review || !["pass", "revise"].includes(review.decision ?? "")) {
      throw new Error(`审查 ${reviewer} 没有明确给出 pass 或 revise`);
    }
    if (review.decision === "revise") decision = "revise";
    if (
      !Array.isArray(review.output?.findings) ||
      review.output.findings.some((finding) => typeof finding !== "string")
    ) {
      throw new Error(`审查 ${reviewer} 的 output.findings 要是文字列表`);
    }
    findings.push(...review.output.findings);
  }
  return { decision, output: { findings, reviewers } };
}

if (import.meta.main) {
  const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
  const reviewers = process.argv.slice(2);
  if (!reviewers.length) throw new Error("在可信命令配置中填写必需的审查步骤编号");
  const result = assess(context.workflow.outputs, reviewers);
  console.log(`审查汇总：${result.decision === "pass" ? "全部通过" : "需要修改"}`);
  console.log(`\n\`\`\`agent-autoloop-workflow\n${JSON.stringify(result)}\n\`\`\``);
}
