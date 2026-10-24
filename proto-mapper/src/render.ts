// Renders one .proto file's descriptors as a virtual TypeScript module: an interface per message,
// a string-literal union per enum, and a typed client + typed server handlers per service, with a
// `const` for each so the module is usable at run time too (the register hook fills those in).
//
// Every declaration also becomes a span mapping back to the .proto, so hovering or go-to-definition
// in TypeScript lands on the field, enum value or rpc that produced it.

import type {
  DescriptorSet,
  EnumDescriptor,
  FieldDescriptor,
  FileDescriptor,
  MessageDescriptor,
  ServiceDescriptor,
  SourceLocation,
} from "./descriptor.ts";

export type Diagnostic = { messageText: string; start: number; length: number; code: number };

type Span = readonly [start: number, length: number];
type Chunk = { text: string; src?: Span };

/** Scalar field types: FieldDescriptorProto.Type -> the TypeScript a driver actually hands back. */
const SCALARS: Record<number, string> = {
  1: "number", // double
  2: "number", // float
  3: "bigint", // int64
  4: "bigint", // uint64
  5: "number", // int32
  6: "bigint", // fixed64
  7: "number", // fixed32
  8: "boolean", // bool
  9: "string", // string
  13: "number", // uint32
  12: "Uint8Array", // bytes
  15: "number", // sfixed32
  16: "bigint", // sfixed64
  17: "number", // sint32
  18: "bigint", // sint64
};

/**
 * Well-known types are declared inline rather than imported: their .proto lives in protoc's own
 * include directory, which is not a path TypeScript can resolve from the importing file. The shapes
 * are the ones @grpc/proto-loader returns.
 */
const WELL_KNOWN: Record<string, { type: string; decl?: string }> = {
  ".google.protobuf.Timestamp": { type: "Timestamp", decl: "type Timestamp = { seconds: bigint; nanos: number };" },
  ".google.protobuf.Duration": { type: "Duration", decl: "type Duration = { seconds: bigint; nanos: number };" },
  ".google.protobuf.Empty": { type: "Empty", decl: "type Empty = Record<string, never>;" },
  ".google.protobuf.Any": { type: "AnyMessage", decl: "type AnyMessage = { typeUrl: string; value: Uint8Array };" },
  ".google.protobuf.FieldMask": { type: "FieldMask", decl: "type FieldMask = { paths: string[] };" },
  ".google.protobuf.Struct": { type: "ProtobufStruct", decl: "type ProtobufStruct = Record<string, unknown>;" },
  ".google.protobuf.Value": { type: "unknown" },
  ".google.protobuf.ListValue": { type: "unknown[]" },
  ".google.protobuf.NullValue": { type: "null" },
  ".google.protobuf.DoubleValue": { type: "number" },
  ".google.protobuf.FloatValue": { type: "number" },
  ".google.protobuf.Int64Value": { type: "bigint" },
  ".google.protobuf.UInt64Value": { type: "bigint" },
  ".google.protobuf.Int32Value": { type: "number" },
  ".google.protobuf.UInt32Value": { type: "number" },
  ".google.protobuf.BoolValue": { type: "boolean" },
  ".google.protobuf.StringValue": { type: "string" },
  ".google.protobuf.BytesValue": { type: "Uint8Array" },
};

type Symbol = { local: string; file: string };

type Context = {
  file: FileDescriptor;
  set: DescriptorSet;
  symbols: Map<string, Symbol>;
  locations: Map<string, SourceLocation>;
  lineStarts: number[];
  body: Chunk[];
  prelude: Set<string>;
  /** Sibling .proto imports: module specifier -> the names taken from it. */
  protoImports: Map<string, Set<string>>;
  needs: Set<string>;
};

const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

/** The property a oneof's tagged union lives under: the oneof's own name, camelCased. */
function oneofName(message: MessageDescriptor, field: FieldDescriptor): string {
  const declared = message.oneofs[field.oneofIndex ?? 0] ?? field.name;
  return declared.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** A JSDoc block for a proto comment, so an editor hover shows what the .proto says. */
function jsdoc(comment: string | undefined, indent = ""): string {
  const lines = (comment ?? "").replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const width = lines.reduce((n, line) => (line.trim() ? Math.max(n, line.length - line.trimStart().length) : n), 0);
  const body = lines.map((line) => line.slice(Math.min(width, line.length - line.trimStart().length)));
  if (!body.length) return "";
  if (body.length === 1) return `${indent}/** ${body[0]!.trim().replaceAll("*/", "*\\/")} */\n`;
  const text = body.map((line) => `${indent} * ${line.trimEnd()}`.trimEnd()).join("\n");
  return `${indent}/**\n${text}\n${indent} */\n`;
}

/** Every message, enum and service in the set, by fully qualified name, with the name it gets in its own module. */
function collectSymbols(set: DescriptorSet): Map<string, Symbol> {
  const symbols = new Map<string, Symbol>();
  const walk = (message: MessageDescriptor, parentFull: string, local: string, file: string): void => {
    const full = `${parentFull}.${message.name}`;
    symbols.set(full, { local, file });
    for (const nested of message.nested) walk(nested, full, `${local}_${nested.name}`, file);
    for (const descriptor of message.enums) symbols.set(`${full}.${descriptor.name}`, { local: `${local}_${descriptor.name}`, file });
  };
  for (const file of set.values()) {
    const prefix = file.package ? `.${file.package}` : "";
    for (const message of file.messages) walk(message, prefix, message.name, file.name);
    for (const descriptor of file.enums) symbols.set(`${prefix}.${descriptor.name}`, { local: descriptor.name, file: file.name });
    for (const service of file.services) symbols.set(`${prefix}.${service.name}`, { local: service.name, file: file.name });
  }
  return symbols;
}

/** The `path` SourceCodeInfo uses for a declaration, as a map key. */
const pathKey = (path: readonly number[]): string => path.join(".");

/** Every message in the set by fully qualified name, nested ones included, for map detection. */
function collectMessages(set: DescriptorSet): Map<string, MessageDescriptor> {
  const messages = new Map<string, MessageDescriptor>();
  const walk = (message: MessageDescriptor, parentFull: string): void => {
    const full = `${parentFull}.${message.name}`;
    messages.set(full, message);
    for (const nested of message.nested) walk(nested, full);
  };
  for (const file of set.values()) {
    const prefix = file.package ? `.${file.package}` : "";
    for (const message of file.messages) walk(message, prefix);
  }
  return messages;
}

export function renderFile(
  file: FileDescriptor,
  set: DescriptorSet,
  source: string,
): { text: string; mappings: number[][]; diagnostics: Diagnostic[] } {
  const lineStarts = lineStartsOf(source);
  const locations = new Map<string, SourceLocation>();
  for (const location of file.locations) locations.set(pathKey(location.path), location);

  const messages = collectMessages(set);
  const ctx: Context = {
    file,
    set,
    symbols: collectSymbols(set),
    locations,
    lineStarts,
    body: [],
    prelude: new Set(),
    protoImports: new Map(),
    needs: new Set(),
  };

  const proto3 = file.syntax !== undefined && file.syntax !== "proto2";

  const spanOf = (path: readonly number[]): Span | undefined => {
    const location = ctx.locations.get(pathKey(path));
    if (!location || location.span.length < 3) return undefined;
    const [line, start, endColumn] = location.span as [number, number, number];
    const endLine = location.span.length === 4 ? location.span[2]! : line;
    const lastColumn = location.span.length === 4 ? location.span[3]! : endColumn;
    const startByte = (ctx.lineStarts[line] ?? 0) + start;
    const endByte = (ctx.lineStarts[endLine] ?? 0) + lastColumn;
    return [startByte, Math.max(0, endByte - startByte)];
  };

  const leadingOf = (path: readonly number[]): string | undefined => ctx.locations.get(pathKey(path))?.leadingComments;

  const add = (text: string, span?: Span): void => {
    ctx.body.push(span ? { text, src: span } : { text });
  };

  /** The TypeScript name for a fully qualified proto type, importing it when another file defines it. */
  const ref = (typeName: string): string => {
    const known = WELL_KNOWN[typeName];
    if (known) {
      if (known.decl) ctx.prelude.add(known.decl);
      return known.type;
    }
    const symbol = ctx.symbols.get(typeName);
    if (!symbol) return "unknown";
    if (symbol.file === file.name) return symbol.local;
    // A dependency outside this project (protoc's own include directory) is left opaque.
    if (symbol.file.startsWith("google/protobuf/")) return "unknown";
    const specifier = relativeSpecifier(file.name, symbol.file);
    const names = ctx.protoImports.get(specifier) ?? new Set<string>();
    names.add(symbol.local);
    ctx.protoImports.set(specifier, names);
    return symbol.local;
  };

  const fieldType = (field: FieldDescriptor): string => {
    if (field.type === 11 || field.type === 14) {
      const target = field.typeName ? messages.get(field.typeName) : undefined;
      if (field.type === 11 && target?.mapEntry && target.fields.length >= 2) {
        const key = SCALARS[target.fields[0]!.type] ?? "string";
        const value = fieldType(target.fields[1]!);
        return `Record<${key}, ${value}>`;
      }
      return ref(field.typeName!);
    }
    return SCALARS[field.type] ?? "unknown";
  };

  const enumType = (descriptor: EnumDescriptor, path: readonly number[], local: string): void => {
    const span = spanOf(path);
    ctx.needs.add("enum");
    add(jsdoc(leadingOf(path)), span);
    add(`export type ${local} = `, span);
    descriptor.values.forEach((value, index) => {
      if (index > 0) add(" | ");
      add(JSON.stringify(value.name), spanOf([...path, 2, index]));
    });
    add(";\n");
    // proto-loader's `enums: String` hands back the name for each value, hence name -> name.
    add(`export declare const ${local}: {`, span);
    for (const value of descriptor.values) add(` readonly ${value.name}: ${JSON.stringify(value.name)};`);
    add(" };\n\n");
  };

  const messageType = (message: MessageDescriptor, path: readonly number[], local: string): void => {
    const span = spanOf(path);
    ctx.needs.add("codec");
    add(jsdoc(leadingOf(path)), span);
    add(`export interface ${local} `, span);
    if (!message.fields.length) {
      add("{}\n");
    } else {
      add("{\n");
      const oneofs = new Map<number, { field: FieldDescriptor; index: number; path: readonly number[] }[]>();
      const rendered = new Set<number>();
      message.fields.forEach((field, index) => {
        if (field.oneofIndex !== undefined && !field.proto3Optional) {
          const group = oneofs.get(field.oneofIndex) ?? [];
          group.push({ field, index, path: [...path, 2, index] });
          oneofs.set(field.oneofIndex, group);
        }
      });
      message.fields.forEach((field, index) => {
        const fieldPath = [...path, 2, index];
        const fieldSpan = spanOf(fieldPath);
        if (field.oneofIndex !== undefined && !field.proto3Optional) {
          // A oneof is rendered once, at the position of its first member, as a tagged union.
          const group = oneofs.get(field.oneofIndex)!;
          if (group[0]!.index !== index || rendered.has(field.oneofIndex)) return;
          rendered.add(field.oneofIndex);
          add(jsdoc(leadingOf(fieldPath)), fieldSpan);
          add(`  ${oneofName(message, field)}?:`, fieldSpan);
          group.forEach((member, memberIndex) => {
            if (memberIndex > 0) add("\n    |");
            add(` { case: ${JSON.stringify(member.field.jsonName ?? member.field.name)}; value: ${fieldType(member.field)} }`, spanOf(member.path));
          });
          add(";\n");
          return;
        }
        const optional = proto3 ? field.proto3Optional : field.label === 1;
        const isMap = field.type === 11 && (field.typeName ? messages.get(field.typeName)?.mapEntry === true : false);
        const repeated = field.label === 3 && !isMap;
        add(jsdoc(leadingOf(fieldPath), "  "), fieldSpan);
        add(`  ${field.jsonName ?? field.name}${optional ? "?" : ""}: ${fieldType(field)}${repeated ? "[]" : ""};`, fieldSpan);
        add(` // = ${field.number}\n`);
      });
      add("}\n");
    }
    add(`export declare const ${local}: MessageCodec<${local}>;\n\n`);
    for (const nested of message.nested) {
      if (nested.mapEntry) continue;
      messageType(nested, [...path, 3, message.nested.indexOf(nested)], `${local}_${nested.name}`);
    }
    for (const descriptor of message.enums) {
      enumType(descriptor, [...path, 4, message.enums.indexOf(descriptor)], `${local}_${descriptor.name}`);
    }
  };

  const serviceType = (service: ServiceDescriptor, path: readonly number[], local: string): void => {
    const span = spanOf(path);
    ctx.needs.add("service");
    add(jsdoc(leadingOf(path)), span);
    add(`export interface ${local}Client {\n  close(): void;\n`, span);
    service.methods.forEach((method, index) => {
      const methodPath = [...path, 2, index];
      add(jsdoc(leadingOf(methodPath), "  "), spanOf(methodPath));
      const name = lowerFirst(method.name);
      const input = ref(method.inputType);
      ctx.needs.add("callOptions");
      if (method.clientStreaming) ctx.needs.add("clientStream");
      if (method.serverStreaming) ctx.needs.add("serverStream");
      const argument = method.clientStreaming ? `stream: AsyncIterable<${input}>` : `request: ${input}`;
      const result = method.serverStreaming ? `AsyncIterable<${ref(method.outputType)}>` : `Promise<${ref(method.outputType)}>`;
      add(`  ${name}(${argument}, options?: CallOptions): ${result};\n`, spanOf(methodPath));
    });
    add("}\n");
    add(`export declare const ${local}: ServiceClientCtor<${local}Client>;\n`);
    add(`export declare const ${local}Definition: ServiceDefinition;\n\n`);

    ctx.needs.add("handlers");
    add(`export interface ${local}Handlers extends UntypedServiceImplementation {\n`, span);
    service.methods.forEach((method, index) => {
      const methodPath = [...path, 2, index];
      const name = lowerFirst(method.name);
      const input = ref(method.inputType);
      const output = ref(method.outputType);
      add(jsdoc(leadingOf(methodPath), "  "), spanOf(methodPath));
      const call = method.clientStreaming
        ? method.serverStreaming
          ? `call: ServerDuplexStream<${input}, ${output}>`
          : `call: ServerReadableStream<${input}, ${output}>`
        : method.serverStreaming
          ? `call: ServerWritableStream<${input}, ${output}>`
          : `call: ServerUnaryCall<${input}, ${output}>`;
      const callback = method.clientStreaming && !method.serverStreaming ? `, callback: sendUnaryData<${output}>` : method.serverStreaming ? "" : `, callback: sendUnaryData<${output}>`;
      add(`  ${name}(${call}${callback}): void;\n`, spanOf(methodPath));
    });
    add("}\n\n");
  };

  // Declarations in the order they appear in the file, so the module reads like the proto.
  const orderOf = (path: readonly number[]): number => spanOf(path)?.[0] ?? Number.MAX_SAFE_INTEGER;
  const declarations: { at: number; render: () => void }[] = [
    ...file.messages.map((message, index) => ({ at: orderOf([4, index]), render: () => messageType(message, [4, index], message.name) })),
    ...file.enums.map((descriptor, index) => ({ at: orderOf([5, index]), render: () => enumType(descriptor, [5, index], descriptor.name) })),
    ...file.services.map((service, index) => ({ at: orderOf([6, index]), render: () => serviceType(service, [6, index], service.name) })),
  ].sort((a, b) => a.at - b.at);
  for (const declaration of declarations) declaration.render();

  const imports: string[] = [];
  const fromMapper: string[] = [];
  if (ctx.needs.has("codec")) fromMapper.push("MessageCodec");
  if (ctx.needs.has("service")) fromMapper.push("ServiceClientCtor");
  if (fromMapper.length) imports.push(`import type { ${fromMapper.join(", ")} } from "proto-mapper";`);
  const grpc: string[] = [];
  if (ctx.needs.has("callOptions")) grpc.push("CallOptions");
  if (ctx.needs.has("service")) grpc.push("ServiceDefinition");
  if (ctx.needs.has("handlers")) grpc.push("UntypedServiceImplementation", "ServerUnaryCall", "sendUnaryData", "ServerWritableStream", "ServerReadableStream", "ServerDuplexStream");
  if (grpc.length) imports.push(`import type { ${grpc.join(", ")} } from "@grpc/grpc-js";`);
  for (const [specifier, names] of ctx.protoImports) {
    imports.push(`import type { ${[...names].sort().join(", ")} } from ${JSON.stringify(specifier)};`);
  }

  const header = [
    `// ${file.name}${file.package ? ` — package ${file.package}` : ""}`,
    `// Generated by proto-mapper from the .proto file. Not written to disk, not meant to be edited.`,
    ...(imports.length ? ["", ...imports] : []),
    ...(ctx.prelude.size ? ["", ...[...ctx.prelude].sort()] : []),
    "",
    "",
  ].join("\n");

  let offset = Buffer.byteLength(header);
  const mappings: number[][] = [];
  const ATOM = 1;
  const FEATURES = 1 | 8 | 16; // hover | definition | type definition
  for (const chunk of ctx.body) {
    const length = Buffer.byteLength(chunk.text);
    if (chunk.src && chunk.text.trim()) mappings.push([offset, length, chunk.src[0], chunk.src[1], ATOM, FEATURES]);
    offset += length;
  }

  return { text: header + ctx.body.map((chunk) => chunk.text).join(""), mappings, diagnostics: [] };
}

/** The import specifier for a sibling .proto, relative to the file doing the importing. */
function relativeSpecifier(from: string, to: string): string {
  const fromParts = from.split("/").slice(0, -1);
  const toParts = to.split("/");
  const name = toParts.pop()!;
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++;
  const up = fromParts.length - common;
  const prefix = up === 0 ? "./" : "../".repeat(up);
  return `${prefix}${[...toParts.slice(common), name].join("/")}`;
}
