# proto-mapper — import `.proto` files as typed gRPC

A working reylo-style content mapper for Protocol Buffers: `import { Greeter } from "./greeter.proto"`
gives you a typed gRPC client, typed server handlers, and message types — checked against the
`.proto` itself, with no generated files.

Requires: TypeScript **7.1 beta** (`contentMappers`), Node ≥ 24, `protoc` on `PATH`.

## Run it

```sh
npm install                       # links proto-mapper (file:) and installs grpc-js
npm run typecheck                 # tsc --noEmit --runExternalCode
npm start                         # node --import proto-mapper/register src/main.ts
npm run inspect                   # print the virtual TypeScript behind greeter.proto
```

`npm start` boots a real gRPC server and a real client in one process:

```
unary: { message: 'hello Ada', serverTime: 1700000000n }
stream: { message: 'hello Ada (one)', serverTime: 1700000000n }
...
```

## The three pieces

**1. `proto-mapper/src/mapper.ts` — the content mapper** (declared in `proto-mapper/package.json`
under `typescript.contentMapper`). It never parses `.proto` itself: for each file it runs

```
protoc -I <dirs> --descriptor_set_out=set.binpb --include_imports --include_source_info <file>
```

and renders the resulting `FileDescriptorSet` (`src/descriptor.ts` decodes it, `src/render.ts` writes
the module). This is reylo's move — ask the real engine instead of reimplementing the language. The
payoff is `SourceCodeInfo`: protoc hands back every declaration's span and doc comment, which become
`mappings` (go-to-definition into the `.proto`) and JSDoc (hover).

**2. `proto-mapper/src/register.ts` + `loader-runtime.ts` — the runtime loader.** Content-mapped
files are never emitted to JavaScript, so `--import proto-mapper/register` installs a Node
`registerHooks` `load()` that turns a `.proto` into a real module via `@grpc/proto-loader`, exporting
exactly the names the mapper declared. `loader-runtime.ts` normalizes protobufjs's shapes into the
declared ones: `int64` → `bigint`, enums → their names, `oneof` → `{ case, value }`, and callback-style
unary calls → promises.

**3. `proto.config.json`** — include paths, read in `openProject` (`dynamicConfig: true`), reported back
as `configIdentity` + `watchedFiles`.

## What you get

`proto/greeter.proto` →

```ts
export interface HelloRequest {
  /** Who to greet. */
  name: string; // = 1
  labels: Record<string, string>; // = 2
  tags: string[]; // = 3
  locale?: string; // = 4
  contact?: { case: "email"; value: string } | { case: "phone"; value: string };
  sentAtUnix: bigint; // = 7
  from: UserId; // = 8, imported from ./common.proto
  preferredContact: ContactPreference; // = 9, a union of the enum's names
  signature: Uint8Array; // = 10
}
export declare const HelloRequest: MessageCodec<HelloRequest>;

export interface GreeterClient {
  close(): void;
  sayHello(request: HelloRequest, options?: CallOptions): Promise<HelloReply>;
  sayHelloStream(request: HelloRequest, options?: CallOptions): AsyncIterable<HelloReply>;
}
export declare const Greeter: ServiceClientCtor<GreeterClient>;
export declare const GreeterDefinition: ServiceDefinition;

export interface GreeterHandlers extends UntypedServiceImplementation { … }
```

Errors land where you wrote them:

```
proto/scratch.proto(7,14): error proto-mapper2: Missing field number.
src/main.ts(53,37): error TS2345: … 'string' is not assignable to type 'ContactPreference'.
```

## Editor setup (why you might see TS2307 "Cannot find module '../proto/greeter.proto'")

The same as reylo — the editor needs pointing at the right language server, which is a project
setting, not a mapper concern:

1. Install the **TypeScript 7** extension in VS Code/Cursor (`TypeScriptTeam.native-preview`).
2. Use the workspace's `.vscode/settings.json` (already in this repo): it sets
   `js/ts.experimental.useTsgo` and `js/ts.tsdk.path: ./node_modules/typescript` — the extension's
   own bundled copy is 7.0, which predates content mappers.
3. **Trust the workspace**, and click **Allow** when the extension asks to use the workspace's
   TypeScript (it waits under the bell in the status bar; `Developer: Reload Window` re-asks).
   Content mappers run external processes, so they are enabled in trusted workspaces only.

**Neovim** (nvim-lspconfig `tsc`): the server must get the opt-in as `init_options`, not a CLI flag
(`tsc --lsp` has no `--runExternalCode` argument):

```lua
vim.lsp.config("tsc", {
  init_options = { runExternalCode = true },
  -- so the client opens .proto buffers too: mapper errors show inside the .proto, hover works
  filetypes = { "javascript", "javascriptreact", "typescript", "typescriptreact", "proto" },
})
```

`tools/lsp-check.ts` reproduces both states against the project's own tsgo: `node tools/lsp-check.ts`
(clean) vs `node tools/lsp-check.ts --no-flag` (error 18068 on tsconfig.json).

Plain `tsc` in a terminal always needs `--runExternalCode` (use `npm run typecheck`); without it you
get TS18068 plus a 2307 cascade for every `.proto` import.

## Limitations (v0.0.1)

- `protoc` must be installed; the mapper runs it per file (cached by content hash).
- The transform reads the file from disk, so unsaved editor buffers are stale (fine for `tsc`).
- Proto3 only; nested messages are flattened (`Outer_Inner`); well-known types are inlined as
  structural types rather than imported.
- The loader is Node-only (`registerHooks`); no Bun/Vite/Next plugin, no Workers lane.
- The types are tied to `@grpc/grpc-js` + `@grpc/proto-loader` shapes; `connect-es`/gRPC-Web would
  need a second rendering profile.
