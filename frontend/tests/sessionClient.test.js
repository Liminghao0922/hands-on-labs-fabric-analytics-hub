// Run with: node --experimental-vm-modules --test tests\sessionClient.test.js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/sessionClient.js", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../src/apiClient.js", import.meta.url), "utf8");
const prefix = "fah.session.";

async function createBrowser(overrides = {}, responder) {
  let now = 1_000_000;
  let nextTimer = 0;
  const heldLocks = new Map();
  const timers = new Map();
  const storage = new Map();
  const writes = [];
  const calls = [];
  const tabs = [];
  const config = {
    enabled: true, heartbeatMode: "activity", activityCheckSeconds: 60,
    idleTimeoutSeconds: 120, warningSeconds: 20, heartbeatIntervalSeconds: 60,
    ttlSeconds: 300, renewalMarginSeconds: 120, releaseOnClose: true, ...overrides,
  };
  const settle = async () => {
    await setImmediate();
    await setImmediate();
  };
  const locks = {
    async request(name, options, fn) {
      if (heldLocks.has(name) && options.ifAvailable) {
        return fn(null);
      }
      while (heldLocks.has(name)) {
        await heldLocks.get(name);
      }
      let release;
      const unlock = new Promise((resolve) => { release = resolve; });
      heldLocks.set(name, unlock);
      try {
        return await fn({ name });
      } finally {
        heldLocks.delete(name);
        release();
      }
    },
  };
  async function newTab() {
    const window = new EventTarget();
    const document = new EventTarget();
    document.visibilityState = "visible";
    window.location = { href: "/" };
    window.setTimeout = (fn, delay) => {
      const id = ++nextTimer;
      timers.set(id, { fn, at: now + delay });
      return id;
    };
    window.clearTimeout = (id) => timers.delete(id);
    function broadcast(key) {
      for (const other of tabs) {
        if (other.window !== window) {
          queueMicrotask(() => {
            const event = new Event("storage");
            event.key = key;
            other.window.dispatchEvent(event);
          });
        }
      }
    }
    window.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem(key, value) {
        const changed = storage.get(key) !== String(value);
        storage.set(key, String(value));
        writes.push({ key, value, at: now });
        if (changed) broadcast(key);
      },
      removeItem(key) {
        if (storage.delete(key)) broadcast(key);
      },
    };
    class FakeDate extends Date {
      static now() { return now; }
    }
    class SessionEvent extends Event {
      constructor(name, options) {
        super(name);
        this.detail = options?.detail;
      }
    }
    const context = vm.createContext({
      window, document, navigator: { locks, sendBeacon() {} },
      crypto: globalThis.crypto, Date: FakeDate, Math: Object.assign(Object.create(Math), { random: () => 0 }),
      EventTarget, CustomEvent: SessionEvent, Blob, console: { warn() {} },
      fetch: async (url, options) => {
        const call = { action: url.split("/").at(-1), body: options.body ? JSON.parse(options.body) : null, options, at: now };
        calls.push(call);
        const custom = await responder?.(call, config, now);
        if (custom instanceof Response) {
          return custom;
        }
        const data = custom ?? {
          ...config, slotId: "slot-0000", expiresAt: Math.floor(now / 1000) + config.ttlSeconds,
        };
        return { ok: true, status: 200, json: async () => data };
      },
    });
    const module = new vm.SourceTextModule(source, { context });
    await module.link(() => { throw new Error("Unexpected import"); });
    await module.evaluate();
    const apiModule = new vm.SourceTextModule(apiSource, { context });
    await apiModule.link((specifier) => {
      assert.equal(specifier, "./sessionClient");
      return module;
    });
    await apiModule.evaluate();
    const tab = { client: module.namespace, api: apiModule.namespace, window, document, events: [] };
    for (const name of ["idle-warning", "idle-cleared", "logged-out"]) {
      tab.client.onSessionEvent(name, (event) => tab.events.push({ name, detail: event.detail }));
    }
    tabs.push(tab);
    return tab;
  }
  async function start(tab) {
    await tab.client.acquireSession();
    tab.client.startSessionKeepAlive();
    await settle();
  }
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = Math.max(now, timer.at);
      timer.fn();
      await settle();
    }
    now = target;
    await settle();
  }
  return {
    newTab, start, advance, settle, calls, storage, writes, config,
    jump(ms) { now += ms; },
    get now() { return now; },
  };
}

test("activity checks do not call the server without activity", async () => {
  const browser = await createBrowser();
  const tab = await browser.newTab();
  await browser.start(tab);
  await browser.advance(180000);
  assert.equal(browser.calls.length, 1);
  assert.equal(tab.events.filter((event) => event.name === "idle-warning").length, 0);
});

test("activity is shared and throttled, with only one heartbeat across two tabs", async () => {
  const browser = await createBrowser();
  const first = await browser.newTab();
  const second = await browser.newTab();
  await browser.start(first);
  await browser.start(second);
  for (let index = 0; index < 6; index++) {
    await browser.advance(1000);
    first.window.dispatchEvent(new Event("pointerdown"));
  }
  await browser.advance(174000);
  assert.equal(browser.calls.filter((call) => call.action === "heartbeat").length, 1);
  const writes = browser.writes.filter((write) => write.key === `${prefix}lastActivityAt`);
  for (let index = 1; index < writes.length; index++) {
    assert.ok(writes[index].at - writes[index - 1].at >= 5000);
  }
});

test("validation headers update expiry without pretending an extension occurred", async () => {
  const browser = await createBrowser();
  const tab = await browser.newTab();
  await browser.start(tab);
  const last = browser.storage.get(`${prefix}lastExtendedAt`);
  await browser.advance(10000);
  tab.client.noteSessionHeaders((name) => ({
    "x-session-expires-at": "2000", "x-session-extended": "false",
  })[name]);
  assert.equal(browser.storage.get(`${prefix}expiresAt`), "2000");
  assert.equal(browser.storage.get(`${prefix}lastExtendedAt`), last);
  tab.client.noteSessionHeaders((name) => name === "x-session-extended" ? "true" : null);
  assert.equal(Number(browser.storage.get(`${prefix}lastExtendedAt`)), browser.now);
});

test("warning input clears all tabs, renews near server expiry, then idle logout releases exactly once", async () => {
  const browser = await createBrowser();
  const first = await browser.newTab();
  const second = await browser.newTab();
  await browser.start(first);
  await browser.start(second);
  await browser.advance(280000);
  for (const tab of [first, second]) {
    assert.equal(tab.events.filter((event) => event.name === "idle-warning").length, 1);
  }
  await browser.advance(1000);
  second.window.dispatchEvent(new Event("keydown"));
  await browser.settle();
  assert.equal(browser.calls.filter((call) => call.action === "heartbeat").length, 1);
  for (const tab of [first, second]) {
    assert.ok(tab.events.some((event) => event.name === "idle-cleared"));
  }
  first.client.markActivity("continue");
  await browser.settle();
  assert.equal(browser.calls.filter((call) => call.action === "heartbeat").length, 1);
  await browser.advance(300000);
  const releases = browser.calls.filter((call) => call.action === "release");
  assert.equal(releases.length, 1);
  assert.equal(releases[0].body.reason, "idle");
  assert.equal(releases[0].options.keepalive, true);
  for (const tab of [first, second]) {
    assert.equal(tab.events.filter((event) => event.name === "logged-out").length, 1);
    const logoutUrl = new URL(tab.window.location.href, "https://example.test");
    assert.equal(logoutUrl.pathname, "/.auth/logout");
    assert.equal(logoutUrl.searchParams.get("post_logout_redirect_uri"), "/session-logged-out?reason=idle");
  }
});

test("idle logout does not wait for a stalled keepalive release response", async () => {
  const browser = await createBrowser({}, (call) => {
    if (call.action === "release") {
      return new Promise(() => {});
    }
  });
  const tab = await browser.newTab();
  await browser.start(tab);
  await browser.advance(300000);
  assert.equal(browser.calls.filter((call) => call.action === "release").length, 1);
  assert.ok(tab.events.some((event) => event.name === "logged-out"));
  assert.ok(tab.window.location.href.startsWith("/.auth/logout?"));
});

test("sleep past the logout boundary cannot be revived by input", async () => {
  const browser = await createBrowser();
  const tab = await browser.newTab();
  await browser.start(tab);
  browser.jump(300001);
  tab.window.dispatchEvent(new Event("pointerdown"));
  tab.window.dispatchEvent(new Event("focus"));
  await browser.settle();
  assert.equal(browser.calls.filter((call) => call.action === "heartbeat").length, 0);
  assert.equal(browser.calls.filter((call) => call.action === "release").length, 1);
  assert.ok(tab.events.some((event) => event.name === "logged-out"));
});

test("degraded responses retry acquire at the next check without user activity", async () => {
  let acquires = 0;
  const browser = await createBrowser({}, (call, config) => {
    if (call.action === "acquire" && ++acquires === 1) {
      return { ...config, degraded: true, errorId: "test-error" };
    }
  });
  const tab = await browser.newTab();
  await browser.start(tab);
  assert.equal(tab.client.getSessionInfo().degraded, true);
  assert.equal(tab.client.getSessionInfo().slotId, null);
  await browser.advance(60000);
  assert.equal(browser.calls.filter((call) => call.action === "acquire").length, 2);
  assert.equal(tab.client.getSessionInfo().degraded, false);
  assert.equal(tab.client.getSessionInfo().slotId, "slot-0000");
});

test("interval mode keeps heartbeats and never shows an idle warning", async () => {
  const browser = await createBrowser({ heartbeatMode: "interval", idleTimeoutSeconds: 60 });
  const tab = await browser.newTab();
  await browser.start(tab);
  await browser.advance(180000);
  assert.equal(browser.calls.filter((call) => call.action === "heartbeat").length, 3);
  assert.equal(tab.events.filter((event) => event.name === "idle-warning").length, 0);
  assert.equal(browser.calls.filter((call) => call.action === "release").length, 0);
});

test("near-expiry activity extends immediately at most once per minute", async () => {
  const browser = await createBrowser();
  const tab = await browser.newTab();
  await browser.start(tab);
  await browser.advance(10000);
  tab.client.noteSessionHeaders((name) => name === "x-session-expires-at" ? String(browser.now / 1000 + 100) : null);
  tab.client.markActivity("powerbi:dataSelected");
  await browser.settle();
  tab.client.noteSessionHeaders((name) => name === "x-session-expires-at" ? String(browser.now / 1000 + 100) : null);
  tab.client.markActivity("powerbi:visualClicked");
  await browser.settle();
  assert.equal(browser.calls.filter((call) => call.action === "heartbeat").length, 1);
});

test("server mode changes are applied and stop removes all input listeners", async () => {
  const browser = await createBrowser({ heartbeatMode: "interval" }, (call, config, now) => {
    if (call.action === "heartbeat") {
      return { ...config, heartbeatMode: "activity", slotId: "slot-0000", expiresAt: now / 1000 + 300 };
    }
  });

  const tab = await browser.newTab();
  await browser.start(tab);
  await browser.advance(60000);
  assert.equal(tab.client.getSessionInfo().heartbeatMode, "activity");
  await browser.advance(1000);
  tab.window.dispatchEvent(new Event("wheel"));
  await browser.settle();
  assert.equal(Number(browser.storage.get(`${prefix}lastActivityAt`)), browser.now);
  tab.client.stopSessionKeepAlive();
  const last = browser.storage.get(`${prefix}lastActivityAt`);
  await browser.advance(10000);
  tab.window.dispatchEvent(new Event("pointerdown"));
  tab.client.markActivity("powerbi:pageChanged");
  assert.equal(browser.storage.get(`${prefix}lastActivityAt`), last);
});

test("changed TTL and renewal margins take effect without resetting the last activity", async () => {
  const browser = await createBrowser();
  const tab = await browser.newTab();
  await browser.start(tab);
  const lastActivity = tab.client.getSessionDebugInfo().lastActivityAt;
  browser.config.renewalMarginSeconds = 80;
  browser.config.ttlSeconds = 400;
  await browser.advance(10000);
  await tab.client.acquireSession();
  assert.equal(Number(browser.storage.get(`${prefix}nextCheckAt`)), browser.now + 320000);
  assert.equal(tab.client.getSessionDebugInfo().lastActivityAt, lastActivity);
  assert.equal(tab.client.getSessionDebugInfo().logoutAt, lastActivity + 400000);
  await browser.advance(10000);
  tab.client.markActivity("powerbi:visualClicked");
  await browser.advance(310000);
  assert.equal(browser.calls.filter((call) => call.action === "heartbeat").length, 1);
});

test("cached expired responses cannot invalidate a newly acquired session", async () => {
  const cachedExpired = new Response(JSON.stringify({
    error: "Session expired.", code: "SESSION_EXPIRED",
  }), { status: 410 });
  const browser = await createBrowser({}, (call) => {
    if (call.action === "reports") {
      return call.options.cache === "no-store"
        ? new Response(JSON.stringify({ reports: [] }), { status: 200 })
        : cachedExpired.clone();
    }
  });
  const tab = await browser.newTab();
  await browser.start(tab);
  assert.deepEqual(await tab.api.apiGet("/api/reports"), { reports: [] });
  assert.equal(browser.calls.filter((call) => call.action === "acquire").length, 1);
});

test("a real expired response is recovered once without reusing the cached error", async () => {
  let reportReads = 0;
  const browser = await createBrowser({}, (call) => {
    if (call.action === "reports") {
      reportReads += 1;
      if (reportReads === 1 || call.options.cache !== "no-store") {
        return new Response(JSON.stringify({
          error: "Session expired.", code: "SESSION_EXPIRED",
        }), { status: 410 });
      }
      return new Response(JSON.stringify({ reports: [] }), { status: 200 });
    }
  });
  const tab = await browser.newTab();
  await browser.start(tab);
  assert.deepEqual(await tab.api.apiGet("/api/reports"), { reports: [] });
  assert.equal(reportReads, 2);
  assert.equal(browser.calls.filter((call) => call.action === "acquire").length, 2);
});

test("debug snapshots follow activity deadlines without extending TTL or polling APIs", async () => {
  const browser = await createBrowser();
  const tab = await browser.newTab();
  await browser.start(tab);
  const before = tab.client.getSessionDebugInfo();
  const observed = [];
  tab.client.onSessionEvent("activity", (event) => observed.push(event.detail));
  await browser.advance(10000);
  tab.client.markActivity("powerbi:dataSelected", { visualType: "slicer" });
  const after = tab.client.getSessionDebugInfo();
  assert.equal(after.warnAt - before.warnAt, 10000);
  assert.equal(after.logoutAt - before.logoutAt, 10000);
  assert.equal(after.expiresAtMs, before.expiresAtMs);
  assert.equal(after.lastExtendedAt, before.lastExtendedAt);
  assert.equal(observed[0].accepted, true);
  assert.equal(observed[0].source, "powerbi:dataSelected");
  assert.equal(observed[0].visualType, "slicer");
  assert.equal(observed[0].previousWarnAt, before.warnAt);
  assert.equal(observed[0].warnAt, after.warnAt);
  const writes = browser.writes.length;
  for (let index = 0; index < 10; index++) {
    tab.client.getSessionDebugInfo();
  }
  assert.equal(browser.writes.length, writes);
  assert.equal(browser.calls.length, 1);
});

test("initial Power BI events are visible as ignored without resetting idle deadlines", async () => {
  const browser = await createBrowser();
  const tab = await browser.newTab();
  await browser.start(tab);
  const before = tab.client.getSessionDebugInfo();
  const observed = [];
  tab.client.onSessionEvent("activity", (event) => observed.push(event.detail));
  await browser.advance(10000);
  tab.client.markActivity("powerbi:pageChanged", { ignoreReason: "initial-load" });
  const after = tab.client.getSessionDebugInfo();
  assert.equal(observed[0].accepted, false);
  assert.equal(observed[0].reason, "initial-load");
  assert.equal(after.lastActivityAt, before.lastActivityAt);
  assert.equal(after.warnAt, before.warnAt);
  assert.equal(after.logoutAt, before.logoutAt);
  assert.equal(browser.calls.length, 1);
});

test("debug idle deadlines are shared across tabs and absent in interval mode", async () => {
  const browser = await createBrowser();
  const first = await browser.newTab();
  const second = await browser.newTab();
  await browser.start(first);
  await browser.start(second);
  await browser.advance(10000);
  first.client.markActivity("keydown");
  await browser.settle();
  assert.equal(first.client.getSessionDebugInfo().warnAt, second.client.getSessionDebugInfo().warnAt);
  assert.equal(first.client.getSessionDebugInfo().logoutAt, second.client.getSessionDebugInfo().logoutAt);
  browser.storage.set(`${prefix}config`, JSON.stringify({ ...browser.config, heartbeatMode: "interval" }));
  const observed = [];
  second.client.onSessionEvent("activity", (event) => observed.push(event.detail));
  second.client.markActivity("powerbi:visualClicked", { visualType: "barChart" });
  const snapshot = second.client.getSessionDebugInfo();
  assert.equal(snapshot.warnAt, null);
  assert.equal(snapshot.logoutAt, null);
  assert.equal(observed[0].accepted, false);
  assert.equal(observed[0].reason, "interval-mode");
});

test("continuous activity renews at server expiry minus margin, not at 300 or 600 seconds", async () => {
  const browser = await createBrowser({
    ttlSeconds: 900, renewalMarginSeconds: 120, warningSeconds: 60,
    activityCheckSeconds: 600, heartbeatIntervalSeconds: 300,
  });
  const first = await browser.newTab();
  const second = await browser.newTab();
  await browser.start(first);
  await browser.start(second);
  const initialExpiry = first.client.getSessionDebugInfo().expiresAtMs;
  for (let index = 0; index < 25; index++) {
    await browser.advance(30000);
    first.client.markActivity("powerbi:visualClicked");
  }
  assert.equal(browser.calls.filter((call) => call.action === "heartbeat").length, 0);
  await browser.advance(30000);
  const heartbeats = browser.calls.filter((call) => call.action === "heartbeat");
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].at, initialExpiry - 120000);
  assert.equal(first.client.getSessionDebugInfo().renewAt, initialExpiry + 780000 - 120000);
});

test("one early activity cannot prolong the client idle deadline when the server renews", async () => {
  const browser = await createBrowser({ ttlSeconds: 900, warningSeconds: 60 });
  const tab = await browser.newTab();
  await browser.start(tab);
  await browser.advance(60000);
  tab.client.markActivity("keydown");
  const active = tab.client.getSessionDebugInfo();
  await browser.advance(720000);
  const renewed = tab.client.getSessionDebugInfo();
  assert.equal(browser.calls.filter((call) => call.action === "heartbeat").length, 1);
  assert.ok(renewed.expiresAtMs > active.expiresAtMs);
  assert.equal(renewed.logoutAt, active.lastActivityAt + 900000);
  assert.equal(renewed.warnAt, renewed.logoutAt - 60000);
  await browser.advance(120000);
  assert.ok(tab.events.some((event) => event.name === "idle-warning"));
  await browser.advance(60000);
  assert.ok(tab.events.some((event) => event.name === "logged-out"));
  assert.equal(browser.calls.filter((call) => call.action === "heartbeat").length, 1);
});

test("no activity warns one warning period before last activity plus TTL and never renews", async () => {
  const browser = await createBrowser({ ttlSeconds: 900, warningSeconds: 60 });
  const tab = await browser.newTab();
  await browser.start(tab);
  const idleDeadline = tab.client.getSessionDebugInfo().logoutAt;
  await browser.advance(839999);
  assert.equal(tab.events.filter((event) => event.name === "idle-warning").length, 0);
  await browser.advance(1);
  assert.equal(tab.events.find((event) => event.name === "idle-warning").detail.logoutAt, idleDeadline);
  await browser.advance(60000);
  assert.equal(browser.calls.filter((call) => call.action === "heartbeat").length, 0);
  assert.equal(browser.calls.filter((call) => call.action === "release").length, 1);
  assert.ok(tab.events.some((event) => event.name === "logged-out"));
});

test("renewal failure retries after 60 seconds without repeated requests on each input", async () => {
  let attempts = 0;
  const browser = await createBrowser({}, (call) => {
    if (call.action === "heartbeat" && ++attempts === 1) {
      return new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 });
    }
  });
  const tab = await browser.newTab();
  await browser.start(tab);
  await browser.advance(10000);
  tab.client.markActivity("pointerdown");
  await browser.advance(170000);
  assert.equal(attempts, 1);
  await browser.advance(10000);
  tab.client.markActivity("wheel");
  await browser.settle();
  assert.equal(attempts, 1);
  await browser.advance(50000);
  assert.equal(attempts, 2);
});

test("a changed validate-only expiry moves the renewal schedule without extending idle time", async () => {
  const browser = await createBrowser();
  const tab = await browser.newTab();
  await browser.start(tab);
  const before = tab.client.getSessionDebugInfo();
  await browser.advance(10000);
  tab.client.noteSessionHeaders((name) => ({
    "x-session-expires-at": String(browser.now / 1000 + 180),
    "x-session-extended": "false",
  })[name]);
  const after = tab.client.getSessionDebugInfo();
  assert.equal(after.renewAt, browser.now + 60000);
  assert.equal(after.nextCheckAt, after.renewAt);
  assert.equal(after.lastExtendedAt, before.lastExtendedAt);
  assert.equal(after.logoutAt, before.logoutAt);
});

test("continuing from an idle warning does not renew early while the server expiry is still safe", async () => {
  const browser = await createBrowser();
  const tab = await browser.newTab();
  await browser.start(tab);
  await browser.advance(10000);
  tab.client.markActivity("pointerdown");
  await browser.advance(170000);
  assert.equal(browser.calls.filter((call) => call.action === "heartbeat").length, 1);
  await browser.advance(110000);
  assert.ok(tab.events.some((event) => event.name === "idle-warning"));
  tab.client.markActivity("continue");
  await browser.settle();
  assert.equal(browser.calls.filter((call) => call.action === "heartbeat").length, 1);
  assert.ok(tab.events.some((event) => event.name === "idle-cleared"));
});

test("a stalled renewal cannot delay idle logout or restore the slot after logout", async () => {
  let completeHeartbeat;
  const browser = await createBrowser({}, (call) => {
    if (call.action === "heartbeat") {
      return new Promise((resolve) => { completeHeartbeat = resolve; });
    }
  });
  const tab = await browser.newTab();
  await browser.start(tab);
  await browser.advance(10000);
  tab.client.markActivity("keydown");
  await browser.advance(300000);
  assert.equal(browser.calls.filter((call) => call.action === "heartbeat").length, 1);
  assert.equal(browser.calls.filter((call) => call.action === "release").length, 1);
  assert.ok(tab.events.some((event) => event.name === "logged-out"));
  completeHeartbeat({
    ...browser.config, slotId: "slot-0000", expiresAt: browser.now / 1000 + 300,
  });
  await browser.settle();
  assert.equal(tab.client.getSessionInfo().slotId, null);
});

test("API recovery after the idle deadline logs out instead of acquiring another slot", async () => {
  const browser = await createBrowser();
  const tab = await browser.newTab();
  await browser.start(tab);
  browser.jump(300001);
  assert.equal(await tab.client.recoverSession(), false);
  await browser.settle();
  assert.equal(browser.calls.filter((call) => call.action === "acquire").length, 1);
  assert.ok(tab.events.some((event) => event.name === "logged-out"));
});
