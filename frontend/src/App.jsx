import { useState, useEffect, useRef } from "react"; //react hooks
import * as XLSX from "xlsx";

const API = "http://localhost:8080";
const CHUNK = 100;
const MAX_BATCH_RETRIES = 2; // retries for a single slow/failed batch before surfacing an error
const RETRY_BACKOFF_MS = 1000;

// Collections that show the click-a-row-to-edit workflow. Kept as a Set so
// it's a one-line change to enable editing on more collections later —
// the update endpoint itself (POST /api/items/update) is already generic
// across any collection with a string _id.
const EDITABLE_COLLECTIONS = new Set(["gateway_instance"]);

function localDateTimeToUTCISO(value) {
  if (!value) return "";
  const d = new Date(value); // "YYYY-MM-DDTHH:mm" is parsed as local time
  if (isNaN(d.getTime())) return "";
  return d.toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Generic multi-select combobox used for both the Device filter and the
// Tag filter. Takes a plain { id, name } items array so it isn't coupled
// to either shape of data.
function MultiCombobox({ items, selectedIds, onChange, placeholder }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed === ""
    ? items
    : items.filter(d => d.name.toLowerCase().includes(trimmed));

  const toggle = (id) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  };

  const clearAll = () => onChange(new Set());
  const allFilteredSelected = filtered.length > 0 && filtered.every(d => selectedIds.has(d.id));

  const toggleSelectAllFiltered = () => {
    const next = new Set(selectedIds);
    if (allFilteredSelected) {
      filtered.forEach(d => next.delete(d.id));
    } else {
      filtered.forEach(d => next.add(d.id));
    }
    onChange(next);
  };

  const selectedItems = items.filter(d => selectedIds.has(d.id));
  const displayText =
    selectedItems.length === 0 ? "" :
    selectedItems.length === 1 ? selectedItems[0].name :
    `${selectedItems.length} selected`;

  return (
    <div ref={containerRef} style={{ position: "relative", minWidth: 240 }}>
      <input
        type="text"
        value={open ? query : displayText}
        onFocus={() => { setOpen(true); setQuery(""); }}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        placeholder={placeholder}
        style={{
          padding: "7px 12px", fontSize: 13, borderRadius: 8, width: "100%", boxSizing: "border-box",
          border: selectedIds.size ? "1px solid #7F77DD" : "1px solid #ddd",
          background: selectedIds.size ? "#f8f7ff" : "#fff",
        }}
      />
      {selectedIds.size > 0 && (
        <button
          onClick={clearAll}
          title="Clear filter"
          style={{
            position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
            border: "none", background: "transparent", color: "#999", cursor: "pointer", fontSize: 15, lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 20,
          background: "#fff", border: "1px solid #ddd", borderRadius: 8, maxHeight: 280,
          overflowY: "auto", boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
        }}>
          {filtered.length > 0 && (
            <div
              onClick={toggleSelectAllFiltered}
              style={{
                padding: "7px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600,
                display: "flex", alignItems: "center", gap: 8,
                color: "#7F77DD", borderBottom: "1px solid #f0f0f0",
              }}
              onMouseEnter={e => e.currentTarget.style.background = "#f5f5f5"}
              onMouseLeave={e => e.currentTarget.style.background = ""}
            >
              <input type="checkbox" checked={allFilteredSelected} readOnly style={{ pointerEvents: "none" }} />
              {allFilteredSelected
                ? `Deselect all (${filtered.length} shown)`
                : trimmed
                  ? `Select all ${filtered.length} matching "${query}"`
                  : `Select all ${filtered.length}`}
            </div>
          )}
          {selectedIds.size > 0 && (
            <div
              onClick={clearAll}
              style={{ padding: "7px 12px", fontSize: 12, cursor: "pointer", color: "#b00", borderBottom: "1px solid #f0f0f0" }}
              onMouseEnter={e => e.currentTarget.style.background = "#fff0f0"}
              onMouseLeave={e => e.currentTarget.style.background = ""}
            >
              Clear all ({selectedIds.size} selected)
            </div>
          )}
          {filtered.length === 0 && (
            <div style={{ padding: "7px 12px", fontSize: 13, color: "#bbb" }}>No matches</div>
          )}
          {filtered.map(d => {
            const checked = selectedIds.has(d.id);
            return (
              <div
                key={d.id}
                onClick={() => toggle(d.id)}
                style={{
                  padding: "7px 12px", fontSize: 13, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 8,
                  background: checked ? "#f8f7ff" : "transparent",
                  color: checked ? "#7F77DD" : "#333",
                  fontWeight: checked ? 600 : 400,
                }}
                onMouseEnter={e => e.currentTarget.style.background = "#f5f5f5"}
                onMouseLeave={e => e.currentTarget.style.background = checked ? "#f8f7ff" : "transparent"}
              >
                <input type="checkbox" checked={checked} readOnly style={{ pointerEvents: "none" }} />
                <span>{d.name}</span>
              </div>
            );
          })}
        </div>
      )}
      {selectedItems.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
          {selectedItems.map(d => (
            <span key={d.id} style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontSize: 11, padding: "2px 8px", borderRadius: 12,
              background: "#f8f7ff", border: "1px solid #dcdaf7", color: "#7F77DD",
            }}>
              {d.name}
              <span
                onClick={() => toggle(d.id)}
                style={{ cursor: "pointer", color: "#aaa", fontWeight: 700 }}
              >
                ×
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
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
  const [page, setPage]               = useState(1);
  const [tagNames, setTagNames]       = useState({}); 

  // Single set of selected tag ids (e.g. "tag_103"), sourced from the
  // /api/tags dropdown below — replaces the old per-collection pill lists.
  const [selectedTagIds, setSelectedTagIds]     = useState(new Set());
  const [pendingFunctions, setPendingFunctions] = useState(new Set());
  const [appliedFunctions, setAppliedFunctions] = useState(new Set());
  const [pendingFrom, setPendingFrom] = useState("");        
  const [pendingTo,   setPendingTo]   = useState("");
  const [appliedFrom, setAppliedFrom] = useState("");
  const [appliedTo,   setAppliedTo]   = useState("");
  const [timeCol,     setTimeCol]     = useState("");        
  const [selectedDeviceIds, setSelectedDeviceIds] = useState(new Set()); 
  const [showHierarchy, setShowHierarchy]         = useState(false);
  const [hierarchySearch, setHierarchySearch]     = useState("");

  // ── Row edit modal state ──
  // editingRow holds the *original* row (as last received from the
  // server) so we can diff against it when saving; editFormData holds the
  // live, user-edited values shown in the form fields.
  const [editingRow, setEditingRow]   = useState(null);
  const [editFormData, setEditFormData] = useState({});
  const [editSaving, setEditSaving]   = useState(false);
  const [editError, setEditError]     = useState("");

  const skipRef         = useRef(0);
  const colsLockedRef   = useRef(false);
  const doneRef         = useRef(false);
  const loadingRef      = useRef(false);
  const selectedRef     = useRef("");
  const runTokenRef     = useRef(0);
  const previewRef      = useRef(true); 
  const deviceFilterRef = useRef({ field: "", values: [] });
  const activeFilterRef = useRef({ timeField: "", fromTime: "", toTime: "", tagFields: "" });
  const [devices, setDevices]               = useState([]);

  useEffect(() => {
    fetch(`${API}/api/collections`)
      .then(r => r.json())
      .then(d => setCollections((d.collections || []).slice().sort((a, b) => a.localeCompare(b))))
      .catch(() => setError("Cannot reach backend. Is Go server running on :8080?"));

    fetch(`${API}/api/tags`)
      .then(r => r.json())
      .then(d => setTagNames(d.tags || {}))
      .catch(() => {});

    fetch(`${API}/api/devices`)
      .then(r => r.json())
      .then(d => setDevices(d.devices || []))
      .catch(() => {});
  }, []);

  async function fetchBatch(token, attempt = 0) {
    if (token !== runTokenRef.current) return;
    if (loadingRef.current || doneRef.current) return;
    const col = selectedRef.current;
    if (!col) return;

    loadingRef.current = true;
    setLoading(true);

    try {
      let url = `${API}/api/items?collection=${col}&skip=${skipRef.current}`;

      const { field, values } = deviceFilterRef.current;
      if (field && values && values.length) {
        // Multiple device IDs are sent as a single comma-separated
        // filterValue. The backend needs to split this and match with
        // an $in query instead of a plain equality check.
        url += `&filterField=${encodeURIComponent(field)}&filterValue=${encodeURIComponent(values.join(","))}`;
      }

      const { timeField, fromTime, toTime, tagFields } = activeFilterRef.current;
      if (timeField && (fromTime || toTime)) {
        url += `&timeField=${encodeURIComponent(timeField)}`;
        if (fromTime) url += `&fromTime=${encodeURIComponent(fromTime)}`;
        if (toTime)   url += `&toTime=${encodeURIComponent(toTime)}`;
      }
      if (tagFields) url += `&tagFields=${encodeURIComponent(tagFields)}`;

      const res = await fetch(url);
      if (!res.ok) {
        const bodyText = await res.text();
        // 502/503/504 (including our backend's "query timed out" 504) are
        // usually transient — a retry with backoff often succeeds once
        // Mongo's cache is warm or a load spike passes. 4xx errors are not
        // retried since retrying won't change a bad request.
        const isRetryable = res.status >= 500 && attempt < MAX_BATCH_RETRIES;
        if (isRetryable) {
          loadingRef.current = false;
          setLoading(false);
          await sleep(RETRY_BACKOFF_MS * (attempt + 1));
          return fetchBatch(token, attempt + 1);
        }
        throw new Error(`Server returned ${res.status}: ${bodyText}`);
      }
      const data = await res.json();

      if (token !== runTokenRef.current || selectedRef.current !== col) return;

      const newItems = data.items || [];
      const more     = !!data.hasMore;
      const nextSkip = typeof data.nextSkip === "number" ? data.nextSkip : skipRef.current + newItems.length;

      setRows(prev => [...prev, ...newItems]);
      if (!colsLockedRef.current && data.keys?.length) {
        setColumns(data.keys);
        colsLockedRef.current = true;
      }
      skipRef.current = nextSkip;

      // In preview mode: stop after first batch so the user sees a quick
      // 100-row sample without waiting for the full collection to load.
      if (!more || previewRef.current) {
        doneRef.current = true;
        setDone(true);
      } else {
        setTimeout(() => fetchBatch(token), 250);
      }
    } catch (e) {
      if (token === runTokenRef.current) setError("Fetch failed: " + e.message);
    } finally {
      if (token === runTokenRef.current) { loadingRef.current = false; setLoading(false); }
    }
  }

  
  function restartFetch() {
    runTokenRef.current += 1;
    const token = runTokenRef.current;
    setRows([]); setDone(false); setLoading(false); setPage(1);
    skipRef.current = 0; doneRef.current = false; loadingRef.current = false;
    colsLockedRef.current = false;
    setError("");
    setTimeout(() => fetchBatch(token), 50);
  }

  useEffect(() => {
    if (!selected) return;

    runTokenRef.current += 1;
    const myToken = runTokenRef.current;

    setRows([]); setColumns([]); setFilters({}); setSort({ col: null, dir: "asc" });
    setError(""); setDone(false); setLoading(false); setPage(1);
    setSelectedTagIds(new Set());
    setPendingFunctions(new Set()); setAppliedFunctions(new Set());
    setPendingFrom(""); setPendingTo(""); setAppliedFrom(""); setAppliedTo("");
    setTimeCol("");
    closeEditModal();

    skipRef.current        = 0;
    colsLockedRef.current  = false;
    doneRef.current        = false;
    loadingRef.current     = false;
    selectedRef.current    = selected;
    previewRef.current     = true; 
    activeFilterRef.current = { timeField: "", fromTime: "", toTime: "", tagFields: "" };
    deviceFilterRef.current = selectedDeviceIds.size
      ? { field: "_id.device_instance_id", values: Array.from(selectedDeviceIds) }
      : { field: "", values: [] };

    const t = setTimeout(() => fetchBatch(myToken), 50);
    return () => clearTimeout(t);
  }, [selected]);

  useEffect(() => {
    if (columns.length === 0 || rows.length === 0) return;
    if (timeCol) return; 
    const firstDateCol = columns.find(col => {
      const sample = rows[0]?.[col];
      return typeof sample === "string" && /^\d{4}-\d{2}-\d{2}T/.test(sample);
    });
    if (firstDateCol) setTimeCol(firstDateCol);
  }, [columns, rows]);

  const handleSort = (col) => {
    setPage(1);
    setSort(prev => ({
      col,
      dir: prev.col === col && prev.dir === "asc" ? "desc" : "asc"
    }));
  };

  const handleFilter = (col, val) => {
    setPage(1);
    setFilters(prev => ({ ...prev, [col]: val }));
  };

  const RAW_PREFIX = "raw_readings.";
  const TAG_FN_RE  = /^(tag_\d+)-(\w+)$/;

  // Column that stores the device instance id — resolved once so both
  // rendering and filtering/sorting can agree on which column to translate
  // into a human-readable device name.
  const deviceCol = columns.find(c => c === "_id.device_instance_id")
    || columns.find(c => c.toLowerCase().includes("device"));

  const deviceNameById = (() => {
    const map = {};
    devices.forEach(d => { map[d.id] = d.name; });
    return map;
  })();

  // Full tag list from /api/tags, turned into { id, name } items for the
  // tag MultiCombobox — mirrors how `devices` feeds the device combobox.
  const tagsList = Object.entries(tagNames)
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // First-3-letters abbreviation used for state/district/block in the
  // hierarchy view. Falls back to "—" when the field is missing.
  const abbr = (s) => {
    const t = (s || "").trim();
    return t ? t.slice(0, 3).toUpperCase() : "—";
  };

  const hierarchyRows = (() => {
    // Split into words so typing "Karnataka Kalaburagi" first narrows to
    // the state, then further narrows to the district within it — each
    // word must match somewhere (state, district, block, or device name),
    // but different words can match different fields.
    const terms = hierarchySearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = devices;
    if (terms.length > 0) {
      list = list.filter(d => {
        const haystacks = [
          d.name.toLowerCase(),
          (d.stateName || "").toLowerCase(),
          (d.districtName || "").toLowerCase(),
          (d.blockName || "").toLowerCase(),
        ];
        return terms.every(term => haystacks.some(h => h.includes(term)));
      });
    }
    return [...list].sort((a, b) => {
      const ak = `${a.stateName || ""}|${a.districtName || ""}|${a.blockName || ""}|${a.name}`;
      const bk = `${b.stateName || ""}|${b.districtName || ""}|${b.blockName || ""}|${b.name}`;
      return ak.localeCompare(bk);
    });
  })();

  // Single source of truth for applying a device selection — used by both
  // the toolbar combobox and the hierarchy modal so picking devices in
  // either place updates the same filter and re-fetches consistently.
  const applyDeviceSelection = (ids) => {
    setSelectedDeviceIds(ids);
    if (!selected) return;

    // Clearing both device and tag filters goes back to preview mode
    // (first 100 rows only); having either set fetches the full matching set.
    previewRef.current = ids.size === 0 && selectedTagIds.size === 0;
    deviceFilterRef.current = ids.size
      ? { field: "_id.device_instance_id", values: Array.from(ids) }
      : { field: "", values: [] };
    restartFetch();
  };

  // Builds the comma-separated backend field list for a set of selected
  // tag ids. Tries both schema shapes this app encounters: raw_readings.<id>
  // (raw_readings collections) and <id>-<fn> for every metric function
  // currently visible in the loaded columns (tag-function collections).
  const computeTagFieldsString = (ids) => {
    const fields = [];
    ids.forEach(id => {
      fields.push(`${RAW_PREFIX}${id}`);
      uniqueFns.forEach(fn => fields.push(`${id}-${fn}`));
    });
    return fields.join(",");
  };

  // Mirrors applyDeviceSelection for tags — fetched once from /api/tags via
  // the combobox above, filters data as soon as a tag is picked instead of
  // needing the separate per-collection pill rows this used to have.
  const applyTagSelection = (ids) => {
    setSelectedTagIds(ids);
    if (!selected) return;

    previewRef.current = ids.size === 0 && selectedDeviceIds.size === 0;
    activeFilterRef.current = { ...activeFilterRef.current, tagFields: computeTagFieldsString(ids) };
    restartFetch();
  };

  const toggleHierarchyDevice = (id) => {
    const next = new Set(selectedDeviceIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    applyDeviceSelection(next);
  };

  const hierarchyAllSelected = hierarchyRows.length > 0 && hierarchyRows.every(d => selectedDeviceIds.has(d.id));

  const toggleSelectAllHierarchy = () => {
    const next = new Set(selectedDeviceIds);
    if (hierarchyAllSelected) {
      hierarchyRows.forEach(d => next.delete(d.id));
    } else {
      hierarchyRows.forEach(d => next.add(d.id));
    }
    applyDeviceSelection(next);
  };

  // Resolves a cell's *display* value — translates the raw device id into
  // its device name when the column is the device column, otherwise
  // returns the raw value untouched. Used consistently for filtering,
  // sorting, on-screen rendering, and Excel export so they never disagree.
  const getDisplayValue = (row, col) => {
    const raw = row[col];
    if (col === deviceCol && raw !== null && raw !== undefined) {
      const name = deviceNameById[String(raw)];
      if (name) return name;
    }
    return raw;
  };

  const colLabel = (col) => {
    if (col === deviceCol) return "Device";
    const tfMatch = col.match(TAG_FN_RE);
    if (tfMatch) return `${tagNames[tfMatch[1]] || tfMatch[1]} - ${tfMatch[2]}`;
    if (col.startsWith(RAW_PREFIX)) return tagNames[col.slice(RAW_PREFIX.length)] || col.slice(RAW_PREFIX.length);
    return col;
  };

  const displayRows = (() => {
    let result = [...rows];

    Object.entries(filters).forEach(([col, val]) => {
      if (!val) return;
      const lower = val.toLowerCase();
      result = result.filter(row => {
        const cell = getDisplayValue(row, col);
        if (cell === null || cell === undefined) return false;
        return String(typeof cell === "object" ? JSON.stringify(cell) : cell)
          .toLowerCase().includes(lower);
      });
    });

    if (timeCol && (appliedFrom || appliedTo)) {
      const from = appliedFrom ? new Date(appliedFrom).getTime() : -Infinity;
      const to   = appliedTo   ? new Date(appliedTo).getTime()   :  Infinity;
      result = result.filter(row => {
        const val = row[timeCol];
        if (!val) return false;
        const t = new Date(val).getTime();
        return t >= from && t <= to;
      });
    }

    if (sort.col) {
      result.sort((a, b) => {
        const av = getDisplayValue(a, sort.col) ?? "", bv = getDisplayValue(b, sort.col) ?? "";
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

  const tagFnCols    = columns.filter(c => TAG_FN_RE.test(c));
  const uniqueTagIds = [...new Set(tagFnCols.map(c => c.match(TAG_FN_RE)[1]))].sort();
  const uniqueFns    = [...new Set(tagFnCols.map(c => c.match(TAG_FN_RE)[2]))].sort();

  const rawReadingCols = columns.filter(c => c.startsWith(RAW_PREFIX));

  const visibleColumns = columns.filter(col => {
    const tfMatch = col.match(TAG_FN_RE);
    if (tfMatch) {
      const tagOk = selectedTagIds.size === 0 || selectedTagIds.has(tfMatch[1]);
      const fnOk  = appliedFunctions.size === 0 || appliedFunctions.has(tfMatch[2]);
      return tagOk && fnOk;
    }
    if (col.startsWith(RAW_PREFIX)) return selectedTagIds.size === 0 || selectedTagIds.has(col.slice(RAW_PREFIX.length));
    return true;
  });

  const datetimeCols = columns.filter(col => {
    const sample = rows[0]?.[col];
    return typeof sample === "string" && /^\d{4}-\d{2}-\d{2}T/.test(sample);
  });

  const handleExecute = () => {
    setAppliedFunctions(new Set(pendingFunctions));
    setAppliedFrom(pendingFrom);
    setAppliedTo(pendingTo);
    setPage(1);

    previewRef.current = false; 
    deviceFilterRef.current = selectedDeviceIds.size
      ? { field: "_id.device_instance_id", values: Array.from(selectedDeviceIds) }
      : { field: "", values: [] };
    activeFilterRef.current = {
      timeField: timeCol,
      fromTime:  localDateTimeToUTCISO(pendingFrom),
      toTime:    localDateTimeToUTCISO(pendingTo),
      tagFields: computeTagFieldsString(selectedTagIds),
    };
    restartFetch();
  };

  const handleClearFilters = () => {
    setSelectedTagIds(new Set());
    setPendingFunctions(new Set()); setAppliedFunctions(new Set());
    setPendingFrom(""); setPendingTo(""); setAppliedFrom(""); setAppliedTo("");
    setSelectedDeviceIds(new Set());
    setPage(1);

    previewRef.current = false;
    deviceFilterRef.current = { field: "", values: [] };
    activeFilterRef.current = { timeField: "", fromTime: "", toTime: "", tagFields: "" };
    restartFetch();
  };

  const filtersApplied =
    selectedTagIds.size > 0 ||
    appliedFunctions.size > 0 || appliedFrom || appliedTo || selectedDeviceIds.size > 0;

  const totalPages = Math.max(1, Math.ceil(displayRows.length / CHUNK));
  const currentPage = Math.min(page, totalPages);
  const pageRows = displayRows.slice((currentPage - 1) * CHUNK, currentPage * CHUNK);

  // Clamp `page` back into range when filtering/sorting shrinks the result
  // set out from under the current page. This used to happen inline during
  // render (setTimeout(() => setPage(currentPage), 0) called mid-render),
  // which works by accident but triggers "Cannot update state during
  // render" warnings and an extra unnecessary render. A useEffect keyed on
  // the actual dependency is the correct place for this side effect.
  useEffect(() => {
    if (currentPage !== page) setPage(currentPage);
  }, [currentPage, page]);

  const downloadExcel = () => {
    const data = displayRows.map(row =>
      Object.fromEntries(visibleColumns.map(col => {
        const val = getDisplayValue(row, col);
        return [colLabel(col), val === null || val === undefined ? "" : typeof val === "object" ? JSON.stringify(val) : val];
      }))
    );
    const ws = XLSX.utils.json_to_sheet(data, { header: visibleColumns.map(colLabel) });
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

  // ── Row edit modal ──
  const isEditableCollection = EDITABLE_COLLECTIONS.has(selected);

  function openEditModal(row) {
    setEditingRow(row);
    setEditFormData({ ...row });
    setEditError("");
  }

  function closeEditModal() {
    setEditingRow(null);
    setEditFormData({});
    setEditError("");
    setEditSaving(false);
  }

  function handleEditFieldChange(col, value) {
    setEditFormData(prev => ({ ...prev, [col]: value }));
  }

  async function handleSaveEdit() {
    if (!editingRow) return;
    setEditError("");

    // Diff the form against the original row so we only send fields that
    // actually changed. Object/array fields are edited as JSON text in the
    // textarea, so those get parsed back before comparing/sending.
    const updates = {};
    for (const col of columns) {
      if (col === "_id") continue;
      const original = editingRow[col];
      const isObjectField = original !== null && typeof original === "object";
      let newVal = editFormData[col];

      if (isObjectField && typeof newVal === "string") {
        try {
          newVal = JSON.parse(newVal);
        } catch (e) {
          setEditError(`"${colLabel(col)}" is not valid JSON: ${e.message}`);
          return;
        }
      }

      if (JSON.stringify(newVal) !== JSON.stringify(original)) {
        updates[col] = newVal;
      }
    }

    if (Object.keys(updates).length === 0) {
      closeEditModal();
      return;
    }

    setEditSaving(true);
    try {
      const res = await fetch(`${API}/api/items/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collection: selected, id: editingRow._id, updates }),
      });
      if (!res.ok) {
        const bodyText = await res.text();
        throw new Error(`Server returned ${res.status}: ${bodyText}`);
      }

      // Reflect the change locally so the table updates without a refetch.
      setRows(prev => prev.map(r => (r._id === editingRow._id ? { ...r, ...updates } : r)));
      closeEditModal();
    } catch (e) {
      setEditError("Save failed: " + e.message);
    } finally {
      setEditSaving(false);
    }
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 1200, margin: "0 auto", padding: "32px 24px" }}>

      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 4px" }}>MongoDB Viewer</h1>
        <p style={{ fontSize: 13, color: "#888", margin: 0 }}>selco_data · localhost:27017</p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <label style={{ fontSize: 13, color: "#555", fontWeight: 500 }}>Collection</label>
        <select
          value={selected}
          onChange={e => setSelected(e.target.value)}
          style={{ padding: "7px 12px", fontSize: 13, borderRadius: 8, border: "1px solid #ddd", background: "#fff", minWidth: 200, cursor: "pointer" }}
        >
          <option value="">— select a collection —</option>
          {collections.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        {devices.length > 0 && (
          <>
            <label style={{ fontSize: 13, color: "#555", fontWeight: 500 }}>Device</label>
            <MultiCombobox
              items={devices}
              selectedIds={selectedDeviceIds}
              onChange={applyDeviceSelection}
              placeholder={`All devices (${devices.length})`}
            />
            <button
              onClick={() => setShowHierarchy(true)}
              style={{
                fontSize: 12, padding: "7px 14px", borderRadius: 8, cursor: "pointer",
                border: "1px solid #ddd", background: "#fff", color: "#555", fontWeight: 500,
              }}
            >
              Show Hierarchy
            </button>
          </>
        )}

        {tagsList.length > 0 && (
          <>
            <label style={{ fontSize: 13, color: "#555", fontWeight: 500 }}>Tags</label>
            <MultiCombobox
              items={tagsList}
              selectedIds={selectedTagIds}
              onChange={applyTagSelection}
              placeholder={`All tags (${tagsList.length})`}
            />
          </>
        )}

        {(rows.length > 0 || loading) && (
          <span style={{ fontSize: 12, color: "#888" }}>
            {loading ? `Loading… (${rows.length} rows)` : `${rows.length} rows · showing ${displayRows.length}`}
          </span>
        )}

        {isEditableCollection && rows.length > 0 && (
          <span style={{ fontSize: 12, color: "#7F77DD" }}>
            Click a row to edit it
          </span>
        )}

        {activeFilters > 0 && (
          <button onClick={() => setFilters({})}
            style={{ fontSize: 12, color: "#b00", background: "#fff0f0", border: "1px solid #fcc", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}>
            Clear {activeFilters} filter{activeFilters > 1 ? "s" : ""}
          </button>
        )}

        {rows.length > 0 && done && (
          <button onClick={downloadExcel}
            style={{ fontSize: 12, color: "#fff", background: "#1a7f4b", border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer", marginLeft: "auto" }}>
            Download Excel (.xlsx)
          </button>
        )}
      </div>

      {/* ── Preview banner ── */}
      {selected && done && previewRef.current && rows.length > 0 && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 16px", marginBottom: 16, fontSize: 13, color: "#92400e", display: "flex", alignItems: "center", gap: 10 }}>
          <span>Showing first {rows.length} rows as a preview.</span>
          <span style={{ color: "#78350f" }}></span>
        </div>
      )}

      {(rawReadingCols.length > 0 || tagFnCols.length > 0) && (
        <div style={{ border: "1px solid #e8e8e8", borderRadius: 10, padding: "16px 18px", marginBottom: 16, background: "#fafafa" }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "#aaa", textTransform: "uppercase", marginBottom: 14 }}>
            Filter Console
          </div>

          {/* ── Metrics row (tag-function collections) ── */}
          {uniqueFns.length > 0 && (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
              <span style={filterLabelStyle}>Metrics</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, flex: 1 }}>
                {uniqueFns.map(fn => {
                  const active = pendingFunctions.has(fn);
                  return (
                    <button key={fn} onClick={() => setPendingFunctions(prev => {
                      const next = new Set(prev); active ? next.delete(fn) : next.add(fn); return next;
                    })} style={pillStyle(active)}>
                      {fn}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ height: 1, background: "#eee", margin: "8px 0 12px" }} />

          {/* ── Time filter ── */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={filterLabelStyle}>Time</span>

            {datetimeCols.length > 1 && (
              <select value={timeCol} onChange={e => setTimeCol(e.target.value)}
                style={{ fontSize: 12, padding: "5px 8px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#444" }}>
                {datetimeCols.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            )}

            <span style={{ fontSize: 12, color: "#888" }}>From</span>
            <input type="datetime-local" value={pendingFrom} onChange={e => setPendingFrom(e.target.value)}
              style={{ fontSize: 12, padding: "5px 8px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#333" }} />

            <span style={{ fontSize: 12, color: "#888" }}>To</span>
            <input type="datetime-local" value={pendingTo} onChange={e => setPendingTo(e.target.value)}
              style={{ fontSize: 12, padding: "5px 8px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#333" }} />

            <button onClick={handleExecute}
              style={{ fontSize: 12, padding: "6px 18px", borderRadius: 6, border: "none", background: "#7F77DD", color: "#fff", fontWeight: 700, cursor: "pointer" }}>
              Execute
            </button>

            {filtersApplied && (
              <button onClick={handleClearFilters}
                style={{ fontSize: 12, padding: "5px 12px", borderRadius: 6, border: "1px solid #fcc", background: "#fff0f0", color: "#b00", cursor: "pointer" }}>
                Clear
              </button>
            )}

            {filtersApplied && (
              <span style={{ fontSize: 11, color: "#7F77DD", fontStyle: "italic" }}>
                {[
                  selectedTagIds.size > 0 && `${selectedTagIds.size} tag${selectedTagIds.size > 1 ? "s" : ""}`,
                  appliedFunctions.size > 0 && `${appliedFunctions.size} metric${appliedFunctions.size > 1 ? "s" : ""}`,
                  (appliedFrom || appliedTo) && "time range",
                  selectedDeviceIds.size > 0 && `${selectedDeviceIds.size} device${selectedDeviceIds.size > 1 ? "s" : ""}`,
                ].filter(Boolean).join(" · ")}
                {" — "}{displayRows.length} rows
              </span>
            )}
          </div>
        </div>
      )}

      {error && (
        <div style={{ background: "#fff0f0", border: "1px solid #fcc", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#b00", marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button onClick={restartFetch}
            style={{ fontSize: 12, padding: "5px 12px", borderRadius: 6, border: "1px solid #fcc", background: "#fff", color: "#b00", cursor: "pointer", whiteSpace: "nowrap" }}>
            Retry
          </button>
        </div>
      )}

      {selected && columns.length > 0 && (
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 10, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f8f8f8" }}>
                <th style={thStyle}>#</th>
                {visibleColumns.map(col => (
                  <th key={col} style={{ ...thStyle, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort(col)}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      {colLabel(col)}
                      <span style={{ fontSize: 10, color: sort.col === col ? "#333" : "#ccc" }}>
                        {sort.col === col ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}
                      </span>
                    </div>
                  </th>
                ))}
              </tr>
              <tr style={{ background: "#fff", borderBottom: "1px solid #e5e5e5" }}>
                <td style={{ padding: "6px 14px" }} />
                {visibleColumns.map(col => (
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
              {pageRows.map((row, i) => (
                <tr key={(currentPage - 1) * CHUNK + i}
                  style={{ borderTop: "1px solid #f0f0f0", cursor: isEditableCollection ? "pointer" : "default" }}
                  onClick={() => isEditableCollection && openEditModal(row)}
                  title={isEditableCollection ? "Click to edit this row" : undefined}
                  onMouseEnter={e => e.currentTarget.style.background = isEditableCollection ? "#f8f7ff" : "#fafafa"}
                  onMouseLeave={e => e.currentTarget.style.background = ""}
                >
                  <td style={{ ...tdStyle, color: "#bbb", userSelect: "none" }}>{(currentPage - 1) * CHUNK + i + 1}</td>
                  {visibleColumns.map(col => (
                    <td key={col} style={tdStyle}>{formatValue(getDisplayValue(row, col))}</td>
                  ))}
                </tr>
              ))}
              {displayRows.length === 0 && !loading && (
                <tr>
                  <td colSpan={visibleColumns.length + 1} style={{ padding: "40px", textAlign: "center", color: "#aaa", fontSize: 13 }}>
                    No rows match the current filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 14px", borderTop: "1px solid #f0f0f0", background: "#fafafa", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "#aaa" }}>
              {loading && <span>Loading more… ({rows.length} rows fetched so far)</span>}
              {!loading && done && <span>All {rows.length} rows loaded</span>}
              {!loading && !done && rows.length > 0 && <span>Loaded {rows.length} rows so far…</span>}
            </span>

            {totalPages > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  style={pageBtnStyle(false, currentPage === 1)}
                >
                  ‹ Prev
                </button>

                {pageNumbersToShow(currentPage, totalPages).map((p, idx) =>
                  p === "…" ? (
                    <span key={`ellipsis-${idx}`} style={{ padding: "0 4px", color: "#bbb", fontSize: 12 }}>…</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      style={pageBtnStyle(p === currentPage, false)}
                    >
                      {p}
                    </button>
                  )
                )}

                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  style={pageBtnStyle(false, currentPage === totalPages)}
                >
                  Next ›
                </button>

                <span style={{ fontSize: 12, color: "#999", marginLeft: 6 }}>
                  Page {currentPage} of {totalPages}{!done && " (growing…)"}
                </span>
              </div>
            )}
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

      {/* ── Device hierarchy modal ── */}
      {showHierarchy && (
        <div
          onClick={() => setShowHierarchy(false)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: "#fff", borderRadius: 12, width: 560, maxWidth: "90vw",
              maxHeight: "76vh", display: "flex", flexDirection: "column",
              boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
            }}
          >
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #eee", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Device Hierarchy</div>
                <div style={{ fontSize: 12, color: "#999", marginTop: 2 }}>State - District - Block - Device</div>
              </div>
              <button
                onClick={() => setShowHierarchy(false)}
                style={{ border: "none", background: "transparent", fontSize: 20, cursor: "pointer", color: "#999", lineHeight: 1 }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: "12px 20px 0" }}>
              <input
                type="text"
                autoFocus
                placeholder="Type state, then district… e.g. Karnataka Kalaburagi"
                value={hierarchySearch}
                onChange={e => setHierarchySearch(e.target.value)}
                style={{
                  width: "100%", padding: "8px 12px", fontSize: 13, borderRadius: 8,
                  border: "1px solid #ddd", boxSizing: "border-box", outline: "none",
                }}
              />
            </div>

            <div style={{ overflowY: "auto", padding: "10px 12px 16px", marginTop: 4 }}>
              {hierarchyRows.length > 0 && (
                <div
                  onClick={toggleSelectAllHierarchy}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
                    padding: "8px 10px", borderRadius: 8, fontSize: 12, fontWeight: 600, color: "#7F77DD",
                    borderBottom: "1px solid #f0f0f0", marginBottom: 4,
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = "#fafafa"}
                  onMouseLeave={e => e.currentTarget.style.background = ""}
                >
                  <input type="checkbox" checked={hierarchyAllSelected} readOnly style={{ pointerEvents: "none" }} />
                  {hierarchyAllSelected ? `Deselect all (${hierarchyRows.length} shown)` : `Select all ${hierarchyRows.length} shown`}
                </div>
              )}
              {hierarchyRows.length === 0 && (
                <div style={{ padding: "24px 0", textAlign: "center", color: "#bbb", fontSize: 13 }}>
                  No matching devices
                </div>
              )}
              {hierarchyRows.map(d => {
                const checked = selectedDeviceIds.has(d.id);
                return (
                  <div
                    key={d.id}
                    onClick={() => toggleHierarchyDevice(d.id)}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
                      padding: "8px 10px", borderRadius: 8, fontSize: 13,
                      background: checked ? "#f8f7ff" : "transparent",
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = checked ? "#f2f0fd" : "#fafafa"}
                    onMouseLeave={e => e.currentTarget.style.background = checked ? "#f8f7ff" : "transparent"}
                  >
                    <input type="checkbox" checked={checked} readOnly style={{ pointerEvents: "none", flexShrink: 0 }} />
                    <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
                      <span style={hierarchyBadgeStyle}>{abbr(d.stateName)}</span>
                      <span style={hierarchyBadgeStyle}>{abbr(d.districtName)}</span>
                      <span style={hierarchyBadgeStyle}>{abbr(d.blockName)}</span>
                    </span>
                    <span style={{ color: "#ddd" }}>—</span>
                    <span style={{ fontWeight: checked ? 600 : 500, color: checked ? "#7F77DD" : "#333" }}>{d.name}</span>
                  </div>
                );
              })}
            </div>

            <div style={{ padding: "10px 20px", borderTop: "1px solid #f0f0f0", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span style={{ fontSize: 12, color: "#999" }}>
                {hierarchyRows.length} of {devices.length} devices
                {selectedDeviceIds.size > 0 && ` · ${selectedDeviceIds.size} selected`}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                {selectedDeviceIds.size > 0 && (
                  <button
                    onClick={() => applyDeviceSelection(new Set())}
                    style={{ fontSize: 12, padding: "6px 12px", borderRadius: 6, border: "1px solid #fcc", background: "#fff0f0", color: "#b00", cursor: "pointer" }}
                  >
                    Clear selection
                  </button>
                )}
                <button
                  onClick={() => setShowHierarchy(false)}
                  style={{ fontSize: 12, padding: "6px 16px", borderRadius: 6, border: "none", background: "#7F77DD", color: "#fff", fontWeight: 600, cursor: "pointer" }}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Row edit modal ── */}
      {editingRow && (
        <div
          onClick={() => !editSaving && closeEditModal()}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: "#fff", borderRadius: 12, width: 560, maxWidth: "90vw",
              maxHeight: "82vh", display: "flex", flexDirection: "column",
              boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
            }}
          >
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #eee", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Edit document</div>
                <div style={{ fontSize: 12, color: "#999", marginTop: 2, fontFamily: "monospace" }}>{editingRow._id}</div>
              </div>
              <button
                onClick={() => !editSaving && closeEditModal()}
                style={{ border: "none", background: "transparent", fontSize: 20, cursor: "pointer", color: "#999", lineHeight: 1 }}
              >
                ×
              </button>
            </div>

            <div style={{ overflowY: "auto", padding: "16px 20px" }}>
              {columns.map(col => {
                if (col === "_id") {
                  return (
                    <div key={col} style={{ marginBottom: 14 }}>
                      <label style={editFieldLabelStyle}>{colLabel(col)}</label>
                      <div style={{ fontSize: 13, color: "#888", padding: "7px 10px", background: "#f5f5f5", borderRadius: 6, fontFamily: "monospace" }}>
                        {String(editingRow[col])}
                      </div>
                    </div>
                  );
                }

                const original = editingRow[col];
                const val = editFormData[col];
                const isObjectField = original !== null && typeof original === "object";
                const isBoolField = typeof original === "boolean";
                const isNumberField = typeof original === "number";

                return (
                  <div key={col} style={{ marginBottom: 14 }}>
                    <label style={editFieldLabelStyle}>{colLabel(col)}</label>
                    {isObjectField ? (
                      <textarea
                        value={typeof val === "string" ? val : JSON.stringify(val, null, 2)}
                        onChange={e => handleEditFieldChange(col, e.target.value)}
                        rows={Math.min(8, Math.max(3, (typeof val === "string" ? val : JSON.stringify(val, null, 2)).split("\n").length))}
                        style={editTextareaStyle}
                      />
                    ) : isBoolField ? (
                      <select
                        value={String(val)}
                        onChange={e => handleEditFieldChange(col, e.target.value === "true")}
                        style={editInputStyle}
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : isNumberField ? (
                      <input
                        type="number"
                        value={val ?? ""}
                        onChange={e => handleEditFieldChange(col, e.target.value === "" ? "" : Number(e.target.value))}
                        style={editInputStyle}
                      />
                    ) : (
                      <input
                        type="text"
                        value={val ?? ""}
                        onChange={e => handleEditFieldChange(col, e.target.value)}
                        style={editInputStyle}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {editError && (
              <div style={{ margin: "0 20px 12px", background: "#fff0f0", border: "1px solid #fcc", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#b00" }}>
                {editError}
              </div>
            )}

            <div style={{ padding: "12px 20px", borderTop: "1px solid #f0f0f0", display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                onClick={() => !editSaving && closeEditModal()}
                disabled={editSaving}
                style={{ fontSize: 12, padding: "7px 16px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#555", cursor: editSaving ? "default" : "pointer" }}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={editSaving}
                style={{ fontSize: 12, padding: "7px 18px", borderRadius: 6, border: "none", background: editSaving ? "#b5b0f0" : "#7F77DD", color: "#fff", fontWeight: 600, cursor: editSaving ? "default" : "pointer" }}
              >
                {editSaving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
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

const hierarchyBadgeStyle = {
  fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 5,
  background: "#f3f2fd", color: "#7F77DD", letterSpacing: "0.03em",
};

const filterLabelStyle = {
  fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase",
  letterSpacing: "0.04em", paddingTop: 5, minWidth: 52,
};

const editFieldLabelStyle = {
  display: "block", fontSize: 11, fontWeight: 700, color: "#888",
  textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 5,
};

const editInputStyle = {
  width: "100%", padding: "7px 10px", fontSize: 13, borderRadius: 6,
  border: "1px solid #ddd", boxSizing: "border-box", outline: "none",
};

const editTextareaStyle = {
  width: "100%", padding: "8px 10px", fontSize: 12, fontFamily: "monospace",
  borderRadius: 6, border: "1px solid #ddd", boxSizing: "border-box", outline: "none", resize: "vertical",
};

const pillStyle = (active) => ({
  fontSize: 12, padding: "4px 11px", borderRadius: 14, cursor: "pointer",
  border: active ? "1px solid #7F77DD" : "1px solid #ddd",
  background: active ? "#7F77DD" : "#fff",
  color: active ? "#fff" : "#555",
  fontWeight: active ? 600 : 400,
});

function pageBtnStyle(active, disabled) {
  return {
    minWidth: 28, padding: "4px 8px", fontSize: 12, borderRadius: 6,
    border: active ? "1px solid #7F77DD" : "1px solid #e0e0e0",
    background: active ? "#7F77DD" : disabled ? "#f5f5f5" : "#fff",
    color: active ? "#fff" : disabled ? "#ccc" : "#444",
    cursor: disabled ? "default" : "pointer",
  };
}

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