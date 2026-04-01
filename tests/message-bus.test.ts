import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMessageBus } from "../app/src/ws/messageBus.js";

describe("message bus", () => {
  it("routes messages to typed handlers and wildcard handlers", () => {
    const bus = createMessageBus();
    const events = [];

    const offWild = bus.on("*", (msg, ctx) => {
      events.push({ kind: "wild", type: msg.type, ctx });
    });

    const offType = bus.on("service:log", (msg) => {
      events.push({ kind: "typed", chunk: msg.chunk });
    });

    bus.dispatch({ type: "service:log", id: "api", chunk: "hello" }, { source: "unit" });
    assert.deepEqual(events, [
      { kind: "wild", type: "service:log", ctx: { source: "unit" } },
      { kind: "typed", chunk: "hello" },
    ]);

    offType();
    offWild();

    bus.dispatch({ type: "service:log", id: "api", chunk: "again" }, { source: "unit" });
    assert.deepEqual(events, [
      { kind: "wild", type: "service:log", ctx: { source: "unit" } },
      { kind: "typed", chunk: "hello" },
    ]);
  });
});
