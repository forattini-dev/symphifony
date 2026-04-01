import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { WS_MESSAGE_TYPES, WS_COMMAND_TYPES } from "../app/src/ws/contracts.js";

const originalLocation = globalThis.location;
const originalWebSocket = (globalThis as any).WebSocket;

type FakeWebSocketEvent = { type?: string };

type MockSocket = {
  url: string;
  readyState: number;
  sent: string[];
  onopen: ((event: FakeWebSocketEvent) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close: () => void;
};

function createMockWebSocketEnvironment() {
  const sockets: MockSocket[] = [];

  class MockWebSocket {
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    static OPEN = 1;

    url: string;
    readyState = MockWebSocket.CONNECTING;
    sent: string[] = [];
    onopen: ((event: FakeWebSocketEvent) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      if (this.onclose) this.onclose();
    }

    emitOpen(): void {
      this.readyState = MockWebSocket.OPEN;
      if (this.onopen) this.onopen({});
    }

    emitMessage(data: string): void {
      if (this.onmessage) this.onmessage({ data });
    }
  }

  (globalThis as any).WebSocket = MockWebSocket as unknown as typeof WebSocket;
  (globalThis as any).location = { protocol: "http:", host: "localhost:4000" };

  return { sockets };
}

describe("runtime socket contract", () => {
  let rt: typeof import("../app/src/ws/runtimeSocket.js");
  let sockets: MockSocket[] = [];
  let stopSocket: (() => void) | null = null;

  beforeEach(async () => {
    ({ sockets } = createMockWebSocketEnvironment());
    rt = await import("../app/src/ws/runtimeSocket.js");
    rt.resetRuntimeSocketTelemetry();
    rt.clearRuntimeSocketState();
    stopSocket = null;
  });

  afterEach(() => {
    stopSocket?.();
    (globalThis as any).location = originalLocation;
    (globalThis as any).WebSocket = originalWebSocket;
  });

  it("counts outbound/inbound messages and pong correlation", () => {
    stopSocket = rt.startRuntimeSocket();

    assert.equal(sockets.length, 1);
    sockets[0].emitOpen();
    assert.equal(rt.getRuntimeSocketTelemetry().status, "connected");

    rt.sendWsPayload({ type: WS_COMMAND_TYPES.PING, seq: 33, ts: 12345 });
    assert.equal(rt.getRuntimeSocketTelemetry().totalSent, 1);
    assert.equal(rt.getRuntimeSocketTelemetry().outboundMessageCounts.ping, 1);

    const pingPayload = JSON.parse(sockets[0].sent[0]);
    assert.equal(pingPayload.type, WS_COMMAND_TYPES.PING);
    assert.equal(pingPayload.seq, 33);

    sockets[0].emitMessage(JSON.stringify({
      type: WS_MESSAGE_TYPES.PONG,
      seq: 33,
      clientTs: 12345,
    }));

    const telemetry = rt.getRuntimeSocketTelemetry();
    assert.equal(telemetry.totalReceived, 1);
    assert.equal(telemetry.pongsReceived, 1);
    assert.ok(typeof telemetry.lastPingRttMs === "number");
  });

  it("reconnects with active consumers and replays subscriptions", async () => {
    rt.subscribeMesh();
    rt.subscribeAnalyticsTopic("analytics:kpis");
    stopSocket = rt.startRuntimeSocket();

    const first = sockets[0];
    first.emitOpen();

    const firstConnected = rt.getRuntimeSocketTelemetry();
    assert.equal(firstConnected.connectAttempts, 1);
    assert.equal(firstConnected.outboundMessageCounts["mesh:subscribe"], 1);
    assert.equal(firstConnected.outboundMessageCounts["analytics:subscribe"], 1);

    rt.__setRuntimeSocketStateForTest(250);
    first.close();

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(sockets.length >= 2);

    const second = sockets[sockets.length - 1];
    second.emitOpen();

    const telemetry = rt.getRuntimeSocketTelemetry();
    assert.equal(telemetry.reconnects, 1);
    assert.equal(telemetry.outboundMessageCounts["mesh:subscribe"], 2);
    assert.equal(telemetry.outboundMessageCounts["analytics:subscribe"], 2);
  });
});
