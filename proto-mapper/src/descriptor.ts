// A minimal decoder for google.protobuf.FileDescriptorSet, the binary `protoc
// --descriptor_set_out --include_source_info` writes. Only the fields the renderer reads are
// decoded; anything else is skipped. Hand-rolled so the mapper has no dependency of its own:
// protoc is the parser, and this is just a view of its answer.
//
// Field numbers and the Type enum come from descriptor.proto.

export type SourceLocation = {
  path: number[];
  /** [startLine, startCol, endLine, endCol], or [line, startCol, endCol] on one line. 0-based. */
  span: number[];
  leadingComments?: string;
  trailingComments?: string;
};

export type FieldDescriptor = {
  name: string;
  number: number;
  /** 1 optional, 2 required, 3 repeated. */
  label: number;
  /** FieldDescriptorProto.Type: 1 double … 18 sint64. */
  type: number;
  typeName?: string;
  oneofIndex?: number;
  jsonName?: string;
  proto3Optional: boolean;
};

export type MessageDescriptor = {
  name: string;
  fields: FieldDescriptor[];
  nested: MessageDescriptor[];
  enums: EnumDescriptor[];
  oneofs: string[];
  mapEntry: boolean;
};

export type EnumDescriptor = { name: string; values: { name: string; number: number }[] };

export type MethodDescriptor = {
  name: string;
  inputType: string;
  outputType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
};

export type ServiceDescriptor = { name: string; methods: MethodDescriptor[] };

export type FileDescriptor = {
  name: string;
  package: string;
  dependencies: string[];
  messages: MessageDescriptor[];
  enums: EnumDescriptor[];
  services: ServiceDescriptor[];
  locations: SourceLocation[];
  /** "proto2", "proto3", or undefined for a file that predates the syntax statement. */
  syntax?: string;
};

/** Every file in the set, by the name protoc gave it (relative to the include path). */
export type DescriptorSet = Map<string, FileDescriptor>;

const text = new TextDecoder();

class Reader {
  private readonly buf: Uint8Array;
  private pos = 0;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  get eof(): boolean {
    return this.pos >= this.buf.length;
  }
  byte(): number {
    return this.buf[this.pos++]!;
  }
  bytes(length: number): Uint8Array {
    const out = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }
  varintBig(): bigint {
    let value = 0n;
    let scale = 1n;
    for (;;) {
      const byte = this.byte();
      value += BigInt(byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return value;
      scale *= 128n;
    }
  }
  varint(): number {
    return Number(this.varintBig());
  }
  int32(): number {
    return Number(BigInt.asIntN(32, this.varintBig()));
  }
}

function readFields(buf: Uint8Array, onField: (field: number, wire: number, value: bigint | Uint8Array) => void): void {
  const reader = new Reader(buf);
  while (!reader.eof) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) onField(field, wire, reader.varintBig());
    else if (wire === 1) onField(field, wire, reader.bytes(8));
    else if (wire === 2) onField(field, wire, reader.bytes(reader.varint()));
    else if (wire === 5) onField(field, wire, reader.bytes(4));
    else throw new Error(`unsupported wire type ${wire} in the descriptor set`);
  }
}

const str = (value: bigint | Uint8Array): string => (typeof value === "bigint" ? "" : text.decode(value));
const bytes = (value: bigint | Uint8Array): Uint8Array => (typeof value === "bigint" ? new Uint8Array() : value);
const num = (value: bigint | Uint8Array): number => (typeof value === "bigint" ? Number(value) : 0);
const bool = (value: bigint | Uint8Array): boolean => (typeof value === "bigint" ? value !== 0n : false);

/** A packed or unpacked `repeated int32`. */
function ints(value: bigint | Uint8Array): number[] {
  if (typeof value === "bigint") return [Number(value)];
  const out: number[] = [];
  const reader = new Reader(value);
  while (!reader.eof) out.push(reader.varint());
  return out;
}

export function decodeFileDescriptorSet(buf: Uint8Array): DescriptorSet {
  const set: DescriptorSet = new Map();
  readFields(buf, (field, wire, value) => {
    if (field !== 1 || wire !== 2) return;
    const file = decodeFileDescriptor(bytes(value));
    if (file.name) set.set(file.name, file);
  });
  return set;
}

/** One google.protobuf.FileDescriptorProto, as the pieces `fileDescriptorProtos` carries. */
export function decodeFileDescriptor(buf: Uint8Array): FileDescriptor {
  const file: FileDescriptor = { name: "", package: "", dependencies: [], messages: [], enums: [], services: [], locations: [] };
  readFields(buf, (field, wire, value) => {
    switch (field) {
      case 1:
        if (wire === 2) file.name = str(value);
        break;
      case 2:
        if (wire === 2) file.package = str(value);
        break;
      case 3:
        if (wire === 2) file.dependencies.push(str(value));
        break;
      case 4:
        if (wire === 2) file.messages.push(decodeMessage(bytes(value)));
        break;
      case 5:
        if (wire === 2) file.enums.push(decodeEnum(bytes(value)));
        break;
      case 6:
        if (wire === 2) file.services.push(decodeService(bytes(value)));
        break;
      case 9:
        if (wire === 2) file.locations = decodeSourceInfo(bytes(value));
        break;
      case 12:
        if (wire === 2) file.syntax = str(value);
        break;
    }
  });
  return file;
}

function decodeMessage(buf: Uint8Array): MessageDescriptor {
  const message: MessageDescriptor = { name: "", fields: [], nested: [], enums: [], oneofs: [], mapEntry: false };
  readFields(buf, (field, wire, value) => {
    switch (field) {
      case 1:
        if (wire === 2) message.name = str(value);
        break;
      case 2:
        if (wire === 2) message.fields.push(decodeField(bytes(value)));
        break;
      case 3:
        if (wire === 2) message.nested.push(decodeMessage(bytes(value)));
        break;
      case 4:
        if (wire === 2) message.enums.push(decodeEnum(bytes(value)));
        break;
      case 7:
        if (wire !== 2) break;
        readFields(bytes(value), (f, w, v) => {
          if (f === 7 && w === 0) message.mapEntry = bool(v);
        });
        break;
      case 8:
        if (wire !== 2) break;
        readFields(bytes(value), (f, w, v) => {
          if (f === 1 && w === 2) message.oneofs.push(str(v));
        });
        break;
    }
  });
  return message;
}

function decodeField(buf: Uint8Array): FieldDescriptor {
  const field: FieldDescriptor = { name: "", number: 0, label: 1, type: 0, proto3Optional: false };
  readFields(buf, (f, wire, value) => {
    switch (f) {
      case 1:
        if (wire === 2) field.name = str(value);
        break;
      case 3:
        if (wire === 0) field.number = num(value);
        break;
      case 4:
        if (wire === 0) field.label = num(value);
        break;
      case 5:
        if (wire === 0) field.type = num(value);
        break;
      case 6:
        if (wire === 2) field.typeName = str(value);
        break;
      case 9:
        if (wire === 0) field.oneofIndex = num(value);
        break;
      case 10:
        if (wire === 2) field.jsonName = str(value);
        break;
      case 17:
        if (wire === 0) field.proto3Optional = bool(value);
        break;
    }
  });
  return field;
}

function decodeEnum(buf: Uint8Array): EnumDescriptor {
  const descriptor: EnumDescriptor = { name: "", values: [] };
  readFields(buf, (field, wire, value) => {
    if (field === 1 && wire === 2) descriptor.name = str(value);
    if (field === 2 && wire === 2) {
      const entry: { name: string; number: number } = { name: "", number: 0 };
      readFields(bytes(value), (f, w, v) => {
        if (f === 1 && w === 2) entry.name = str(v);
        if (f === 2 && w === 0) entry.number = typeof v === "bigint" ? Number(BigInt.asIntN(32, v)) : 0;
      });
      descriptor.values.push(entry);
    }
  });
  return descriptor;
}

function decodeService(buf: Uint8Array): ServiceDescriptor {
  const service: ServiceDescriptor = { name: "", methods: [] };
  readFields(buf, (field, wire, value) => {
    if (field === 1 && wire === 2) service.name = str(value);
    if (field === 2 && wire === 2) service.methods.push(decodeMethod(bytes(value)));
  });
  return service;
}

function decodeMethod(buf: Uint8Array): MethodDescriptor {
  const method: MethodDescriptor = { name: "", inputType: "", outputType: "", clientStreaming: false, serverStreaming: false };
  readFields(buf, (field, wire, value) => {
    switch (field) {
      case 1:
        if (wire === 2) method.name = str(value);
        break;
      case 2:
        if (wire === 2) method.inputType = str(value);
        break;
      case 3:
        if (wire === 2) method.outputType = str(value);
        break;
      case 5:
        if (wire === 0) method.clientStreaming = bool(value);
        break;
      case 6:
        if (wire === 0) method.serverStreaming = bool(value);
        break;
    }
  });
  return method;
}

function decodeSourceInfo(buf: Uint8Array): SourceLocation[] {
  const locations: SourceLocation[] = [];
  readFields(buf, (field, wire, value) => {
    if (field !== 1 || wire !== 2) return;
    const location: SourceLocation = { path: [], span: [] };
    readFields(bytes(value), (f, w, v) => {
      switch (f) {
        case 1:
          location.path = ints(v);
          break;
        case 2:
          location.span = ints(v);
          break;
        case 3:
          if (w === 2) location.leadingComments = str(v);
          break;
        case 4:
          if (w === 2) location.trailingComments = str(v);
          break;
      }
    });
    locations.push(location);
  });
  return locations;
}
