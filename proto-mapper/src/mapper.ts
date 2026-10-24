// The content mapper TypeScript starts (package.json, `typescript.contentMapper`).
//
// It does not parse .proto itself. For each file it asks protoc for a FileDescriptorSet
// (`--descriptor_set_out --include_imports --include_source_info`), which resolves the import
// graph, validates the file, and reports the source span and comments of every declaration. The
// renderer turns that into a virtual TypeScript module. This is the same division of labour as
// reylo asking Postgres to PREPARE a statement instead of parsing SQL.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { decodeFileDescriptorSet } from "./descriptor.ts";
import { renderFile, type Diagnostic } from "./render.ts";
import { serve } from "./rpc.ts";

type Project = {
  dir: string;
  includeDirs: string[];
  configFile: string | undefined;
  identity: string;
};

const projects = new Map<string, Project>();
const cache = new Map<string, unknown>();

function protocVersion(): string {
  try {
    return execFileSync("protoc", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "missing";
  }
}

/** The project's extra include paths, from `proto.config.json` beside its tsconfig. */
function readConfig(dir: string): { include: string[]; file?: string } {
  for (const name of ["proto.config.json"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { include?: string[] };
      return { include: (parsed.include ?? []).map((path) => (isAbsolute(path) ? path : resolve(dir, path))), file };
    } catch {
      return { include: [], file };
    }
  }
  return { include: [] };
}

const lineStartsOf = (source: string): number[] => {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
};

/**
 * protoc's complaints, placed in the file being transformed. Its messages read
 * `file.proto:5:3: Expected …`; one about an import has no line, and lands at the top of the file
 * that made it.
 */
function diagnosticsFrom(stderr: string, fileName: string, content: string): Diagnostic[] {
  const lineStarts = lineStartsOf(content);
  const diagnostics: Diagnostic[] = [];
  for (const line of stderr.split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("--") || /^\[libprotoc/.test(text)) continue;
    const match = /^(.*?):(\d+):(\d+):\s*(.*)$/.exec(text);
    if (match) {
      const [, file, lineNumber, column, message] = match as unknown as [string, string, string, string, string];
      if (basename(file) !== basename(fileName)) {
        diagnostics.push({ messageText: `${file}: ${message}`, start: 0, length: 1, code: 3 });
        continue;
      }
      const start = (lineStarts[Number(lineNumber) - 1] ?? 0) + Number(column) - 1;
      diagnostics.push({ messageText: message, start, length: 1, code: 2 });
      continue;
    }
    const named = /^(.*?):\s*(.*)$/.exec(text);
    diagnostics.push({ messageText: named ? (basename(named[1]!) === basename(fileName) ? named[2]! : text) : text, start: 0, length: 1, code: 3 });
  }
  return diagnostics;
}

/** protoc's answer for one file, cached by its text so a second request costs nothing. */
function build(fileName: string, content: string, includeDirs: string[]): { text: string; mappings: number[][]; diagnostics: Diagnostic[] } {
  const key = createHash("sha1").update(fileName).update("\0").update(content).update("\0").update(includeDirs.join("\0")).digest("hex");
  const hit = cache.get(key) as { text: string; mappings: number[][]; diagnostics: Diagnostic[] } | undefined;
  if (hit) return hit;

  const dir = mkdtempSync(join(tmpdir(), "proto-mapper-"));
  const out = join(dir, "set.binpb");
  let stderr = "";
  try {
    execFileSync(
      "protoc",
      [...includeDirs.map((path) => `-I${path}`), `--descriptor_set_out=${out}`, "--include_imports", "--include_source_info", fileName],
      { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (error) {
    const failure = error as { stderr?: string; code?: string; message?: string };
    if (failure.code === "ENOENT") {
      return {
        text: fallbackModule(content),
        mappings: [],
        diagnostics: [{ messageText: "protoc is not on PATH, so proto-mapper cannot read this file. Install protobuf (protoc) and reopen the project.", start: 0, length: 1, code: 1 }],
      };
    }
    stderr = failure.stderr ?? failure.message ?? String(error);
    const result = { text: fallbackModule(content), mappings: [], diagnostics: diagnosticsFrom(stderr, fileName, content) };
    cache.set(key, result);
    return result;
  }

  const set = decodeFileDescriptorSet(readFileSync(out));
  // protoc names the file by its path under the first include directory that contains it.
  let name = basename(fileName);
  for (const includeDir of includeDirs) {
    const candidate = fileName.slice(includeDir.length).replace(/^[\\/]/, "").split("\\").join("/");
    if (set.has(candidate)) {
      name = candidate;
      break;
    }
  }
  const file = set.get(name);
  if (!file) {
    const result = {
      text: fallbackModule(content),
      mappings: [],
      diagnostics: [{ messageText: `protoc did not return a descriptor for ${name}.`, start: 0, length: 1, code: 4 }],
    };
    cache.set(key, result);
    return result;
  }
  const rendered = renderFile(file, set, content);
  cache.set(key, rendered);
  return rendered;
}

/** A module that keeps `import q from "./x.proto"` compiling, with the reason attached. */
function fallbackModule(content: string): string {
  return `// proto-mapper could not read this file (${content.length} bytes).\nexport {};\n`;
}

serve({
  initialize(params) {
    const { protocolVersion } = (params ?? {}) as { protocolVersion?: number };
    return { protocolVersion: protocolVersion ?? 1, positionEncoding: "utf-8", diagnosticSource: "proto-mapper" };
  },
  openProject(params) {
    const p = params as { projectHandle: string; configFileName?: string; options?: Record<string, unknown> };
    const dir = p.configFileName ? dirname(p.configFileName) : process.cwd();
    const config = readConfig(dir);
    const includeDirs = [...new Set([dir, ...config.include])];
    projects.set(p.projectHandle, {
      dir,
      includeDirs,
      configFile: config.file,
      identity: createHash("sha1").update(JSON.stringify([dir, includeDirs, config.file ?? null, protocVersion(), p.options ?? null])).digest("hex"),
    });
    return {
      configIdentity: projects.get(p.projectHandle)!.identity,
      watchedFiles: config.file ? [config.file] : [],
      optionDiagnostics: Object.keys(p.options ?? {}).map((key) => ({
        path: [key],
        messageText: `proto-mapper reads its include paths from proto.config.json, not from the content mapper's options; move "${key}" there.`,
        code: 101,
      })),
    };
  },
  transform(params) {
    const p = params as { fileName: string; content: string; projectHandle: string };
    const project = projects.get(p.projectHandle);
    const includeDirs = [...new Set([dirname(p.fileName), ...(project?.includeDirs ?? [])])];
    const rendered = build(p.fileName, p.content, includeDirs);
    return { extension: ".ts", diagnostics: rendered.diagnostics, text: rendered.text, mappings: rendered.mappings };
  },
  closeProject(params) {
    projects.delete((params as { projectHandle: string }).projectHandle);
    return {};
  },
});
