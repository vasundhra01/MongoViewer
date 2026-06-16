import { useState, useEffect, useRef } from "react";
import * as XLSX from "xlsx";

const API = "http://localhost:8080";
const CHUNK = 10;

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

  // All mutable fetch state lives in refs — never causes re-renders
  const cursorRef     = useRef(null);
  const colsLockedRef = useRef(false);
  const doneRef       = useRef(false);
  const loadingRef    = useRef(false);
  const selectedRef   = useRef("");

  // Load collections on mount
  useEffect(() => {
    fetch(`${API}/api/collections`)
      .then(r => r.json())
      .then(d => setCollections(d.collections || []))
      .catch(() => setError("Cannot reach backend. Is Go server running on :8080?"));
  }, []);

  // ── Single fetch function — reads from refs, writes to refs + state ──
  async function fetchBatch() {
    if (loadingRef.current || doneRef.current) return;
    const col = selectedRef.current;
    if (!col) return;

    loadingRef.current = true;
    setLoading(true);

    try {
      const url = cursorRef.current
        ? `${API}/api/items?collection=${col}&cursor=${cursorRef.current}`
        : `${API}/api/items?collection=${col}`;

      const res  = await fetch(url);
      const data = await res.json();

      // Guard: if collection changed while fetching, discard
      if (selectedRef.current !== col) return;

      const newItems = data.items || [];
      const more     = !!data.hasMore;
      const nextCur  = data.nextCursor || null;

      setRows(prev => [...prev, ...newItems]);

      if (!colsLockedRef.current && data.keys?.length) {
        setColumns(data.keys);
        colsLockedRef.current = true;
      }

      cursorRef.current = nextCur;

      if (!more) {
        doneRef.current = true;
        setDone(true);
      } else {
        // Schedule next batch — plain timeout, no state involved
        setTimeout(fetchBatch, 250);
      }
    } catch (e) {
      setError("Fetch failed: " + e.message);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  // ── Reset + kick first fetch when collection changes ──
  useEffect(() => {
    if (!selected) return;

    // Reset all state
    setRows([]);
    setColumns([]);
    setFilters({});
    setSort({ col: null, dir: "asc" });
    setError("");
    setDone(false);
    setLoading(false);

    // Reset all refs
    cursorRef.current     = null;
    colsLockedRef.current = false;
    doneRef.current       = false;
    loadingRef.current    = false;
    selectedRef.current   = selected;

    // Kick first fetch after reset settles
    setTimeout(fetchBatch, 50);
  }, [selected]);

  // ── Sort ──
  const handleSort = (col) => {
    setSort(prev => ({
      col,
      dir: prev.col === col && prev.dir === "asc" ? "desc" : "asc"
    }));
  };

  // ── Filter ──
  const handleFilter = (col, val) => {
    setFilters(prev => ({ ...prev, [col]: val }));
  };

  // ── Derived rows ──
  const displayRows = (() => {
    let result = [...rows];
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

  const downloadExcel = () => {
    const data = displayRows.map(row =>
      Object.fromEntries(columns.map(col => {
        const val = row[col];
        return [col, val === null || val === undefined ? "" : typeof val === "object" ? JSON.stringify(val) : val];
      }))
    );
    const ws = XLSX.utils.json_to_sheet(data, { header: columns });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, selected);
    XLSX.writeFile(wb, `${selected}.xlsx`);
  };

  const formatValue = (val) => {
    if (val === null || val === undefined) return <span style={{ color: "#ccc" }}>—</span>;
    if (typeof val === "object") return <span style={{ color: "#999", fontFamily: "monospace", fontSize: 11 }}>{JSON.stringify(val)}</span>;
    if (typeof val === "boolean") return <span style={{ color: val ? "#2d7d46" : "#b94a4a", fontWeight: 500 }}>{String(val)}</span>;
    return String(val);
  };

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 1200, margin: "0 auto", padding: "32px 24px" }}>

      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 4px" }}>MongoDB Viewer</h1>
        <p style={{ fontSize: 13, color: "#888", margin: 0 }}>graphql_demo · localhost:27017</p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <label style={{ fontSize: 13, color: "#555", fontWeight: 500 }}>Collection</label>
        <select
          value={selected}
          onChange={e => setSelected(e.target.value)}
          style={{ padding: "7px 12px", fontSize: 13, borderRadius: 8, border: "1px solid #ddd", background: "#fff", minWidth: 200, cursor: "pointer" }}
        >
          <option value="">— select a collection —</option>
          {collections.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        {(rows.length > 0 || loading) && (
          <span style={{ fontSize: 12, color: "#888" }}>
            {loading ? `Loading… (${rows.length} rows so far)` : `${rows.length} total · showing ${displayRows.length}`}
            {done && !loading && " · all loaded"}
          </span>
        )}

        {activeFilters > 0 && (
          <button
            onClick={() => setFilters({})}
            style={{ fontSize: 12, color: "#b00", background: "#fff0f0", border: "1px solid #fcc", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}
          >
            Clear {activeFilters} filter{activeFilters > 1 ? "s" : ""}
          </button>
        )}
        {rows.length > 0 && done && (
          <button
            onClick={downloadExcel}
            style={{ fontSize: 12, color: "#fff", background: "#1a7f4b", border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer", marginLeft: "auto", display: "flex", alignItems: "center", gap: 5 }}
          >
            ⬇ Download Excel
          </button>
        )}
      </div>

      {error && (
        <div style={{ background: "#fff0f0", border: "1px solid #fcc", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#b00", marginBottom: 16 }}>
          {error}
        </div>
      )}

      {selected && columns.length > 0 && (
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f8f8f8" }}>
                <th style={thStyle}>#</th>
                {columns.map(col => (
                  <th key={col} style={{ ...thStyle, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort(col)}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      {col}
                      <span style={{ fontSize: 10, color: sort.col === col ? "#333" : "#ccc" }}>
                        {sort.col === col ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}
                      </span>
                    </div>
                  </th>
                ))}
              </tr>
              <tr style={{ background: "#fff", borderBottom: "1px solid #e5e5e5" }}>
                <td style={{ padding: "6px 14px" }} />
                {columns.map(col => (
                  <td key={col} style={{ padding: "5px 8px" }}>
                    <input
                      type="text"
                      placeholder="filter…"
                      value={filters[col] || ""}
                      onChange={e => handleFilter(col, e.target.value)}
                      style={{
                        width: "100%", padding: "4px 8px", fontSize: 12,
                        border: filters[col] ? "1px solid #7F77DD" : "1px solid #e0e0e0",
                        borderRadius: 5, outline: "none", boxSizing: "border-box",
                        background: filters[col] ? "#f8f7ff" : "#fff"
                      }}
                    />
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, i) => (
                <tr key={i}
                  style={{ borderTop: "1px solid #f0f0f0" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#fafafa"}
                  onMouseLeave={e => e.currentTarget.style.background = ""}
                >
                  <td style={{ ...tdStyle, color: "#bbb", userSelect: "none" }}>{i + 1}</td>
                  {columns.map(col => (
                    <td key={col} style={tdStyle}>{formatValue(row[col])}</td>
                  ))}
                </tr>
              ))}
              {displayRows.length === 0 && !loading && (
                <tr>
                  <td colSpan={columns.length + 1} style={{ padding: "40px", textAlign: "center", color: "#aaa", fontSize: 13 }}>
                    No rows match the current filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div style={{ padding: "10px 14px", textAlign: "center", fontSize: 12, color: "#aaa", borderTop: "1px solid #f0f0f0", background: "#fafafa" }}>
            {loading && <span>⏳ Loading rows {rows.length + 1}–{rows.length + CHUNK}…</span>}
            {!loading && done && <span>✓ All {rows.length} rows loaded</span>}
            {!loading && !done && rows.length > 0 && <span>Loaded {rows.length} rows…</span>}
          </div>
        </div>
      )}

      {selected && !loading && rows.length === 0 && !error && columns.length === 0 && (
        <div style={{ textAlign: "center", padding: "60px 0", color: "#aaa", fontSize: 14 }}>
          No documents found in <strong>{selected}</strong>
        </div>
      )}

      {!selected && (
        <div style={{ textAlign: "center", padding: "60px 0", color: "#ccc", fontSize: 14 }}>
          Select a collection above to view its data
        </div>
      )}
    </div>
  );
}

const thStyle = {
  padding: "10px 14px", textAlign: "left", fontWeight: 500,
  color: "#555", fontSize: 12, borderBottom: "1px solid #e5e5e5", whiteSpace: "nowrap",
};
const tdStyle = {
  padding: "9px 14px", color: "#333", maxWidth: 260,
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};