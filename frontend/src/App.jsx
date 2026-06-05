import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useEffect, useState } from "react";
import { apiGet } from "./apiClient";
import HomePage from "./pages/HomePage";
import FilesPage from "./pages/FilesPage";
import PowerBIPage from "./pages/PowerBIPage";

export default function App() {
  const [checkingSession, setCheckingSession] = useState(true);
  const [sessionReady, setSessionReady] = useState(false);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const profileData = await apiGet("/api/profile");
        if (mounted) {
          setProfile(profileData);
          setSessionReady(true);
        }
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
  }, []);

  const handleSignOut = () => {
    window.location.href = "/.auth/logout";
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
          <h2>Authentication Required</h2>
          <p>{error || "Your SWA session is not ready."}</p>
          <div className="actions">
            <button className="btn" onClick={() => (window.location.href = "/.auth/login/aad?post_login_redirect_uri=/")}>Sign In</button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="shell app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Fabric Analytics Hub</p>
          <h1 className="app-title">External Analytics Portal</h1>
        </div>
        <div className="user-menu">
          <span className="user-name">{profile?.user || "Unknown User"}</span>
          <button className="btn btn-icon" onClick={handleSignOut} title="Sign out">↗</button>
        </div>
      </header>

      <nav className="card top-nav" aria-label="Main navigation">
        <NavLink to="/" className={({ isActive }) => `nav-pill ${isActive ? "active" : ""}`}>Overview</NavLink>
        <NavLink to="/files" className={({ isActive }) => `nav-pill ${isActive ? "active" : ""}`}>Lakehouse Files</NavLink>
        <NavLink to="/powerbi" className={({ isActive }) => `nav-pill ${isActive ? "active" : ""}`}>Power BI Reports</NavLink>
      </nav>

      <Routes>
        <Route path="/" element={<HomePage user={profile?.user || "-"} />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/powerbi" element={<PowerBIPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </main>
  );
}
