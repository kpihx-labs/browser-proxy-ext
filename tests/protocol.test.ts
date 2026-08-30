import { expect, test } from "bun:test";
import { parseServerMessage, serializeClientMessage } from "../src/protocol";

test("parseServerMessage rejects malformed frames", () => {
  expect(parseServerMessage("")).toBeNull();
  expect(parseServerMessage("[]")).toBeNull();
  expect(parseServerMessage("{}")).toBeNull();
  expect(parseServerMessage('{"type":1}')).toBeNull();
  expect(parseServerMessage('{"type":"unknown"}')).toBeNull();
});

test("parseServerMessage accepts valid frames", () => {
  expect(parseServerMessage('{"type":"handshake","status":"accepted","protocol":1}')).toEqual({ type: "handshake", status: "accepted", protocol: 1 });
  expect(parseServerMessage('{"type":"request","id":"r-1","kind":"test","payload":{}}')).toEqual({
    type: "request",
    id: "r-1",
    kind: "test",
    payload: {},
  });
});

test("serializeClientMessage formats correctly", () => {
  expect(
    serializeClientMessage({ type: "handshake", token: "secret", extension_id: "ext1", profile: "default" })
  ).toEqual('{"type":"handshake","token":"secret","extension_id":"ext1","profile":"default"}');
  expect(serializeClientMessage({ type: "response", id: "r-1", ok: false, data: {} })).toEqual(
    '{"type":"response","id":"r-1","ok":false,"data":{}}'
  );
});
