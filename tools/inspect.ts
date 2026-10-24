// Speaks the content mapper protocol to proto-mapper directly, the way tsc does, and prints the
// virtual TypeScript behind `import ... from "./greeter.proto"`. Nothing here needs the TypeScript
// compiler: the mapper is an ordinary process.
//
//   node --experimental-strip-types tools/inspect.ts greeter.proto

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = resolve(root, "proto", process.argv[2] ?? "greeter.proto");

const mapper = spawn("node", [resolve(root, "proto-mapper/src/mapper.ts")], { stdio: ["pipe", "pipe", "inherit"] });

let id = 0;
const pending = new Map<number, (result: unknown) => void>();
let buffer = Buffer.alloc(0);

mapper.stdout.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString())![1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
    buffer = buffer.subarray(headerEnd + 4 + length);
    const message = JSON.parse(body) as { id: number; result?: unknown; error?: unknown };
    if (message.error) throw new Error(JSON.stringify(message.error));
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  }
});

function call(method: string, params: unknown): Promise<any> {
  const request = { jsonrpc: "2.0", id: ++id, method, params };
  const payload = Buffer.from(JSON.stringify(request));
  mapper.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
  mapper.stdin.write(payload);
  return new Promise((resolve) => pending.set(request.id, resolve));
}

await call("initialize", { protocolVersion: 1, locale: "en" });
const project = await call("openProject", {
  projectHandle: "inspect",
  configFileName: resolve(root, "tsconfig.json"),
  compilerOptions: {},
});
console.log("openProject:", project);

const result = await call("transform", {
  fileName: file,
  content: readFileSync(file, "utf8"),
  projectHandle: "inspect",
});
console.log(`\n--- ${file} (${result.text.length} bytes, ${result.mappings.length} mappings) ---\n`);
console.log(result.text);

const source = readFileSync(file, "utf8");
const position = (offset: number): string => {
  const before = source.slice(0, offset).split("\n");
  return `${before.length}:${before[before.length - 1]!.length + 1}`;
};
console.log(`--- span mappings: virtual text -> ${process.argv[2] ?? "greeter.proto"} ---`);
for (const [virtualStart, virtualLength, originalStart, originalLength] of result.mappings.slice(0, 8)) {
  const virtual = result.text.slice(virtualStart, virtualStart + virtualLength).trim().split("\n")[0]!;
  const original = source.slice(originalStart, originalStart + originalLength).trim().split("\n")[0]!;
  console.log(`  ${JSON.stringify(virtual).padEnd(44)} -> ${position(originalStart).padEnd(6)} ${JSON.stringify(original)}`);
}
if (result.diagnostics.length) console.log("diagnostics:", result.diagnostics);
mapper.stdin.end();
