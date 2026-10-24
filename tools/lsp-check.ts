// Drives the project's tsgo LSP directly, the way an editor does, and prints the diagnostics it
// publishes for src/main.ts — with and without --runExternalCode.
//
//   node tools/lsp-check.ts            # default: with the flag
//   node tools/lsp-check.ts --no-flag  # without, like an untrusted workspace

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const withFlag = !process.argv.includes("--no-flag");
// The LSP takes no --runExternalCode CLI flag; it is an initialization option (see the VS Code
// extension's client.ts). Passing it as a flag is "flag provided but not defined: -runExternalCode".

const tsgo = spawn("node", [resolve(root, "node_modules/typescript/bin/tsc"), "--lsp", "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });

type Message = { id?: number; method?: string; params?: unknown };
let nextId = 0;
const pending = new Map<number, () => void>();
const notifications: { method: string; params: any }[] = [];
let buffer = Buffer.alloc(0);

tsgo.stdout!.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString())![1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
    buffer = buffer.subarray(headerEnd + 4 + length);
    const message = JSON.parse(body) as Message;
    if (message.id !== undefined && message.method === undefined) pending.get(message.id)?.();
    else if (message.method) {
      notifications.push(message as { method: string; params: any });
      // A request from the server (client/registerCapability, workspace/configuration, …) must be
      // answered or the server blocks; answer with an empty result.
      if (message.id !== undefined) {
        const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null }));
        tsgo.stdin!.write(`Content-Length: ${payload.length}\r\n\r\n`);
        tsgo.stdin!.write(payload);
      }
    }
  }
});

const send = (method: string, params: unknown): Promise<void> => {
  const id = ++nextId;
  const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  tsgo.stdin!.write(`Content-Length: ${payload.length}\r\n\r\n`);
  tsgo.stdin!.write(payload);
  return new Promise((done) => pending.set(id, done));
};
const notify = (method: string, params: unknown): void => {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params }));
  tsgo.stdin!.write(`Content-Length: ${payload.length}\r\n\r\n`);
  tsgo.stdin!.write(payload);
};

const uri = (path: string): string => `file://${resolve(root, path)}`;

await send("initialize", {
  processId: process.pid,
  rootUri: uri("."),
  capabilities: { workspace: { didChangeConfiguration: { dynamicRegistration: true } }, textDocument: {} },
  initializationOptions: withFlag ? { runExternalCode: true } : {},
});
notify("initialized", {});

for (const file of ["src/main.ts", "proto/greeter.proto", "tsconfig.json"]) {
  notify("textDocument/didOpen", {
    textDocument: { uri: uri(file), languageId: file.endsWith(".ts") ? "typescript" : "plaintext", version: 1, text: readFileSync(resolve(root, file), "utf8") },
  });
}

console.log(`tsgo --lsp --stdio ${withFlag ? "initializationOptions: { runExternalCode: true }" : "(no runExternalCode, like an editor that does not enable it)"}`);
await new Promise((done) => setTimeout(done, 12000));

const seen = new Set<string>();
for (const note of notifications) {
  if (note.method !== "textDocument/publishDiagnostics") continue;
  const { uri: document, diagnostics } = note.params as { uri: string; diagnostics: { range: any; message: string; code?: number }[] };
  const key = `${document}: ${diagnostics.length}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const file = document.replace("file://", "");
  for (const diagnostic of diagnostics) console.log(`  ${file.replace(root + "/", "")}: [${diagnostic.code}] ${diagnostic.message.split("\n")[0]}`);
  if (!diagnostics.length) console.log(`  ${file.replace(root + "/", "")}: no diagnostics`);
}
tsgo.kill();
process.exit(0);
