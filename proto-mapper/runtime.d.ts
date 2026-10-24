// Types a generated .proto module imports. Kept in a .d.ts so it costs the program nothing.

/** A message's wire codec, the value each `export declare const User: MessageCodec<User>` names. */
export interface MessageCodec<T> {
  /** The plain object a message field is, as bytes. */
  encode(message: T): Uint8Array;
  /** Bytes as the plain object the generated interface describes. */
  decode(bytes: Uint8Array): T;
}

/** A service's client constructor, as `export declare const Greeter` declares it. */
export interface ServiceClientCtor<Client> {
  new (address: string, credentials: unknown, options?: Record<string, unknown>): Client;
}
