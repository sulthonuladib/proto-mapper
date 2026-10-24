// The run-time half of proto-mapper: what a `.proto` import answers in a running program.
//
// The mapper decides the *types*; this decides the *values*, from the same .proto. @grpc/proto-loader
// reads the file with protobufjs, so there is no generated code at run time either.
//
// protobufjs's own shapes are not the ones the mapper declares, so this normalizes them:
//  - int64/fixed64/sfixed64 → bigint (protobufjs gives a Long or a number, by its `longs` option)
//  - enum values → their names           (`enums: String`)
//  - oneof → `{ case, value }`           (protobufjs gives a virtual property holding a field name)
// and goes the other way for requests.

import { readFileSync } from "node:fs";
import { loadPackageDefinition } from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { PackageDefinition, ProtobufTypeDefinition, ServiceDefinition } from "@grpc/proto-loader";
import { decodeFileDescriptor, type FileDescriptor, type MessageDescriptor } from "./descriptor.ts";

type Oneof = { name: string; fields: string[] };

// protobufjs's IConversionOptions, which its public types do not export.
const TO_OBJECT = { longs: BigInt, enums: String, oneofs: true, defaults: true } as unknown as object;

/**
 * proto-loader hands back `serialize`/`deserialize` bound to the protobufjs Type, but not the Type
 * itself. Its `type` field is the *descriptor*, not the type, so a decoded message is turned into a
 * plain object through the `$type` protobufjs puts on every message it constructs.
 */
type Described = ProtobufTypeDefinition & {
  serialize(value: object): Uint8Array;
  deserialize(bytes: Uint8Array): Record<string, unknown>;
  type?: { values?: Record<string, number> };
};

const described = (definition: ProtobufTypeDefinition): Described => definition as Described;

/** `acme.greeter.v1.HelloRequest` for a message type, from the descriptor proto-loader keeps. */
function fullNameOf(definition: ProtobufTypeDefinition): string | undefined {
  const descriptor = (definition as unknown as { type?: { name?: string } }).type;
  return descriptor?.name?.replace(/^\./, "");
}

const isTypeDefinition = (value: unknown): value is ProtobufTypeDefinition =>
  typeof value === "object" && value !== null && "format" in value;

const isEnum = (definition: ProtobufTypeDefinition): boolean => definition.format.includes("Enum");

/** The oneofs of every message in the set, by fully qualified name, with the names run time uses. */
function oneofsOf(files: Map<string, FileDescriptor>): Map<string, Oneof[]> {
  const table = new Map<string, Oneof[]>();
  const walk = (message: MessageDescriptor, full: string): void => {
    const oneofs: Oneof[] = message.oneofs.map((name, index) => ({
      name: lowerFirst(name),
      fields: message.fields.filter((field) => field.oneofIndex === index && !field.proto3Optional).map((field) => field.jsonName ?? field.name),
    }));
    const real = oneofs.filter((oneof) => oneof.fields.length > 0);
    if (real.length) table.set(full, real);
    for (const nested of message.nested) walk(nested, `${full}.${nested.name}`);
  };
  for (const file of files.values()) {
    const prefix = file.package ? `${file.package}.` : "";
    for (const message of file.messages) walk(message, `${prefix}${message.name}`);
  }
  return table;
}

/** `{ contact: { case: "email", value } }` -> `{ email: value }`, the shape protobufjs reads. */
function denormalize(message: Record<string, unknown>, oneofs: Oneof[] | undefined): Record<string, unknown> {
  if (!oneofs) return message;
  const out = { ...message };
  for (const oneof of oneofs) {
    const current = out[oneof.name];
    delete out[oneof.name];
    if (current && typeof current === "object" && "case" in current) {
      const tagged = current as { case: string; value: unknown };
      out[tagged.case] = tagged.value;
    }
  }
  return out;
}

/** The reverse: protobufjs's virtual oneof property and its fields -> one tagged union. */
function normalize(message: Record<string, unknown>, oneofs: Oneof[] | undefined): Record<string, unknown> {
  // protobufjs adds `_locale: undefined` for a `proto3 optional` field's synthetic oneof.
  for (const key of Object.keys(message)) if (key.startsWith("_") && message[key] === undefined) delete message[key];
  if (!oneofs) return message;
  for (const oneof of oneofs) {
    const which = message[oneof.name];
    for (const field of oneof.fields) delete message[field];
    message[oneof.name] = typeof which === "string" ? { case: which, value: message[which] } : undefined;
  }
  return message;
}

/** A message's codec: what `export const User` is at run time. */
function codec(definition: ProtobufTypeDefinition, oneofs: Oneof[] | undefined) {
  const type = described(definition);
  return {
    encode(message: object): Uint8Array {
      return Buffer.from(type.serialize(denormalize(message as Record<string, unknown>, oneofs)));
    },
    decode(bytes: Uint8Array): Record<string, unknown> {
      return normalize(toPlain(type, bytes), oneofs);
    },
  };
}

/** Bytes as the plain object the generated interface describes (proto-loader does the conversion). */
function toPlain(type: Described, bytes: Uint8Array): Record<string, unknown> {
  return type.deserialize(bytes);
}

/** An enum: `{ ACTIVE: "ACTIVE" }`, the names run time hands back. */
function enumValues(definition: ProtobufTypeDefinition): Record<string, string> {
  const values = described(definition).type?.values ?? {};
  return Object.fromEntries(Object.keys(values).map((name) => [name, name]));
}

/** A service's methods, with both directions normalized at the wire boundary. */
function wrapService(service: ServiceDefinition, oneofs: Map<string, Oneof[]>): ServiceDefinition {
  const out: Record<string, unknown> = {};
  for (const [name, method] of Object.entries(service)) {
    const request = described(method.requestType);
    const response = described(method.responseType);
    // A MessageTypeDefinition names its type in `type` (the descriptor), so the oneof table is
    // looked up from the full name protobufjs records on the descriptor's `name`.
    const requestMessage = fullNameOf(method.requestType);
    const responseMessage = fullNameOf(method.responseType);
    out[name] = {
      ...method,
      requestSerialize: (value: object) => Buffer.from(request.serialize(denormalize(value as Record<string, unknown>, oneofs.get(requestMessage ?? "")))),
      responseSerialize: (value: object) => Buffer.from(response.serialize(denormalize(value as Record<string, unknown>, oneofs.get(responseMessage ?? "")))),
      requestDeserialize: (bytes: Uint8Array) => normalize(toPlain(request, bytes), oneofs.get(requestMessage ?? "")),
      responseDeserialize: (bytes: Uint8Array) => normalize(toPlain(response, bytes), oneofs.get(responseMessage ?? "")),
    };
  }
  return out as unknown as ServiceDefinition;
}

const namespaces = new Map<string, Record<string, unknown>>();

const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

type ClientCtor = { new (address: string, credentials: unknown, options?: Record<string, unknown>): object; prototype: Record<string, unknown> };

/**
 * grpc-js only has a callback API. A unary call made without one becomes a promise, which is what
 * the generated GreeterClient declares; a call that passes a callback keeps working as before.
 */
function promisify(ctor: ClientCtor, service: ServiceDefinition): void {
  for (const [name, method] of Object.entries(service)) {
    if (method.requestStream || method.responseStream) continue;
    // grpc-js keeps the proto's own method name and a camelCase alias; the mapper declares the latter.
    for (const key of new Set([name, lowerFirst(name)])) {
      const original = ctor.prototype[key];
      if (typeof original !== "function") continue;
      const call = original as (...args: unknown[]) => unknown;
      ctor.prototype[key] = function (this: object, ...args: unknown[]) {
        if (typeof args[args.length - 1] === "function") return call.apply(this, args);
        return new Promise((resolve, reject) => {
          call.apply(this, [...args, (error: unknown, response: unknown) => (error ? reject(error) : resolve(response))]);
        });
      };
    }
  }
}

const PACKAGE = /^\s*package\s+([A-Za-z0-9_.]+)\s*;/m;

function packageNameOf(source: string): string {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return PACKAGE.exec(stripped)?.[1] ?? "";
}

/** Every value a .proto module exports, keyed by the name the mapper gave it. */
export function loadNamespace(file: string, includeDirs: string[]): Record<string, unknown> {
  const cacheKey = `${file}\0${includeDirs.join("\0")}`;
  const cached = namespaces.get(cacheKey);
  if (cached) return cached;
  // The options matter as much as the types: they decide the shape `deserialize` hands back.
  const definition: PackageDefinition = protoLoader.loadSync(file, { includeDirs, keepCase: false, ...TO_OBJECT });

  // One descriptor set per file, cached by protobufjs in `fileDescriptorProtos`.
  const files = new Map<string, FileDescriptor>();
  for (const value of Object.values(definition)) {
    if (!isTypeDefinition(value)) continue;
    for (const buffer of value.fileDescriptorProtos) {
      const descriptor = decodeFileDescriptor(new Uint8Array(buffer));
      files.set(descriptor.name, descriptor);
    }
  }
  const oneofs = oneofsOf(files);

  const wrapped: PackageDefinition = {};
  for (const [key, value] of Object.entries(definition)) {
    wrapped[key] = isTypeDefinition(value) ? value : wrapService(value as ServiceDefinition, oneofs);
  }

  const root = loadPackageDefinition(wrapped) as Record<string, unknown>;
  const byPath = (path: string): unknown => path.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], root);

  const pkg = packageNameOf(readFileSync(file, "utf8"));
  const prefix = pkg ? `${pkg}.` : "";
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wrapped)) {
    // A dependency's types belong to that dependency's own module, not this one.
    if (pkg && !key.startsWith(prefix)) continue;
    const path = (key.startsWith(prefix) ? key.slice(prefix.length) : key).split(".");
    const local = path.join("_");
    if (!local) continue;
    if (isTypeDefinition(value)) {
      out[local] = isEnum(value) ? enumValues(value) : codec(value, oneofs.get(key));
      continue;
    }
    const service = value as ServiceDefinition;
    const ctor = byPath(key) as ClientCtor | undefined;
    if (typeof ctor === "function") {
      promisify(ctor, service);
      out[local] = ctor;
      out[`${local}Definition`] = service;
    }
  }
  namespaces.set(cacheKey, out);
  return out;
}
