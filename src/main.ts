// One process, both halves: a typed gRPC server and a typed client, over a .proto imported
// directly. Nothing here was generated; the types come from proto/greeter.proto through the
// content mapper, and the values from the same file through proto-mapper/register.

import { credentials, Server, ServerCredentials } from "@grpc/grpc-js";
import {
  Greeter,
  GreeterDefinition,
  type GreeterHandlers,
  type HelloRequest,
} from "../proto/greeter.proto";

const address = "127.0.0.1:50051";

const server = new Server();

const request: HelloRequest = {
  name: "Ada",
  labels: { source: "demo" },
  tags: ["greeting"],
  sentAtUnix: 1_700_000_000n,
  from: { value: "user-1" },
  preferredContact: "CONTACT_PREFERENCE_EMAIL",
  signature: new Uint8Array([1, 2, 3]),
  // contact is a discriminated union: { case, value }.
  contact: { case: "email", value: "ada@example.com" },
};


// GreeterHandlers is checked against greeter.proto: a misspelled rpc, a wrong request field or a
// reply that is missing a field is a type error here.
const handlers: GreeterHandlers = {
  sayHello(call, callback) {
    if (!call.request.name) {
      callback({ code: 3, message: "name is required" });
      return;
    }
    callback(null, {
      message: `hello ${call.request.name}`,
      serverTime: 1_700_000_000n,
    });
  },
  sayHelloStream(call) {
    for (const suffix of ["one", "two", "three"]) {
      call.write({ message: `hello ${call.request.name} (${suffix})`, serverTime: 1_700_000_000n });
    }
    call.end();
  },
};

server.addService(GreeterDefinition, handlers);

await new Promise<void>((resolve, reject) => {
  server.bindAsync(address, ServerCredentials.createInsecure(), (error) =>
    error ? reject(error) : resolve(),
  );
});

const client = new Greeter(address, credentials.createInsecure());

const reply = await client.sayHello(request);

console.log("unary:", reply);

for await (const message of client.sayHelloStream(request)) {
  console.log("stream:", message);
}

client.close();
server.forceShutdown();
