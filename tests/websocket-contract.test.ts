import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

describe("websocket contract", () => {
  let wsModule: typeof import("../src/routes/websocket.ts");

  beforeEach(async () => {
    wsModule = await import("../src/routes/websocket.ts");
    wsModule.resetWsTelemetry();
    wsModule.wsClients.clear();
    wsModule.setServicesSnapshotProvider(() => null);
    wsModule.makeWebSocketConfig({
      issues: [],
      events: [],
      milestones: [],
    } as unknown as Record<string, unknown>);
  });

  it("answers ping with pong carrying the same correlation identifiers", () => {
    const socketId = "sock-ping";
    const sent: string[] = [];
    wsModule.wsClients.set(socketId, (data) => sent.push(data));

    wsModule.handleWsClientMessage(socketId, JSON.stringify({
      type: "ping",
      seq: 7,
      clientTs: 1700000001,
    }), () => {
      // Not used by ping handler, provided for protocol parity.
    });

    const payload = JSON.parse(sent[0]);
    assert.equal(payload.type, "pong");
    assert.equal(payload.seq, 7);
    assert.equal(payload.clientTs, 1700000001);
    assert.equal(typeof payload.timestamp, "string");

    const telemetry = wsModule.getWsTelemetry();
    assert.equal(telemetry.inboundMessages, 1);
    assert.equal(telemetry.outboundMessages, 1);
    assert.equal(telemetry.inboundByType.ping, 1);
    assert.equal(telemetry.outboundByType.pong, 1);
  });

  it("manages room subscriptions via command contracts", () => {
    const socketId = "sock-room";
    wsModule.wsClients.set(socketId, () => {});

    wsModule.handleWsClientMessage(socketId, JSON.stringify({
      type: "mesh:subscribe",
    }), () => {
      // no-op
    });
    assert.equal(wsModule.meshRoomHasSubscribers(), true);

    wsModule.handleWsClientMessage(socketId, JSON.stringify({
      type: "mesh:unsubscribe",
    }), () => {
      // no-op
    });
    assert.equal(wsModule.meshRoomHasSubscribers(), false);

    wsModule.handleWsClientMessage(socketId, JSON.stringify({
      type: "issue:log:subscribe",
      id: "issue-1",
    }), () => {
      // no-op
    });
    assert.equal(wsModule.issueLogRoomSize("issue-1"), 1);

    wsModule.handleWsClientMessage(socketId, JSON.stringify({
      type: "issue:log:unsubscribe",
      id: "issue-1",
    }), () => {
      // no-op
    });
    assert.equal(wsModule.issueLogRoomSize("issue-1"), 0);
  });

  it("tracks invalid payload as parse/command errors", () => {
    const socketId = "sock-bad";
    wsModule.wsClients.set(socketId, () => {});

    wsModule.handleWsClientMessage(socketId, "not-json", () => {
      // invalid payload
    });

    wsModule.handleWsClientMessage(socketId, JSON.stringify({
      type: "issue:log:subscribe",
    }), () => {
      // id is required
    });

    const telemetry = wsModule.getWsTelemetry();
    assert.equal(telemetry.invalidMessages, 1);
    assert.equal(telemetry.invalidCommandPayloads, 1);
  });

  it("sends mesh snapshot on mesh:subscribe when provider exists", () => {
    const socketId = "sock-mesh-snapshot";
    const sent: string[] = [];
    wsModule.wsClients.set(socketId, (data) => sent.push(data));
    wsModule.setMeshSnapshotProvider(() => ({
      graph: { nodes: [], edges: [] },
      nativeGraph: { edges: [] },
      traffic: [{ id: "tr_1" }],
      status: { enabled: true, running: true, port: 5000 },
    }));

    wsModule.handleWsClientMessage(socketId, JSON.stringify({ type: "mesh:subscribe" }), () => {});

    assert.equal(sent.length, 1);
    const payload = JSON.parse(sent[0]);
    assert.equal(payload.type, "mesh:snapshot");
    assert.equal(payload.graph.nodes.length, 0);
    assert.equal(payload.traffic[0]?.id, "tr_1");
    assert.equal(payload.status?.port, 5000);
  });

  it("sends services snapshot on connection when provider exists", () => {
    const socketId = "sock-services-connection";
    const sent = [];
    wsModule.setServicesSnapshotProvider(() => ({ services: [{ id: "svc-1", name: "api", running: true }] }));
    wsModule.setMeshSnapshotProvider(() => ({ graph: {}, nativeGraph: {}, traffic: [] }));

    const config = wsModule.makeWebSocketConfig({
      issues: [],
      events: [],
      milestones: [],
    } as unknown as Record<string, unknown>);

    config.onConnection(socketId, (data) => sent.push(data));

    assert.equal(sent.length, 3);
    const servicesPayload = sent
      .map((entry) => JSON.parse(entry))
      .find((payload) => payload.type === "services:snapshot");
    const meshPayload = sent
      .map((entry) => JSON.parse(entry))
      .find((payload) => payload.type === "mesh:snapshot");
    assert.ok(servicesPayload);
    assert.ok(meshPayload);
    assert.equal(servicesPayload.type, "services:snapshot");
    assert.equal(servicesPayload.seq, 0);
    assert.equal(servicesPayload.services[0]?.id, "svc-1");
  });

  it("broadcasts services snapshots to all connected clients", () => {
    const sentA = [];
    const sentB = [];
    wsModule.setServicesSnapshotProvider(() => ({ services: [{ id: "svc-1", name: "api" }] }));
    wsModule.handleWsClientMessage("sock-a", JSON.stringify({ type: "services:subscribe" }), () => {});
    wsModule.handleWsClientMessage("sock-b", JSON.stringify({ type: "services:subscribe" }), () => {});
    wsModule.wsClients.set("sock-a", (data) => sentA.push(data));
    wsModule.wsClients.set("sock-b", (data) => sentB.push(data));

    wsModule.notifyServicesSnapshot();

    const parsedA = JSON.parse(sentA[0]);
    const parsedB = JSON.parse(sentB[0]);
    assert.equal(parsedA.type, "services:snapshot");
    assert.equal(parsedB.type, "services:snapshot");
    assert.equal(parsedA.services[0]?.name, "api");
    assert.equal(parsedB.services[0]?.name, "api");
  });

  it("updates services snapshot sequence on each broadcast", () => {
    const sent = [];
    wsModule.handleWsClientMessage("sock-a", JSON.stringify({ type: "services:subscribe" }), () => {});
    wsModule.wsClients.set("sock-a", (data) => sent.push(JSON.parse(data)));
    wsModule.setServicesSnapshotProvider(() => ({ services: [{ id: "svc-1", name: "api" }] }));

    wsModule.notifyServicesSnapshot();
    wsModule.notifyServicesSnapshot();

    assert.equal(sent.length, 2);
    assert.equal(sent[1]?.seq - sent[0]?.seq, 1);
    assert.ok(sent[0]?.seq > 0);
  });

  it("broadcasts mesh snapshots to all connected clients and updates sequence", () => {
    const sentA = [];
    const sentB = [];
    wsModule.setMeshSnapshotProvider(() => ({
      graph: { nodes: [], edges: [] },
      nativeGraph: { edges: [] },
      traffic: [{ id: "tr_1" }],
      status: { enabled: true, running: true, port: 5000 },
    }));

    wsModule.handleWsClientMessage("sock-a", JSON.stringify({ type: "mesh:subscribe" }), () => {});
    wsModule.handleWsClientMessage("sock-b", JSON.stringify({ type: "mesh:subscribe" }), () => {});
    wsModule.wsClients.set("sock-a", (data) => sentA.push(JSON.parse(data)));
    wsModule.wsClients.set("sock-b", (data) => sentB.push(JSON.parse(data)));

    wsModule.notifyMeshSnapshot();
    wsModule.notifyMeshSnapshot();

    const snapshotA = sentA[0];
    const snapshotA2 = sentA[1];
    const snapshotB = sentB[0];
    assert.equal(snapshotA.type, "mesh:snapshot");
    assert.equal(snapshotA2.type, "mesh:snapshot");
    assert.equal(snapshotB.type, "mesh:snapshot");
    assert.ok(snapshotA.seq > 0);
    assert.equal(snapshotA2.seq - snapshotA.seq, 1);
    assert.equal(snapshotB.seq, snapshotA.seq);
    assert.equal(wsModule.meshRoomHasSubscribers(), true);
  });
});
