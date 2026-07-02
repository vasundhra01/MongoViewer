import { useState, useEffect, useRef } from "react"; //react hooks
import * as XLSX from "xlsx";

const API = "http://localhost:8080";
const CHUNK = 100;

const c = {
  bg: "#FAFAF7",
  surface: "#ffffff",
  surfaceAlt: "#ebeae6",
  ink: "#1C1E26",
  muted: "#676a70",
  faint: "#696b71",
  line: "#E6E4DD",
  lineStrong: "#D8D5CC",
  accent: "#6C5CE7",
  accentDark: "#584AC9",
  accentDim: "#EFEDFC",
  success: "#1a7a4d",
  successDim: "#badbca",
  danger: "#C74C4C",
  dangerDim: "#e4c4c4",
};

const sans = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
const mono = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const GlobalStyle = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

    .mv-select, .mv-input, .mv-btn, .mv-pill {
      transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease, transform 80ms ease;
    }
    .mv-select:hover, .mv-input:hover { border-color: ${c.lineStrong}; }
    .mv-select:focus-visible, .mv-input:focus-visible, .mv-btn:focus-visible {
      outline: 2px solid ${c.accent};
      outline-offset: 1px;
    }
    .mv-btn:hover { filter: brightness(0.96); }
    .mv-btn:active { transform: translateY(1px); }
    .mv-pill:hover { border-color: ${c.accent}; }
    .mv-row:hover { background: ${c.surfaceAlt} !important; }

    @keyframes mv-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(108,92,231,0.45); }
      70%  { box-shadow: 0 0 0 6px rgba(108,92,231,0); }
      100% { box-shadow: 0 0 0 0 rgba(108,92,231,0); }
    }
    .mv-dot-live { animation: mv-pulse 1.6s ease-out infinite; }

    ::selection { background: ${c.accentDim}; color: ${c.ink}; }

    @media (prefers-reduced-motion: reduce) {
      .mv-select, .mv-input, .mv-btn, .mv-pill { transition: none; }
      .mv-dot-live { animation: none; }
    }
  `}</style>
);

// Converts a <input type="datetime-local"> value (e.g. "2026-06-19T17:01"),
// which carries NO timezone info and represents the browser's LOCAL
// wall-clock time, into a real UTC ISO-8601 string the backend can parse
// unambiguously (e.g. "2026-06-19T11:31:00.000Z" for a browser in IST).
//
// `new Date("2026-06-19T17:01")` is interpreted by the JS engine as local
// time, so `.toISOString()` yields the correct UTC instant. Previously the
// raw local string was sent straight to the backend, which assumed it was
// already UTC — silently shifting every time-range query by the browser's
// UTC offset (5.5h for IST) and making the filter appear to return nothing.
function localDateTimeToUTCISO(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toISOString();
}

export default function App() {
  const [collections, setCollections] = useState([]);
  const [selected, setSelected]       = useState("");
  const [rows, setRows]               = useState([]);
  const [columns, setColumns]         = useState([]);
  const [loading, setLoading]         = useState(false);
  const [done, setDone]               = useState(false);
  const [error, setError]             = useState("");
  const [sort, setSort]               = useState({ col: null, dir: "asc" });
  const [filters, setFilters]         = useState({});
  const [page, setPage]               = useState(1); // 1-indexed current page
  const [tagNames, setTagNames]       = useState({}); // tag_id -> human name, from /api/tags

  // ── Device id filter (pushed down to the backend/Mongo, not filtered in JS) ──
  const [deviceCol, setDeviceCol]           = useState("");  // auto-detected device id column
  const [selectedDevice, setSelectedDevice] = useState(""); // "" = all devices
  const [deviceOptions, setDeviceOptions]   = useState([]); // full distinct list from /api/distinct

  // ── Filter panel (applied only on Execute) ──
  const [pendingTags, setPendingTags] = useState(new Set()); // columns toggled but not yet applied
  const [appliedTags, setAppliedTags] = useState(new Set()); // columns actively filtering
  const [pendingFrom, setPendingFrom] = useState("");        // datetime-local string (LOCAL time, as typed)
  const [pendingTo,   setPendingTo]   = useState("");
  const [appliedFrom, setAppliedFrom] = useState("");
  const [appliedTo,   setAppliedTo]   = useState("");
  const [timeCol,     setTimeCol]     = useState("");        // which column to time-filter on

  // All mutable fetch state lives in refs — never causes re-renders
  const skipRef       = useRef(0);
  const colsLockedRef = useRef(false);
  const doneRef       = useRef(false);
  const loadingRef    = useRef(false);
  const selectedRef   = useRef("");
  const runTokenRef   = useRef(0);
  const deviceFilterRef = useRef({ field: "", value: "" }); // device filter applied to /api/items calls
  const activeFilterRef = useRef({ timeField: "", fromTime: "", toTime: "", tagFields: "" }); // tags/time filter applied to /api/items calls

  useEffect(() => {
    fetch(`${API}/api/collections`)
      .then(r => r.json())
      .then(d => setCollections(d.collections || []))
      .catch(() => setError("Cannot reach backend. Is Go server running on :8080?"));

    fetch(`${API}/api/tags`)
      .then(r => r.json())
      .then(d => setTagNames(d.tags || {}))
      .catch(() => {}); // tag names are a nice-to-have; silently fall back to raw ids
  }, []);

  // ── Single fetch function — reads from refs, writes to refs + state ──
  async function fetchBatch(token) {
    // If a newer run has started (collection changed again), abandon this chain
    if (token !== runTokenRef.current) return;
    if (loadingRef.current || doneRef.current) return;
    const col = selectedRef.current;
    if (!col) return;

    loadingRef.current = true;
    setLoading(true);

    try {
      let url = `${API}/api/items?collection=${col}&skip=${skipRef.current}`;

      const { field, value } = deviceFilterRef.current;
      if (field && value) {
        url += `&filterField=${encodeURIComponent(field)}&filterValue=${encodeURIComponent(value)}`;
      }

      const { timeField, fromTime, toTime, tagFields } = activeFilterRef.current;
      if (timeField && (fromTime || toTime)) {
        url += `&timeField=${encodeURIComponent(timeField)}`;
        if (fromTime) url += `&fromTime=${encodeURIComponent(fromTime)}`;
        if (toTime) url += `&toTime=${encodeURIComponent(toTime)}`;
      }
      if (tagFields) {
        url += `&tagFields=${encodeURIComponent(tagFields)}`;
      }

      const res = await fetch(url);

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Server returned ${res.status}: ${errText}`);
      }

      const data = await res.json();

      // Guard: stale chain (collection changed, or StrictMode double-run)
      if (token !== runTokenRef.current || selectedRef.current !== col) return;

      const newItems = data.items || [];
      const more      = !!data.hasMore;
      const nextSkip  = typeof data.nextSkip === "number" ? data.nextSkip : skipRef.current + newItems.length;

      setRows(prev => [...prev, ...newItems]);

      if (!colsLockedRef.current && data.keys?.length) {
        setColumns(data.keys);
        colsLockedRef.current = true;
      }

      skipRef.current = nextSkip;

      if (!more) {
        doneRef.current = true;
        setDone(true);
      } else {
        // Schedule next batch — plain timeout, no state involved
        setTimeout(() => fetchBatch(token), 250);
      }
    } catch (e) {
      if (token === runTokenRef.current) setError("Fetch failed: " + e.message);
    } finally {
      if (token === runTokenRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }

  // ── Shared helper: reset pagination state and start a fresh backend fetch
  // chain (used whenever a server-side filter changes — device, tags, time) ──
  function restartFetch() {
    runTokenRef.current += 1;
    const myToken = runTokenRef.current;

    setRows([]);
    setDone(false);
    setLoading(false);
    setPage(1);

    skipRef.current    = 0;
    doneRef.current    = false;
    loadingRef.current = false;

    const t = setTimeout(() => fetchBatch(myToken), 50);
    return () => clearTimeout(t);
  }

  // ── Reset + kick first fetch when collection changes ──
  useEffect(() => {
    if (!selected) return;

    // Bump the run token — any in-flight fetchBatch from a previous
    // (possibly duplicate, e.g. StrictMode) effect run will see a
    // mismatched token and stop itself instead of continuing.
    runTokenRef.current += 1;
    const myToken = runTokenRef.current;

    // Reset all state
    setRows([]);
    setColumns([]);
    setFilters({});
    setSort({ col: null, dir: "asc" });
    setError("");
    setDone(false);
    setLoading(false);
    setPage(1);
    setPendingTags(new Set());
    setAppliedTags(new Set());
    setPendingFrom("");
    setPendingTo("");
    setAppliedFrom("");
    setAppliedTo("");
    setTimeCol("");
    setDeviceCol("");
    setSelectedDevice("");
    setDeviceOptions([]);

    // Reset all refs
    skipRef.current        = 0;
    colsLockedRef.current = false;
    doneRef.current       = false;
    loadingRef.current    = false;
    selectedRef.current   = selected;
    deviceFilterRef.current = { field: "", value: "" };
    activeFilterRef.current = { timeField: "", fromTime: "", toTime: "", tagFields: "" };

    // Kick first fetch after reset settles
    const t = setTimeout(() => fetchBatch(myToken), 50);
    return () => clearTimeout(t);
  }, [selected]);

  // Auto-detect the first datetime column and use it as the default time filter target
  useEffect(() => {
    if (columns.length === 0 || rows.length === 0) return;
    if (timeCol) return; // already set
    const firstDateCol = columns.find(col => {
      const sample = rows[0]?.[col];
      return typeof sample === "string" && /^\d{4}-\d{2}-\d{2}T/.test(sample);
    });
    if (firstDateCol) setTimeCol(firstDateCol);
  }, [columns, rows]);

  // Auto-detect a device id column (e.g. "device_id", "deviceId", "DeviceID")
  useEffect(() => {
    if (columns.length === 0) return;
    if (deviceCol) return; // already set
    const candidate = columns.find(col => /device/i.test(col) && /id/i.test(col));
    if (candidate) setDeviceCol(candidate);
  }, [columns, deviceCol]);

  // Once we know which column is the device id, ask the backend for every
  // distinct value in the whole collection (via Mongo's distinct()) — this
  // is cheap for Mongo to compute and means the dropdown shows every device
  // that exists, not just the ones loaded into the browser so far.
  useEffect(() => {
    if (!selected || !deviceCol) return;
    fetch(`${API}/api/distinct?collection=${selected}&field=${encodeURIComponent(deviceCol)}`)
      .then(r => r.json())
      .then(d => setDeviceOptions(d.values || []))
      .catch(() => {}); // non-fatal — dropdown just won't populate
  }, [selected, deviceCol]);

  // When the user picks a device, push that filter down to the backend and
  // re-fetch from scratch (skip=0) instead of filtering the rows already in
  // the browser. This means: query goes to Mongo with {deviceCol: value},
  // so only matching documents ever cross the wire.
  useEffect(() => {
    if (!selected) return;

    const field = selectedDevice ? deviceCol : "";
    const value = selectedDevice || "";

    // No real change (e.g. this fired right after the collection-change
    // effect already reset the filter to the same empty state) — skip.
    if (deviceFilterRef.current.field === field && deviceFilterRef.current.value === value) {
      return;
    }
    deviceFilterRef.current = { field, value };

    return restartFetch();
  }, [selected, selectedDevice, deviceCol]);

  // ── Sort ──
  const handleSort = (col) => {
    setPage(1);
    setSort(prev => ({
      col,
      dir: prev.col === col && prev.dir === "asc" ? "desc" : "asc"
    }));
  };

  // ── Filter ──
  const handleFilter = (col, val) => {
    setPage(1);
    setFilters(prev => ({ ...prev, [col]: val }));
  };

  // ── Derived rows ──
  const displayRows = (() => {
    let result = [...rows];

    // column text filters (live)
    Object.entries(filters).forEach(([col, val]) => {
      if (!val) return;
      const lower = val.toLowerCase();
      result = result.filter(row => {
        const cell = row[col];
        if (cell === null || cell === undefined) return false;
        return String(typeof cell === "object" ? JSON.stringify(cell) : cell)
          .toLowerCase().includes(lower);
      });
    });

    if (sort.col) {
      result.sort((a, b) => {
        const av = a[sort.col] ?? "", bv = b[sort.col] ?? "";
        const an = Number(av), bn = Number(bv);
        const cmp = !isNaN(an) && !isNaN(bn) && av !== "" && bv !== ""
          ? an - bn
          : String(av).localeCompare(String(bv));
        return sort.dir === "asc" ? cmp : -cmp;
      });
    }
    return result;
  })();

  const activeFilters = Object.values(filters).filter(Boolean).length;

  // ── raw_readings.* column labeling ──
  const RAW_PREFIX = "raw_readings.";
  const colLabel = (col) => {
    if (col.startsWith(RAW_PREFIX)) {
      const tagId = col.slice(RAW_PREFIX.length);
      return tagNames[tagId] || tagId;
    }
    return col;
  };
  const rawReadingCols = columns.filter(c => c.startsWith(RAW_PREFIX));

  // Visible columns: hide raw_readings.* cols not in appliedTags (if any tags are applied)
  const visibleColumns = appliedTags.size > 0
    ? columns.filter(c => !c.startsWith(RAW_PREFIX) || appliedTags.has(c))
    : columns;

  // Detect available datetime columns for the time-filter dropdown
  const datetimeCols = columns.filter(col => {
    const sample = rows[0]?.[col];
    return typeof sample === "string" && /^\d{4}-\d{2}-\d{2}T/.test(sample);
  });

  // ── Execute: commit pending filter panel state and re-query the backend ──
  const handleExecute = () => {
    setAppliedTags(new Set(pendingTags));
    setAppliedFrom(pendingFrom);
    setAppliedTo(pendingTo);
    setPage(1);

    // Convert the local datetime-local values to UTC ISO strings before
    // sending — the backend expects an unambiguous, timezone-aware
    // timestamp. Sending the raw local string here was the root cause of
    // the time filter appearing to return nothing (see localDateTimeToUTCISO).
    activeFilterRef.current = {
      timeField: timeCol,
      fromTime: localDateTimeToUTCISO(pendingFrom),
      toTime: localDateTimeToUTCISO(pendingTo),
      tagFields: Array.from(pendingTags).join(","),
    };
    restartFetch();
  };

  const handleClearFilters = () => {
    setPendingTags(new Set());
    setAppliedTags(new Set());
    setPendingFrom("");
    setPendingTo("");
    setAppliedFrom("");
    setAppliedTo("");
    setPage(1);

    activeFilterRef.current = { timeField: "", fromTime: "", toTime: "", tagFields: "" };
    restartFetch();
  };

  const filtersApplied = appliedTags.size > 0 || appliedFrom || appliedTo;

  // ── Pagination: split displayRows into CHUNK-sized pages ──
  const totalPages = Math.max(1, Math.ceil(displayRows.length / CHUNK));
  const currentPage = Math.min(page, totalPages);
  const pageRows = displayRows.slice((currentPage - 1) * CHUNK, currentPage * CHUNK);
  if (currentPage !== page) {
    // displayRows shrank (filter applied) — snap back to last valid page
    setTimeout(() => setPage(currentPage), 0);
  }

  const downloadExcel = () => {
    const data = displayRows.map(row =>
      Object.fromEntries(visibleColumns.map(col => {
        const val = row[col];
        return [colLabel(col), val === null || val === undefined ? "" : typeof val === "object" ? JSON.stringify(val) : val];
      }))
    );
    const ws = XLSX.utils.json_to_sheet(data, { header: visibleColumns.map(colLabel) });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, selected);
    XLSX.writeFile(wb, `${selected}.xlsx`);
  };

  const formatValue = (val) => {
    if (val === null || val === undefined) return <span style={{ color: c.faint }}>—</span>;
    if (typeof val === "object") return <span style={{ color: c.muted, fontSize: 11 }}>{JSON.stringify(val)}</span>;
    if (typeof val === "boolean") return (
      <span style={{
        color: val ? c.success : c.danger, fontWeight: 600,
        background: val ? c.successDim : c.dangerDim,
        padding: "1px 6px", borderRadius: 4, fontSize: 11,
      }}>{String(val)}</span>
    );
    return String(val);
  };

  // status: what the little indicator dot in the header communicates
  const status = error ? "error" : loading ? "loading" : done && rows.length > 0 ? "done" : "idle";
  const statusColor = { error: c.danger, loading: c.accent, done: c.success, idle: c.faint }[status];

  return (
    <div style={{ fontFamily: sans, background: c.bg, minHeight: "100vh", color: c.ink }}>
      <GlobalStyle />
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "40px 24px 64px" }}>

        {/* ── Header ── */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              className={status === "loading" ? "mv-dot-live" : ""}
              style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor, flexShrink: 0 }}
            />
            <h1 style={{ fontFamily: mono, fontSize: 15, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", margin: 0 }}>
              Mongo Viewer
            </h1>
          </div>
          <p style={{ fontFamily: mono, fontSize: 12, color: c.muted, margin: 0 }}>theiox_data · localhost:27017</p>
        </div>

        {/* ── Toolbar ── */}
        <div style={{
          display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap",
          background: c.surface, border: `1px solid ${c.line}`, borderRadius: 10, padding: "14px 16px",
        }}>
          <label style={labelStyle}>Collection</label>
          <select
            className="mv-select"
            value={selected}
            onChange={e => setSelected(e.target.value)}
            style={selectStyle(220)}
          >
            <option value="">— select a collection —</option>
            {collections.map(col => <option key={col} value={col}>{col}</option>)}
          </select>

          {deviceCol && (
            <>
              <label style={labelStyle}>Device</label>
              <select
                className="mv-select"
                value={selectedDevice}
                onChange={e => { setSelectedDevice(e.target.value); setPage(1); }}
                style={{ ...selectStyle(180), ...(selectedDevice ? activeFieldStyle : {}) }}
              >
                <option value="">All devices ({deviceOptions.length})</option>
                {deviceOptions.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </>
          )}

          {(rows.length > 0 || loading) && (
            <span style={{ fontFamily: mono, fontSize: 12, color: c.muted }}>
              {loading ? `loading… ${rows.length} rows` : `${rows.length} total · showing ${displayRows.length}`}
              {done && !loading && " · complete"}
            </span>
          )}

          {activeFilters > 0 && (
            <button className="mv-btn" onClick={() => setFilters({})} style={ghostDangerBtn}>
              clear {activeFilters} filter{activeFilters > 1 ? "s" : ""}
            </button>
          )}

          {rows.length > 0 && done && (
            <button className="mv-btn" onClick={downloadExcel} style={{ ...primaryBtn, marginLeft: "auto", background: c.success }}>
              Download .xlsx
            </button>
          )}
        </div>

        {/* ── Filter console (tags + time) ── */}
        {rawReadingCols.length > 0 && (
          <div style={{
            border: `1px solid ${c.line}`, borderRadius: 10, padding: "16px 18px", marginBottom: 16,
            background: c.surface,
          }}>
            <div style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", color: c.faint, textTransform: "uppercase", marginBottom: 14 }}>
              Filter Console
            </div>

            {/* Tags */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
              <span style={{ ...labelStyle, paddingTop: 5, minWidth: 44 }}>Tags</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, flex: 1 }}>
                {rawReadingCols.map(col => {
                  const active = pendingTags.has(col);
                  return (
                    <button
                      key={col}
                      className="mv-pill"
                      onClick={() => {
                        setPendingTags(prev => {
                          const next = new Set(prev);
                          active ? next.delete(col) : next.add(col);
                          return next;
                        });
                      }}
                      style={{
                        fontFamily: mono, fontSize: 11.5, padding: "4px 11px", borderRadius: 14, cursor: "pointer",
                        border: active ? `1px solid ${c.accent}` : `1px solid ${c.line}`,
                        background: active ? c.accent : c.surface,
                        color: active ? "#fff" : c.muted,
                        fontWeight: 500,
                      }}
                    >
                      {colLabel(col)}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: c.line, margin: "0 0 14px" }} />

            {/* Time */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ ...labelStyle, minWidth: 44 }}>Time</span>

              {datetimeCols.length > 1 && (
                <select
                  className="mv-select"
                  value={timeCol}
                  onChange={e => setTimeCol(e.target.value)}
                  style={selectStyle(140, true)}
                >
                  {datetimeCols.map(col => <option key={col} value={col}>{col}</option>)}
                </select>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={smallLabel}>from</span>
                <input
                  className="mv-input"
                  type="datetime-local"
                  value={pendingFrom}
                  onChange={e => setPendingFrom(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={smallLabel}>to</span>
                <input
                  className="mv-input"
                  type="datetime-local"
                  value={pendingTo}
                  onChange={e => setPendingTo(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <button className="mv-btn" onClick={handleExecute} style={primaryBtn}>
                Execute
              </button>

              {filtersApplied && (
                <button className="mv-btn" onClick={handleClearFilters} style={ghostDangerBtn}>
                  clear
                </button>
              )}

              {filtersApplied && (
                <span style={{ fontFamily: mono, fontSize: 11, color: c.accent }}>
                  {appliedTags.size > 0 && `${appliedTags.size} tag${appliedTags.size > 1 ? "s" : ""}`}
                  {appliedTags.size > 0 && (appliedFrom || appliedTo) && " · "}
                  {(appliedFrom || appliedTo) && "time range"}
                  {" · "}{displayRows.length} rows
                </span>
              )}
            </div>
          </div>
        )}

        {error && (
          <div style={{
            background: c.dangerDim, border: `1px solid #EFC9C9`, borderRadius: 8,
            padding: "10px 14px", fontSize: 13, color: c.danger, marginBottom: 16, fontFamily: mono,
          }}>
            {error}
          </div>
        )}

        {/* ── Table ── */}
        {selected && columns.length > 0 && (
          <div style={{ border: `1px solid ${c.line}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: mono, fontSize: 12.5 }}>
                <thead>
                  <tr style={{ background: c.surfaceAlt }}>
                    <th style={thStyle}>#</th>
                    {visibleColumns.map(col => (
                      <th key={col} style={{ ...thStyle, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort(col)}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          {colLabel(col)}
                          <span style={{ fontSize: 9, color: sort.col === col ? c.accent : c.faint }}>
                            {sort.col === col ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}
                          </span>
                        </div>
                      </th>
                    ))}
                  </tr>
                  <tr style={{ background: c.surface, borderBottom: `1px solid ${c.line}` }}>
                    <td style={{ padding: "6px 14px" }} />
                    {visibleColumns.map(col => (
                      <td key={col} style={{ padding: "5px 8px" }}>
                        <input
                          className="mv-input"
                          type="text"
                          placeholder="filter…"
                          value={filters[col] || ""}
                          onChange={e => handleFilter(col, e.target.value)}
                          style={{
                            width: "100%", padding: "4px 8px", fontSize: 11.5, fontFamily: mono,
                            border: filters[col] ? `1px solid ${c.accent}` : `1px solid ${c.line}`,
                            borderRadius: 5, outline: "none", boxSizing: "border-box",
                            background: filters[col] ? c.accentDim : c.surface,
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row, i) => (
                    <tr key={(currentPage - 1) * CHUNK + i} className="mv-row" style={{ borderTop: `1px solid ${c.line}` }}>
                      <td style={{ ...tdStyle, color: c.faint, userSelect: "none" }}>{(currentPage - 1) * CHUNK + i + 1}</td>
                      {visibleColumns.map(col => (
                        <td key={col} style={tdStyle}>{formatValue(row[col])}</td>
                      ))}
                    </tr>
                  ))}
                  {displayRows.length === 0 && !loading && (
                    <tr>
                      <td colSpan={visibleColumns.length + 1} style={{ padding: "48px", textAlign: "center", color: c.faint, fontSize: 12.5 }}>
                        no rows match the current filters
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
              padding: "10px 16px", borderTop: `1px solid ${c.line}`, background: c.surfaceAlt, flexWrap: "wrap",
            }}>
              <span style={{ fontFamily: mono, fontSize: 11.5, color: c.faint }}>
                {loading && <span>loading… {rows.length} fetched</span>}
                {!loading && done && <span>all {rows.length} rows loaded</span>}
                {!loading && !done && rows.length > 0 && <span>{rows.length} loaded…</span>}
              </span>

              {totalPages > 1 && (
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button className="mv-btn" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} style={pageBtnStyle(false, currentPage === 1)}>
                    ‹
                  </button>
                  {pageNumbersToShow(currentPage, totalPages).map((p, idx) =>
                    p === "…" ? (
                      <span key={`ellipsis-${idx}`} style={{ padding: "0 4px", color: c.faint, fontSize: 11.5, fontFamily: mono }}>…</span>
                    ) : (
                      <button key={p} className="mv-btn" onClick={() => setPage(p)} style={pageBtnStyle(p === currentPage, false)}>
                        {p}
                      </button>
                    )
                  )}
                  <button className="mv-btn" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} style={pageBtnStyle(false, currentPage === totalPages)}>
                    ›
                  </button>
                  <span style={{ fontFamily: mono, fontSize: 11, color: c.muted, marginLeft: 6 }}>
                    {currentPage} / {totalPages}{!done && " (growing)"}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {selected && !loading && rows.length === 0 && !error && columns.length === 0 && (
          <div style={{ textAlign: "center", padding: "72px 0", color: c.faint, fontSize: 13, fontFamily: mono }}>
            no documents found in <strong style={{ color: c.muted }}>{selected}</strong>
          </div>
        )}

        {!selected && (
          <div style={{ textAlign: "center", padding: "72px 0", color: c.faint, fontSize: 13, fontFamily: mono }}>
            select a collection above to view its data
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shared style fragments ──
const labelStyle = { fontFamily: mono, fontSize: 11, color: c.muted, fontWeight: 600, letterSpacing: "0.03em", textTransform: "uppercase" };
const smallLabel = { fontFamily: mono, fontSize: 11, color: c.faint };

const selectStyle = (minWidth, small) => ({
  padding: small ? "5px 8px" : "7px 12px",
  fontSize: small ? 11.5 : 13,
  fontFamily: mono,
  borderRadius: 7,
  border: `1px solid ${c.line}`,
  background: c.surface,
  color: c.ink,
  minWidth,
  cursor: "pointer",
  outline: "none",
});

const activeFieldStyle = { border: `1px solid ${c.accent}`, background: c.accentDim };

const inputStyle = {
  fontFamily: mono, fontSize: 11.5, padding: "5px 8px", borderRadius: 7,
  border: `1px solid ${c.line}`, background: c.surface, color: c.ink, outline: "none",
};

const primaryBtn = {
  fontFamily: sans, fontSize: 12.5, padding: "6px 18px", borderRadius: 7, border: "none",
  background: c.accent, color: "#fff", fontWeight: 600, cursor: "pointer",
};

const ghostDangerBtn = {
  fontFamily: sans, fontSize: 12, padding: "5px 12px", borderRadius: 7,
  border: `1px solid #EFC9C9`, background: c.dangerDim, color: c.danger, cursor: "pointer", fontWeight: 500,
};

const thStyle = {
  padding: "10px 14px", textAlign: "left", fontWeight: 600,
  color: c.muted, fontSize: 11, letterSpacing: "0.02em",
  borderBottom: `1px solid ${c.line}`, whiteSpace: "nowrap",
};
const tdStyle = {
  padding: "9px 14px", color: c.ink, maxWidth: 260,
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};

function pageBtnStyle(active, disabled) {
  return {
    minWidth: 26, padding: "4px 8px", fontSize: 11.5, fontFamily: mono, borderRadius: 6,
    border: active ? `1px solid ${c.accent}` : `1px solid ${c.line}`,
    background: active ? c.accent : disabled ? c.surfaceAlt : c.surface,
    color: active ? "#fff" : disabled ? c.faint : c.muted,
    cursor: disabled ? "default" : "pointer",
  };
}

// To builds compact page list like: 1 … 4 5 [6] 7 8 … 12
function pageNumbersToShow(current, total) {
  const delta = 1;
  const range = [];
  for (let i = Math.max(1, current - delta); i <= Math.min(total, current + delta); i++) {
    range.push(i);
  }
  const withEdges = [];
  if (range[0] > 1) {
    withEdges.push(1);
    if (range[0] > 2) withEdges.push("…");
  }
  withEdges.push(...range);
  if (range[range.length - 1] < total) {
    if (range[range.length - 1] < total - 1) withEdges.push("…");
    withEdges.push(total);
  }
  return withEdges;
}