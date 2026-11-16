import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "./apiClient";
import {
  acquireSession,
  getSessionInfo,
  onSessionEvent,
  navigateToLogout,
  releaseSession,
  startSessionKeepAlive,
  stopSessionKeepAlive,
} from "./sessionClient";
import HomePage from "./pages/HomePage";
import FilesPage from "./pages/FilesPage";
import PowerBIPage from "./pages/PowerBIPage";
import SessionIdleWarning from "./components/SessionIdleWarning";
import SessionDebugPanel from "./components/SessionDebugPanel";

export default function App() {
  const location = useLocation();
  const debugEnabled = import.meta.env.DEV || new URLSearchParams(location.search).get("sessionDebug") === "1";
  const debugSearch = debugEnabled ? "?sessionDebug=1" : "";
  const signInUrl = `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(`/${debugSearch}`)}`;
  const idleLogoutNotice = new URLSearchParams(window.location.search).get("reason") === "idle";
  const idleLogoutLanding = window.location.pathname === "/session-logged-out";
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionReady, setSessionReady] = useState(false);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");
  // Concurrent session control: "pending" | "active" | "disabled" | "limit" | "error"
  const [seatState, setSeatState] = useState("pending");
  const [seatInfo, setSeatInfo] = useState(null);
  const [seatError, setSeatError] = useState("");

  const requestSeat = useCallback(async () => {
    setSeatError("");
    try {
      const result = await acquireSession();
      setSeatInfo(result.data || null);
      if (result.status === "active") {
        startSessionKeepAlive();
      }
      setSeatState(result.status);
    } catch (err) {
      setSeatError(err.message || "Failed to start a session.");
      setSeatState("error");
    }
  }, []);

  useEffect(() => {
    if (idleLogoutLanding) {
      setCheckingSession(false);
      return;
    }
    let mounted = true;

    (async () => {
      try {
        const profileData = await apiGet("/api/profile");
        if (mounted) {
          setProfile(profileData);
          setSessionReady(true);
        }
        await requestSeat();
      } catch (err) {
        if (mounted) {
          setSessionReady(false);
          setError(err.message || "Failed to validate session.");
        }
      } finally {
        if (mounted) {
          setCheckingSession(false);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [requestSeat, idleLogoutLanding]);

  // The session can be lost later (e.g. after sleep) and the limit reached when re-acquiring.
  useEffect(() => {
    const offLimit = onSessionEvent("limit", (event) => {
      setSeatInfo(event.detail || null);
      setSeatState("limit");
    });
    const offActive = onSessionEvent("active", (event) => {
      setSeatInfo(event.detail || null);
      setSeatState("active");
    });
    const offDisabled = onSessionEvent("disabled", () => setSeatState("disabled"));
    const offLogout = onSessionEvent("logged-out", () => {
      setSessionReady(false);
      setSeatState("pending");
    });
    return () => {
      offLimit();
      offActive();
      offDisabled();
      offLogout();
      stopSessionKeepAlive();
    };
  }, []);

  const handleSignOut = async () => {
    await releaseSession();
    navigateToLogout();
  };

  if (checkingSession) {
    return (
      <main className="shell">
        <section className="card centered-card">
          <div className="spinner"></div>
          <p>Checking session...</p>
        </section>
      </main>
    );
  }

  if (!sessionReady) {
    return (
      <main className="shell">
        <section className="card error">
          <h2>{idleLogoutLanding ? "ログアウトしました" : "Authentication Required"}</h2>
          {idleLogoutNotice && <p role="status">無操作のため自動的にログアウトしました。</p>}
          {!idleLogoutLanding && <p>{error || "Your SWA session is not ready."}</p>}
          <div className="actions">
            <button className="btn" onClick={() => (window.location.href = signInUrl)}>Sign In</button>
          </div>
        </section>
      </main>
    );
  }

  if (seatState === "limit" || seatState === "error") {
    const max = seatInfo?.maxSessions;
    return (
      <main className="shell">
        <section className="card error">
          <h2>{seatState === "limit" ? "Concurrent Session Limit Reached" : "Session Error"}</h2>
          <p>
            {seatState === "limit"
              ? `All ${max ?? ""} concurrent sessions are currently in use. Please try again later.`
              : seatError}
          </p>
          <div className="actions">
            <button className="btn" onClick={requestSeat}>Retry</button>
            <button className="btn btn-ghost" onClick={handleSignOut}>Sign Out</button>
          </div>
        </section>
      </main>
    );
  }

  const session = getSessionInfo();
  const sessionTitle =
    seatState === "active"
      ? `Session ${session.slotId || "-"} / ${session.heartbeatMode === "activity"
          ? `activity renewal at expiry - ${session.renewalMarginSeconds}s`
          : `heartbeat ${session.heartbeatIntervalSeconds}s`} / TTL ${session.ttlSeconds}s`
      : "Session control is disabled";

  return (
    <main className="shell app-shell">
      {idleLogoutNotice && <section className="card" role="status">無操作のため自動的にログアウトしました。</section>}
      {seatState === "active" && <SessionIdleWarning />}
      <header className="app-header">
        <div>
          <p className="eyebrow">Fabric Analytics Hub</p>
          <h1 className="app-title">External Analytics Portal</h1>
        </div>
        <div className="user-menu">
          <span className="user-name">{profile?.user || "Unknown User"}</span>
          <span className="user-name" title={sessionTitle}>{seatState === "active" ? "● Session active" : ""}</span>
          <button className="btn btn-icon" onClick={handleSignOut} title="Sign out">↗</button>
        </div>
      </header>

      <nav className="card top-nav" aria-label="Main navigation">
        <NavLink to={{ pathname: "/", search: debugSearch }} className={({ isActive }) => `nav-pill ${isActive ? "active" : ""}`}>Overview</NavLink>
        <NavLink to={{ pathname: "/files", search: debugSearch }} className={({ isActive }) => `nav-pill ${isActive ? "active" : ""}`}>Lakehouse Files</NavLink>
        <NavLink to={{ pathname: "/powerbi", search: debugSearch }} className={({ isActive }) => `nav-pill ${isActive ? "active" : ""}`}>Power BI Reports</NavLink>
      </nav>

      {debugEnabled && <SessionDebugPanel />}

      <Routes>
        <Route path="/" element={<HomePage user={profile?.user || "-"} debugSearch={debugSearch} />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/powerbi" element={<PowerBIPage />} />
        <Route path="*" element={<Navigate to={{ pathname: "/", search: debugSearch }} replace />} />
      </Routes>
    </main>
  );
}
