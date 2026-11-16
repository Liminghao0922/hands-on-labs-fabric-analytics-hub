import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getSessionInfo, markActivity, onSessionEvent } from "../sessionClient";

export default function SessionIdleWarning() {
  const [logoutAt, setLogoutAt] = useState(() => getSessionInfo().logoutAt);
  const [now, setNow] = useState(Date.now);
  const buttonRef = useRef(null);

  useEffect(() => {
    const offWarning = onSessionEvent("idle-warning", (event) => {
      setNow(Date.now());
      setLogoutAt(event.detail.logoutAt);
    });
    const clear = () => setLogoutAt(null);
    const offCleared = onSessionEvent("idle-cleared", clear);
    const offLogout = onSessionEvent("logged-out", clear);
    return () => {
      offWarning();
      offCleared();
      offLogout();
    };
  }, []);

  useEffect(() => {
    if (!logoutAt) {
      return;
    }
    const previousTitle = document.title;
    const previousFocus = document.activeElement;
    document.title = `【まもなくログアウト】${previousTitle}`;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    buttonRef.current?.focus();
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => {
      window.clearInterval(timer);
      document.title = previousTitle;
      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }
    };
  }, [logoutAt]);

  if (!logoutAt) {
    return null;
  }
  const seconds = Math.max(0, Math.ceil((logoutAt - now) / 1000));
  return createPortal(
    <div className="session-idle-overlay">
      <section
        className="card session-idle-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-idle-title"
        aria-describedby="session-idle-description"
      >
        <h2 id="session-idle-title">まもなくログアウトします</h2>
        <p id="session-idle-description">
          一定時間操作がなかったため、あと {seconds} 秒で自動的にログアウトします。
        </p>
        <button ref={buttonRef} className="btn" onClick={() => markActivity("continue")}>
          操作を続ける
        </button>
      </section>
    </div>,
    document.body
  );
}
