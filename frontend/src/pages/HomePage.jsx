import { Link } from "react-router-dom";

export default function HomePage({ user }) {
  return (
    <>
      <section className="card hero-card">
        <div>
          <p className="eyebrow">Tenant-Aware Analytics</p>
          <h2>Welcome, {user}</h2>
          <p className="sub">
            This portal combines OneLake file operations and Power BI Embedded reports with a single SWA authentication flow.
          </p>
        </div>
      </section>

      <section className="card module-grid">
        <article className="module-card">
          <h3>Lakehouse File Management</h3>
          <p>Browse tenant-scoped folders, upload files, bulk download as ZIP, and safely delete content under OneLake permissions.</p>
          <Link className="btn" to="/files">Open File Workspace</Link>
        </article>

        <article className="module-card">
          <h3>Power BI Embedded</h3>
          <p>Select a report and load it with App Owned Data embedding through backend-generated embed tokens.</p>
          <Link className="btn" to="/powerbi">Open Report Workspace</Link>
        </article>
      </section>
    </>
  );
}
