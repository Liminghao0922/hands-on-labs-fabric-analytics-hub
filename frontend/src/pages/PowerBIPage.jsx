import { useEffect, useRef, useState } from "react";
import * as pbi from "powerbi-client";
import { apiGet, apiPost } from "../apiClient";

export default function PowerBIPage() {
  const reportContainerRef = useRef(null);
  const powerbiServiceRef = useRef(null);
  const embeddedReportRef = useRef(null);

  const [reports, setReports] = useState([]);
  const [selectedReportId, setSelectedReportId] = useState("");
  const [loadingReports, setLoadingReports] = useState(true);
  const [loadingEmbed, setLoadingEmbed] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const response = await apiGet("/api/reports");
        if (!mounted) {
          return;
        }

        const reportList = response.reports || [];
        setReports(reportList);
        if (reportList.length > 0) {
          setSelectedReportId(reportList[0].id);
        }
      } catch (err) {
        if (mounted) {
          setError(err.message || "Failed to load Power BI reports.");
        }
      } finally {
        if (mounted) {
          setLoadingReports(false);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedReportId) {
      return;
    }

    let mounted = true;

    const loadEmbed = async () => {
      setLoadingEmbed(true);
      setError("");

      try {
        const embedConfig = await apiPost("/api/reports/embed", { reportId: selectedReportId });
        if (!mounted) {
          return;
        }

        if (!powerbiServiceRef.current) {
          powerbiServiceRef.current = new pbi.service.Service(
            pbi.factories.hpmFactory,
            pbi.factories.wpmpFactory,
            pbi.factories.routerFactory
          );
        }

        const targetContainer = reportContainerRef.current;
        if (!targetContainer) {
          return;
        }

        try {
          powerbiServiceRef.current.reset(targetContainer);
        } catch {
          // no-op
        }

        const reportConfig = {
          type: "report",
          tokenType: pbi.models.TokenType.Embed,
          accessToken: embedConfig.token,
          embedUrl: embedConfig.embedUrl,
          id: embedConfig.reportId,
          permissions: pbi.models.Permissions.Read,
          settings: {
            panes: {
              filters: { expanded: false, visible: true },
              pageNavigation: { visible: true },
            },
            background: pbi.models.BackgroundType.Transparent,
          },
        };

        const embeddedReport = powerbiServiceRef.current.embed(targetContainer, reportConfig);
        embeddedReportRef.current = embeddedReport;

        embeddedReport.on("loaded", () => {
          if (mounted) {
            setLoadingEmbed(false);
          }
        });

        embeddedReport.on("error", (event) => {
          if (mounted) {
            setError(event?.detail?.message || "Failed to load embedded report.");
            setLoadingEmbed(false);
          }
        });
      } catch (err) {
        if (mounted) {
          setError(err.message || "Failed to generate embed configuration.");
          setLoadingEmbed(false);
        }
      }
    };

    loadEmbed();

    return () => {
      mounted = false;
      if (powerbiServiceRef.current && reportContainerRef.current) {
        try {
          powerbiServiceRef.current.reset(reportContainerRef.current);
        } catch {
          // no-op
        }
      }
      embeddedReportRef.current = null;
    };
  }, [selectedReportId]);

  const handleReportChange = (event) => {
    setSelectedReportId(event.target.value);
  };

  const handleRefresh = async () => {
    try {
      await embeddedReportRef.current?.refresh();
    } catch (err) {
      setError(err.message || "Failed to refresh report.");
    }
  };

  if (loadingReports) {
    return (
      <section className="card centered-card">
        <div className="spinner"></div>
        <p>Loading available Power BI reports...</p>
      </section>
    );
  }

  return (
    <>
      <section className="card panel-head-card">
        <div>
          <h2>Power BI Reports</h2>
          <p className="sub">App Owned Data embedding powered by backend-generated tokens.</p>
        </div>

        <div className="actions">
          <select className="picker" value={selectedReportId} onChange={handleReportChange} disabled={reports.length === 0}>
            {reports.length === 0 ? (
              <option value="">No report available</option>
            ) : (
              reports.map((report) => (
                <option key={report.id} value={report.id}>
                  {report.name}
                </option>
              ))
            )}
          </select>
          <button className="btn btn-ghost" onClick={handleRefresh} disabled={!selectedReportId}>Refresh</button>
          <button className="btn btn-ghost" onClick={() => embeddedReportRef.current?.fullscreen()} disabled={!selectedReportId}>Fullscreen</button>
        </div>
      </section>

      <section className="card">
        {loadingEmbed && (
          <div className="loading-container section-center">
            <div className="spinner"></div>
            <span>Embedding report...</span>
          </div>
        )}

        {!selectedReportId && !error && <p className="hint">No Power BI report is currently available for this account.</p>}

        {error && <div className="card error">{error}</div>}

        <div
          ref={reportContainerRef}
          className="report-frame"
          style={{ display: loadingEmbed || error || !selectedReportId ? "none" : "block" }}
        />
      </section>
    </>
  );
}
