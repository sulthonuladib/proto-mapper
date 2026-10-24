// `node --import proto-mapper/register` (or `bun --preload`): teaches Node what a `.proto` module
// is at run time. Node asks the load hook synchronously, and @grpc/proto-loader reads the file
// synchronously too, so no worker bridge is needed here.
//
// The generated module is one line per export, so the names it publishes are exactly the ones the
// content mapper declared: same .proto, same names, both sides.

import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadNamespace } from "./loader-runtime.ts";

/** Where protoc would have found this file's imports: beside it, and from the working directory. */
const includeDirsFor = (file: string): string[] => [...new Set([dirname(file), process.cwd()])];

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".proto")) return nextLoad(url, context);
    const file = fileURLToPath(url);
    const includeDirs = includeDirsFor(file);
    const names = Object.keys(loadNamespace(file, includeDirs));
    const source = [
      `import { loadNamespace } from "proto-mapper/runtime";`,
      `const ns = loadNamespace(${JSON.stringify(file)}, ${JSON.stringify(includeDirs)});`,
      ...names.map((name) => `export const ${name} = ns[${JSON.stringify(name)}];`),
      ``,
    ].join("\n");
    return { format: "module", source, shortCircuit: true };
  },
});
