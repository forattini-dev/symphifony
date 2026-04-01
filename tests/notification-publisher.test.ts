import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { publishNotification } from "../app/src/notifications/notificationPublisher.js";

function installWindow(notificationCtor) {
  const previousWindow = globalThis.window;
  const previousServiceWorker = globalThis.navigator?.serviceWorker;
  globalThis.window = { Notification: notificationCtor };
  return () => {
    globalThis.window = previousWindow;
    if (typeof previousServiceWorker === "undefined") {
      delete globalThis.navigator?.serviceWorker;
    } else {
      globalThis.navigator.serviceWorker = previousServiceWorker;
    }
  };
}

function createNotificationStub(counters) {
  return class TestNotification {
    static get permission() {
      return counters.permission;
    }

    constructor(title, options) {
      counters.localCalls += 1;
      counters.lastLocalTitle = title;
      counters.lastLocalOptions = options;
    }
  };
}

describe("notification publisher", () => {
  test("does not publish when notification permission is not granted", async () => {
    const counters = { permission: "denied", localCalls: 0 };
    const restore = installWindow(createNotificationStub(counters));
    delete globalThis.navigator.serviceWorker;

    const published = await publishNotification({
      title: "ignored",
      body: "should not appear",
      tag: "ignored",
    });

    restore();
    assert.equal(published, false);
    assert.equal(counters.localCalls, 0);
  });

  test("prefers service worker delivery when available", async () => {
    const counters = { permission: "granted", localCalls: 0, swCalls: 0 };
    const expectedTag = "fifony-test-state-123";
    const restore = installWindow(createNotificationStub(counters));
    globalThis.navigator.serviceWorker = {
      getRegistration: async () => ({
        active: {
          postMessage(payload) {
            counters.swCalls += 1;
            counters.lastSwPayload = payload;
          },
        },
      }),
    };

    const published = await publishNotification({
      title: "State changed",
      body: "Issue #123 entered review",
      tag: "test-state-123",
      data: { issueId: "123" },
    });

    assert.equal(published, true);
    assert.equal(counters.swCalls, 1);
    assert.equal(counters.localCalls, 0);
    assert.equal(counters.lastSwPayload.type, "FIFONY_NOTIFICATION");
    assert.equal(counters.lastSwPayload.payload.title, "State changed");
    assert.equal(counters.lastSwPayload.payload.tag, expectedTag);
    assert.equal(counters.lastSwPayload.payload.data.issueId, "123");

    restore();
  });

  test("falls back to Notification API when service worker is unavailable", async () => {
    const counters = { permission: "granted", localCalls: 0 };
    const restore = installWindow(createNotificationStub(counters));
    delete globalThis.navigator.serviceWorker;

    const published = await publishNotification({
      title: "Fallback",
      body: "No SW available",
      tag: "fallback",
    });

    restore();
    assert.equal(published, true);
    assert.equal(counters.localCalls, 1);
    assert.equal(counters.lastLocalOptions.tag, "fifony-fallback");
    assert.equal(counters.lastLocalOptions.data.url, "/kanban");
  });
});
