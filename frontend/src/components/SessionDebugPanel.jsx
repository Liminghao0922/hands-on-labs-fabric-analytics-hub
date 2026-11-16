import { useEffect, useRef, useState } from "react";
import { getSessionDebugInfo, onSessionEvent } from "../sessionClient";

const MAX_EVENTS = 20;

function formatTime(at) {
  return at ? new Date(at).toLocaleString("ja-JP", { hour12: false }) : "-";
}

function deadline(at, now) {
  return at ? `${formatTime(at)} (${Math.max(0, Math.ceil((at - now) / 1000))}s remaining)` : "-";
}

function effect(entry) {
  if (entry.type === "extended") {
    return "Server TTL refreshed; last activity unchanged";
  }
  if (entry.type !== "activity") {
    return entry.type;
  }
  if (!entry.accepted) {
    return `Ignored: ${entry.reason}`;
  }
  const delta = Math.max(0, (entry.warnAt - entry.previousWarnAt) / 1000);
  return delta > 0 ? `Idle deadline +${delta.toFixed(1)}s` : "Activity recorded; same deadline";
}

export default function SessionDebugPanel() {
  const [snapshot, setSnapshot] = useState(getSessionDebugInfo);
  const [recent, setRecent] = useState([]);
  const history = useRef([]);

  useEffect(() => {
    const unsubscribe = ["activity", "extended", "idle-warning", "idle-cleared", "logged-out"].map((type) =>
      onSessionEvent(type, (event) => {
        history.current = [
          { ...event.detail, type, at: event.detail?.at ?? Date.now() },
          ...history.current,
        ].slice(0, MAX_EVENTS);
      })
    );
    const timer = window.setInterval(() => {
      setSnapshot(getSessionDebugInfo());
      setRecent([...history.current]);
    }, 1000);
    return () => {
      window.clearInterval(timer);
      unsubscribe.forEach((off) => off());
    };
  }, []);

  const lastEvent = recent.find((entry) => entry.type === "activity");
  const fields = [
    ["Slot", snapshot.slotId || "-"],
    ["Mode / state", `${snapshot.heartbeatMode} / ${snapshot.degraded ? "degraded" : snapshot.active ? "active" : "inactive"}`],
    ["Server expiry", deadline(snapshot.expiresAtMs, snapshot.now)],
    ["Server renewal due", deadline(snapshot.renewAt, snapshot.now)],
    ["Next renewal / retry", deadline(snapshot.nextCheckAt, snapshot.now)],
    ["Renewal state", snapshot.renewalState],
    ["Idle warning at", deadline(snapshot.warnAt, snapshot.now)],
    ["Auto logout at", deadline(snapshot.logoutAt, snapshot.now)],
    ["Last activity (all tabs)", formatTime(snapshot.lastActivityAt)],
    ["Last event (this tab)", lastEvent
      ? `${lastEvent.source}${lastEvent.visualType ? ` (${lastEvent.visualType})` : ""} / ${lastEvent.accepted ? "accepted" : `ignored: ${lastEvent.reason}`}`
      : "-"],
    ["Last extension (all tabs)", formatTime(snapshot.lastExtendedAt)],
    ["Warning visible", snapshot.warningVisible ? "yes" : "no"],
  ];

  return (
    <details className="card session-debug" open>
      <summary>Session debug</summary>
      <p className="hint">
        Local diagnostics only, refreshed every second. No API polling. Times use this browser&apos;s local time zone.
      </p>
      <dl className="session-debug-fields">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>Recent events in this tab ({recent.length}/{MAX_EVENTS})</summary>
        <div className="session-debug-events">
          <table>
            <thead>
              <tr><th>Time</th><th>Event / visual type</th><th>Effect</th><th>Warning / logout after event</th></tr>
            </thead>
            <tbody>
              {recent.map((entry, index) => (
                <tr key={`${entry.at}-${index}`}>
                  <td>{formatTime(entry.at)}</td>
                  <td>{entry.source || entry.type}{entry.visualType ? ` (${entry.visualType})` : ""}</td>
                  <td>{effect(entry)}</td>
                  <td>{formatTime(entry.warnAt)} / {formatTime(entry.logoutAt)}</td>
                </tr>
              ))}
              {!recent.length && <tr><td colSpan={4}>Operate the page or report to see events here.</td></tr>}
            </tbody>
          </table>
        </div>
      </details>
      <p className="hint">
        Idle logout = last activity + {snapshot.ttlSeconds}s TTL. Warning starts {snapshot.warningSeconds}s before logout.
        Server renewal = server expiry - {snapshot.renewalMarginSeconds}s margin, only with activity.
        Renewing the server does not reset the idle clock.
        Initial Power BI pageChanged events are ignored; scrolling inside the report iframe cannot be detected.
      </p>
    </details>
  );
}
