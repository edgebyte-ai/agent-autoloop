// The stdio transport uses the identities in this machine's config; each message is answered independently.
import { readConfig } from "../host/config.ts";
import { eachLine } from "../host/lines.ts";
import { createMcp, mcpError } from "../host/mcp.ts";
import { hubClient } from "../protocol/client.ts";

export async function mcp() {
  const config = readConfig();
  const answer = createMcp(config, (key) => hubClient(config.url, key));
  eachLine(process.stdin, (line) => {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      console.log(JSON.stringify(mcpError(null, -32700, "不是 JSON")));
      return;
    }
    void answer(request).then((reply) => {
      if (reply) console.log(JSON.stringify(reply));
    });
  });
}
