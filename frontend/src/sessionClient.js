// Concurrent session control (browser side).
//
// - acquireSession(): reserve one slot after sign-in.
// - startSessionKeepAlive(): send heartbeats with as few requests as possible.
//     * Activity mode renews at server expiry minus the configured margin.
//       Its independent idle deadline is last activity plus TTL.
//     * One heartbeat per browser, not per tab (shared via localStorage and
//       the Web Locks API).
//     * Activity mode extends only after input; interval mode keeps the
//       previous fixed-interval behavior.
// - The slot is released when the last tab is closed (sendBeacon). If that
//   request is lost, the server-side TTL frees the slot.
//
// The local timer only reads localStorage; it does not call the server unless
// a heartbeat is actually due.

const API_BASE = "/api/session";
const STORAGE = {
  browserId: "fah.session.browserId",
  slotId: "fah.session.slotId",
  lastExtendedAt: "fah.session.lastExtendedAt",
  config: "fah.session.config",
  tabs: "fah.session.tabs",
  expiresAt: "fah.session.expiresAt",
  lastActivityAt: "fah.session.lastActivityAt",
  lastActivityWrittenAt: "fah.session.lastActivityWrittenAt",
  lastImmediateAt: "fah.session.lastImmediateAt",
  nextCheckAt: "fah.session.nextCheckAt",
  logout: "fah.session.logout",
};
const DEFAULT_CONFIG = {
  enabled: true,
  heartbeatIntervalSeconds: 300,
  ttlSeconds: 900,
  releaseOnClose: true,
  maxSessions: null,
  heartbeatMode: "activity",
  activityCheckSeconds: 600,
  idleTimeoutSeconds: 600,
  warningSeconds: 60,
  renewalMarginSeconds: 120,
  degraded: false,
};
const MAX_CHECK_INTERVAL_MS = 60 * 1000;
const MIN_CHECK_INTERVAL_MS = 5 * 1000;
const STALE_TAB_MS = 3 * MAX_CHECK_INTERVAL_MS;
const HEARTBEAT_LOCK_NAME = "fah-session-heartbeat";
const LOGOUT_LOCK_NAME = "fah-session-logout";
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"];
const ACTIVITY_OPTIONS = { capture: true, passive: true };
const ACTIVITY_WRITE_MS = 5000;
const RENEWAL_RETRY_MS = 60000;

const events = new EventTarget();
const TAB_ID = randomId();

let started = false;
let timerId = null;
let recovering = null;
let idleTimerId = null;
let activityWriteTimerId = null;
let localActivityAt = 0;
let warningLogoutAt = null;
let loggedOut = false;
let storageWarningShown = false;
const memoryStorage = new Map();

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function readItem(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    warnStorageUnavailable();
    return memoryStorage.get(key) ?? null;
  }
}

function writeItem(key, value) {
  if (value === null || value === undefined) {
    memoryStorage.delete(key);
  } else {
    memoryStorage.set(key, value);
  }
  try {
    if (value === null || value === undefined) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    warnStorageUnavailable();
  }
}

function warnStorageUnavailable() {
  if (!storageWarningShown) {
    storageWarningShown = true;
    console.warn("Session storage is unavailable; cross-tab coordination is disabled.");
  }
}

function readJson(key) {
  try {
    return JSON.parse(readItem(key) || "null");
  } catch {
    return null;
  }
}

function randomId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getBrowserId() {
  let id = readItem(STORAGE.browserId);
  if (!id) {
    id = randomId();
    writeItem(STORAGE.browserId, id);
  }
  return id;
}

function getConfig() {
  return { ...DEFAULT_CONFIG, ...(readJson(STORAGE.config) || {}) };
}

function saveConfig(partial) {
  const next = { ...getConfig() };
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined && value !== null && !Number.isNaN(value)) {
      next[key] = value;
    }
  }
  writeItem(STORAGE.config, JSON.stringify(next));
}

export function getSessionInfo() {
  return {
    slotId: readItem(STORAGE.slotId),
    expiresAt: Number(readItem(STORAGE.expiresAt)),
    logoutAt: warningLogoutAt,
    ...getConfig(),
  };
}

export function getSessionDebugInfo() {
  const config = getConfig();
  const active = started && !loggedOut && config.enabled;
  const activityMode = active && config.heartbeatMode === "activity";
  const lastActivity = lastActivityAt();
  const lastExtended = Number(readItem(STORAGE.lastExtendedAt) || 0);
  const { warnAt, logoutAt } = idleBoundaries();
  const now = Date.now();
  const due = activityMode ? activityCheckAt() : null;
  const waiting = activityMode && !config.degraded && (!activitySinceExtension() || now >= warnAt);
  return {
    now,
    active,
    degraded: config.degraded,
    slotId: readItem(STORAGE.slotId),
    heartbeatMode: config.heartbeatMode,
    expiresAtMs: Number(readItem(STORAGE.expiresAt) || 0) * 1000 || null,
    lastActivityAt: lastActivity || null,
    lastExtendedAt: lastExtended || null,
    nextCheckAt: active
      ? config.heartbeatMode === "activity"
        ? waiting && now >= due ? null : due
        : lastExtended + config.heartbeatIntervalSeconds * 1000
      : null,
    renewAt: activityMode ? renewalAt() : null,
    renewalState: !active ? "inactive" : !activityMode ? "fixed interval"
      : config.degraded ? "retry acquire" : waiting ? "waiting for activity" : "scheduled",
    warnAt: activityMode ? warnAt : null,
    logoutAt: activityMode ? logoutAt : null,
    warningVisible: warningLogoutAt !== null,
    ttlSeconds: config.ttlSeconds,
    renewalMarginSeconds: config.renewalMarginSeconds,
    warningSeconds: config.warningSeconds,
  };
}

export function onSessionEvent(type, handler) {
  events.addEventListener(type, handler);
  return () => events.removeEventListener(type, handler);
}

function emit(type, detail) {
  events.dispatchEvent(new CustomEvent(type, { detail }));
}

// ---------------------------------------------------------------------------
// Integration points used by apiClient.js
// ---------------------------------------------------------------------------

export function sessionHeaders() {
  const headers = { "X-Session-Browser": getBrowserId() };
  const slotId = readItem(STORAGE.slotId);
  if (slotId) {
    headers["X-Session-Slot"] = slotId;
  }
  return headers;
}

export function markExtended(at = Date.now(), source = "business-api") {
  writeItem(STORAGE.lastExtendedAt, String(at));
  if (getConfig().heartbeatMode === "activity") {
    scheduleRenewalCheck();
  }
  emit("extended", { at, source });
}

// Validate-only business calls must not suppress a later activity heartbeat.
export function noteSessionHeaders(getHeader) {
  const expiresAt = getHeader("x-session-expires-at");
  const expiryChanged = expiresAt && expiresAt !== readItem(STORAGE.expiresAt);
  if (expiresAt) {
    writeItem(STORAGE.expiresAt, expiresAt);
  }
  if (getHeader("x-session-extended") === "true") {
    markExtended();
  } else if (expiryChanged && getConfig().heartbeatMode === "activity") {
    scheduleRenewalCheck();
  }
  if (getHeader("x-session-degraded") === "true") {
    saveConfig({ degraded: true });
    scheduleRenewalCheck();
  }
  const interval = Number(getHeader("x-session-heartbeat-interval"));
  if (interval > 0) {
    saveConfig({ heartbeatIntervalSeconds: interval });
  }
}

// ---------------------------------------------------------------------------
// Server calls
// ---------------------------------------------------------------------------

async function postSession(action, payload, options = {}) {
  return fetch(`${API_BASE}/${action}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
    ...options,
    cache: "no-store",
  });
}

function applyGrant(data, requestedAt, source) {
  if (loggedOut || readItem(STORAGE.logout)) {
    return;
  }
  if (data.slotId) {
    writeItem(STORAGE.slotId, data.slotId);
  }
  saveConfig({
    enabled: data.enabled !== false,
    heartbeatIntervalSeconds: data.heartbeatIntervalSeconds,
    ttlSeconds: data.ttlSeconds,
    releaseOnClose: data.releaseOnClose,
    maxSessions: data.maxSessions,
    heartbeatMode: data.heartbeatMode,
    activityCheckSeconds: data.activityCheckSeconds,
    idleTimeoutSeconds: data.idleTimeoutSeconds,
    warningSeconds: data.warningSeconds,
    renewalMarginSeconds: data.renewalMarginSeconds,
    degraded: data.degraded === true,
  });
  if (data.expiresAt) {
    writeItem(STORAGE.expiresAt, String(data.expiresAt));
  }
  if (!data.degraded) {
    markExtended(requestedAt, source);
  } else {
    console.warn("Session service is running in fail-open mode.", data.errorId);
    scheduleRenewalCheck();
  }
  if (!readItem(STORAGE.lastActivityAt)) {
    writeItem(STORAGE.lastActivityAt, String(requestedAt));
    writeItem(STORAGE.lastActivityWrittenAt, String(requestedAt));
  }
  if (started) {
    syncActivityListeners();
    evaluateIdle();
  }
}

// Returns { status: "active" | "limit" | "disabled", data }.
export async function acquireSession() {
  if (loggedOut) {
    throw new Error("Session has been logged out.");
  }
  const requestedAt = Date.now();
  if (!started && (readItem(STORAGE.logout) ||
      !Object.values(readTabs()).some((seenAt) => requestedAt - seenAt < STALE_TAB_MS))) {
    writeItem(STORAGE.logout, null);
    writeItem(STORAGE.lastActivityAt, String(requestedAt));
    writeItem(STORAGE.lastActivityWrittenAt, String(requestedAt));
    writeItem(STORAGE.lastImmediateAt, null);
    writeItem(STORAGE.nextCheckAt, null);
  }
  const res = await postSession("acquire", { browserId: getBrowserId() });
  const data = await res.json();

  if (res.status === 409) {
    stopSessionKeepAlive();
    emit("limit", data);
    return { status: "limit", data };
  }
  if (!res.ok) {
    throw new Error(data.error || `Failed to acquire a session: ${res.status}`);
  }
  if (data.enabled === false) {
    saveConfig({ enabled: false });
    stopSessionKeepAlive();
    emit("disabled", data);
    return { status: "disabled", data };
  }

  applyGrant(data, requestedAt, "acquire");
  if (loggedOut || readItem(STORAGE.logout)) {
    throw new Error("Session has been logged out.");
  }
  emit("active", data);
  return { status: "active", data };
}

// Re-acquire after the server reported the session as expired. Concurrent
// callers share one request. Resolves to true when a session is active again.
export function recoverSession() {
  if (started && getConfig().heartbeatMode === "activity" && Date.now() >= idleBoundaries().logoutAt) {
    evaluateIdle();
    return Promise.resolve(false);
  }
  if (!recovering) {
    recovering = acquireSession()
      .then((result) => result.status !== "limit")
      .catch((err) => {
        console.warn("Session recovery failed.", err);
        return false;
      })
      .finally(() => {
        recovering = null;
      });
  }
  return recovering;
}

async function sendHeartbeat() {
  const requestedAt = Date.now();
  if (loggedOut || readItem(STORAGE.logout)) {
    return false;
  }
  const slotId = readItem(STORAGE.slotId);
  if (!slotId || getConfig().degraded) {
    return recoverSession();
  }

  const res = await postSession("heartbeat", { browserId: getBrowserId(), slotId });
  if (res.status === 410) {
    return recoverSession();
  }
  if (res.ok) {
    const data = await res.json();
    if (data.enabled === false) {
      saveConfig({ enabled: false });
      stopSessionKeepAlive();
      emit("disabled", data);
    } else {
      applyGrant(data, requestedAt, "heartbeat");
    }
  } else {
    console.warn("Session heartbeat rejected.", res.status);
  }
  return res.ok;
}

// Called on sign-out. keepalive lets the request finish during navigation.
export async function releaseSession({ reason = "logout" } = {}) {
  stopSessionKeepAlive();
  const slotId = readItem(STORAGE.slotId);
  writeItem(STORAGE.slotId, null);
  if (!getConfig().enabled) {
    return;
  }
  try {
    const res = await postSession("release", { browserId: getBrowserId(), slotId, reason }, { keepalive: true });
    if (!res.ok) {
      console.warn("Session release rejected.", res.status);
    }
  } catch (err) {
    // The TTL frees the slot if this request fails.
    console.warn("Session release failed; the slot will expire by TTL.", err);
  }
}

export function navigateToLogout(reason = "logout") {
  window.location.href = reason === "idle"
    ? `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent("/session-logged-out?reason=idle")}`
    : "/.auth/logout";
}

function finishLogout(reason) {
  if (loggedOut) {
    return;
  }
  loggedOut = true;
  stopSessionKeepAlive();
  emit("logged-out", { reason });
  navigateToLogout(reason);
}

async function logoutIfIdle() {
  // A stalled renewal must not hold the idle logout behind its network request.
  await withSessionLock(LOGOUT_LOCK_NAME, async () => {
    if (!started || readItem(STORAGE.logout) || Date.now() < idleBoundaries().logoutAt) {
      return;
    }
    const reason = "idle";
    writeItem(STORAGE.logout, JSON.stringify({ reason, at: Date.now() }));
    void releaseSession({ reason });
    finishLogout(reason);
  }, true);
}

function lastActivityAt() {
  return Math.max(localActivityAt, Number(readItem(STORAGE.lastActivityAt) || 0));
}

function idleBoundaries() {
  const config = getConfig();
  const logoutAt = lastActivityAt() + config.ttlSeconds * 1000;
  return { warnAt: logoutAt - config.warningSeconds * 1000, logoutAt };
}

function renewalAt() {
  const expiresAt = Number(readItem(STORAGE.expiresAt) || 0) * 1000;
  return expiresAt ? expiresAt - getConfig().renewalMarginSeconds * 1000 : null;
}

function activitySinceExtension() {
  return lastActivityAt() > Number(readItem(STORAGE.lastExtendedAt) || 0);
}

function activityCheckAt() {
  const next = Number(readItem(STORAGE.nextCheckAt) || 0);
  const due = renewalAt();
  if (getConfig().degraded || !due || !readItem(STORAGE.slotId)) {
    return next || Date.now() + getConfig().activityCheckSeconds * 1000;
  }
  return Math.max(due, next);
}

function flushActivity() {
  activityWriteTimerId = null;
  const storedAt = Number(readItem(STORAGE.lastActivityAt) || 0);
  if (localActivityAt <= storedAt) {
    return;
  }
  const writtenAt = Number(readItem(STORAGE.lastActivityWrittenAt) || storedAt);
  const delay = ACTIVITY_WRITE_MS - (Date.now() - writtenAt);
  if (delay > 0) {
    activityWriteTimerId = window.setTimeout(flushActivity, delay);
  } else {
    writeItem(STORAGE.lastActivityWrittenAt, String(Date.now()));
    writeItem(STORAGE.lastActivityAt, String(localActivityAt));
  }
}

export function markActivity(source, { visualType, ignoreReason } = {}) {
  const before = getSessionDebugInfo();
  const reason = ignoreReason ||
    (!before.active ? "session-inactive" : null) ||
    (before.heartbeatMode !== "activity" ? "interval-mode" : null) ||
    (readItem(STORAGE.logout) || before.now >= before.logoutAt ? "idle-deadline-passed" : null);
  const detail = {
    at: before.now,
    source,
    visualType: typeof visualType === "string" ? visualType.slice(0, 80) : null,
    previousWarnAt: before.warnAt,
    previousLogoutAt: before.logoutAt,
  };
  if (reason) {
    emit("activity", { ...detail, accepted: false, reason, warnAt: before.warnAt, logoutAt: before.logoutAt });
    if (reason === "idle-deadline-passed") {
      evaluateIdle();
    }
    return;
  }
  const now = before.now;
  localActivityAt = now;
  if (activityWriteTimerId === null) {
    flushActivity();
  }
  evaluateIdle();
  const after = getSessionDebugInfo();
  emit("activity", { ...detail, accepted: true, reason: null, warnAt: after.warnAt, logoutAt: after.logoutAt });
  if (!getConfig().degraded && now >= activityCheckAt()) {
    extendImmediately();
  }
}

function extendImmediately() {
  void withHeartbeatLock(async () => {
    if (!started || loggedOut || readItem(STORAGE.logout)) {
      return;
    }
    const now = Date.now();
    if (now - Number(readItem(STORAGE.lastImmediateAt) || 0) < RENEWAL_RETRY_MS) {
      return;
    }
    if (now < activityCheckAt() || now >= idleBoundaries().logoutAt) {
      return;
    }
    writeItem(STORAGE.lastImmediateAt, String(now));
    writeItem(STORAGE.nextCheckAt, String(now + RENEWAL_RETRY_MS));
    try {
      await sendHeartbeat();
    } catch (err) {
      console.warn("Immediate session extension failed.", err);
    }
  });
}

function evaluateIdle() {
  window.clearTimeout(idleTimerId);
  idleTimerId = null;
  if (!started || loggedOut) {
    return;
  }
  const logout = readJson(STORAGE.logout);
  if (logout) {
    finishLogout(logout.reason);
    return;
  }
  if (!getConfig().enabled || getConfig().heartbeatMode !== "activity") {
    if (warningLogoutAt !== null) {
      warningLogoutAt = null;
      emit("idle-cleared");
    }
    return;
  }
  const { warnAt, logoutAt } = idleBoundaries();
  const now = Date.now();
  if (now >= logoutAt) {
    void logoutIfIdle();
    return;
  }
  if (now >= warnAt) {
    if (warningLogoutAt !== logoutAt) {
      warningLogoutAt = logoutAt;
      emit("idle-warning", { logoutAt });
    }
  } else if (warningLogoutAt !== null) {
    warningLogoutAt = null;
    emit("idle-cleared");
  }
  idleTimerId = window.setTimeout(evaluateIdle, (now < warnAt ? warnAt : logoutAt) - now);
}

function onActivity(event) {
  markActivity(event.type);
}

function syncActivityListeners() {
  for (const name of ACTIVITY_EVENTS) {
    window.removeEventListener(name, onActivity, ACTIVITY_OPTIONS);
    if (started && getConfig().enabled && getConfig().heartbeatMode === "activity") {
      window.addEventListener(name, onActivity, ACTIVITY_OPTIONS);
    }
  }
}

// ---------------------------------------------------------------------------
// Keep-alive loop
// ---------------------------------------------------------------------------

function withSessionLock(name, fn, wait = false) {
  if (navigator.locks?.request) {
    return navigator.locks.request(name, { ifAvailable: !wait }, (lock) => (lock ? fn() : undefined));
  }
  return fn();
}

function withHeartbeatLock(fn) {
  return withSessionLock(HEARTBEAT_LOCK_NAME, fn);
}

function heartbeatDue() {
  const intervalMs = getConfig().heartbeatIntervalSeconds * 1000;
  const last = Number(readItem(STORAGE.lastExtendedAt) || 0);
  return Date.now() - last >= intervalMs;
}

async function tick() {
  touchTab();
  evaluateIdle();
  if (!started || !getConfig().enabled || readItem(STORAGE.logout)) {
    return; // no network call
  }

  await withHeartbeatLock(async () => {
    const config = getConfig();
    if (!started || readItem(STORAGE.logout)) {
      return;
    }
    if (config.heartbeatMode === "activity") {
      const now = Date.now();
      if (now < activityCheckAt()) {
        return;
      }
      if (!config.degraded && (!activitySinceExtension() || now >= idleBoundaries().warnAt)) {
        return;
      }
      writeItem(STORAGE.nextCheckAt, String(now + RENEWAL_RETRY_MS));
    } else if (!heartbeatDue()) {
      return;
    }
    try {
      await sendHeartbeat();
    } catch (err) {
      // Network error: try again at the next check. The TTL leaves room for this.
      console.warn("Session heartbeat failed.", err);
    }
  });
}

function checkIntervalMs() {
  if (getConfig().heartbeatMode === "activity") {
    if (!readItem(STORAGE.nextCheckAt)) {
      scheduleRenewalCheck();
    }
    const remaining = activityCheckAt() - Date.now();
    if (remaining <= 0 && !getConfig().degraded &&
        (!activitySinceExtension() || Date.now() >= idleBoundaries().warnAt)) {
      return MAX_CHECK_INTERVAL_MS;
    }
    return Math.max(1000, Math.min(MAX_CHECK_INTERVAL_MS, remaining));
  }
  const half = (getConfig().heartbeatIntervalSeconds * 1000) / 2;
  return Math.max(MIN_CHECK_INTERVAL_MS, Math.min(MAX_CHECK_INTERVAL_MS, half));
}

function scheduleRenewalCheck() {
  const config = getConfig();
  const due = renewalAt();
  const next = config.degraded || !due || !readItem(STORAGE.slotId)
    ? Date.now() + config.activityCheckSeconds * 1000
    : due;
  writeItem(STORAGE.nextCheckAt, String(next));
}

function scheduleNext() {
  if (!started) {
    return;
  }
  timerId = window.setTimeout(async () => {
    await tick();
    scheduleNext();
  }, checkIntervalMs());
}

// --- Open-tab registry: release the slot only when the last tab closes. ---

function readTabs() {
  return readJson(STORAGE.tabs) || {};
}

function touchTab() {
  const tabs = readTabs();
  tabs[TAB_ID] = Date.now();
  writeItem(STORAGE.tabs, JSON.stringify(tabs));
}

function removeTabAndCountOthers() {
  const tabs = readTabs();
  delete tabs[TAB_ID];
  const now = Date.now();
  for (const [id, seenAt] of Object.entries(tabs)) {
    if (now - seenAt > STALE_TAB_MS) {
      delete tabs[id]; // tab closed without notice, or frozen by the browser
    }
  }
  writeItem(STORAGE.tabs, JSON.stringify(tabs));
  return Object.keys(tabs).length;
}

function onVisibilityChange() {
  if (document.visibilityState === "visible") {
    onResume();
  }
}

function onResume() {
  evaluateIdle();
  if (started && !readItem(STORAGE.logout)) {
    void tick();
  }
}

function onStorage(event) {
  if (Object.values(STORAGE).includes(event.key)) {
    syncActivityListeners();
    evaluateIdle();
  }
}

function onPageHide() {
  const otherTabs = removeTabAndCountOthers();
  const config = getConfig();
  if (otherTabs > 0 || !config.enabled || !config.releaseOnClose) {
    return;
  }
  const slotId = readItem(STORAGE.slotId);
  if (!slotId) {
    return;
  }
  const body = new Blob([JSON.stringify({ browserId: getBrowserId(), slotId, reason: "close" })], { type: "application/json" });
  navigator.sendBeacon(`${API_BASE}/release`, body);
}

function onPageShow(event) {
  evaluateIdle();
  if (!started || readItem(STORAGE.logout)) {
    return;
  }
  if (event.persisted) {
    // Restored from the back/forward cache after pagehide may have released the slot.
    touchTab();
    recoverSession();
  }
}

export function startSessionKeepAlive() {
  if (started || !getConfig().enabled) {
    return;
  }
  started = true;
  touchTab();
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("focus", onResume);
  window.addEventListener("storage", onStorage);
  syncActivityListeners();
  evaluateIdle();
  scheduleNext();
}

export function stopSessionKeepAlive() {
  started = false;
  if (activityWriteTimerId !== null) {
    window.clearTimeout(activityWriteTimerId);
    activityWriteTimerId = null;
  }
  window.clearTimeout(idleTimerId);
  idleTimerId = null;
  warningLogoutAt = null;
  emit("idle-cleared");
  syncActivityListeners();
  if (timerId !== null) {
    window.clearTimeout(timerId);
    timerId = null;
  }
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("pagehide", onPageHide);
  window.removeEventListener("pageshow", onPageShow);
  window.removeEventListener("focus", onResume);
  window.removeEventListener("storage", onStorage);
}
