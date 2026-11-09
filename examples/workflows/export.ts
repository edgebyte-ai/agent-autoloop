import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [source, target] = process.argv.slice(2);
if (!source || !target) throw new Error("用法：node export.ts <输入文件> <交付文件>");
const text = readFileSync(source, "utf8");
if (!text.trim()) throw new Error("文件还是空的，未导出");
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, text);
console.log(`已导出 ${target}`);
console.log(
  `\n\`\`\`agent-autoloop-workflow\n${JSON.stringify({ output: { artifact: path.resolve(target) } })}\n\`\`\``,
);
