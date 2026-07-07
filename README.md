# MongoDB Viewer

A lightweight full-stack application for viewing MongoDB collections in a dynamic table.
The application automatically detects collection fields, supports server-side filtering, sorting, pagination, and Excel export without requiring a fixed schema.

---

## Features

* View any collection in the database
* Dynamic table columns — no fixed schema required
* Server-side pagination (100 documents per request), loaded automatically in the background
* Preview mode: instantly shows the first 100 rows before deciding whether to load everything
* Device filter (multi-select, searchable) sourced from the `device_instance` collection
* Device Hierarchy browser — search/select devices by State → District → Block
* Tag filter (multi-select, searchable) sourced from the `tag` collection, with automatic tag-name mapping
* Metric/function filter for tag-function collections (e.g. `tag_103-avg`, `tag_103-max`)
* Time-range filter with automatic detection of datetime columns and local ↔ UTC conversion
* Per-column search (client-side) and click-to-sort (numeric or text, ascending/descending)
* Excel export (`.xlsx`) of the currently filtered/sorted view
* Automatic retry with backoff on transient server errors while paginating
* Human-readable device names shown in place of raw device IDs (table, filters, sorting, and Excel export all agree)

---

## Tech Stack

### Backend

* Go
* MongoDB (official `go.mongodb.org/mongo-driver`)

### Frontend

* React
* Vite
* [SheetJS (xlsx)](https://www.npmjs.com/package/xlsx) for Excel export

---

## Setup

### 1. Start MongoDB

```bash
mongod --dbpath "datapath"
```

---

### 2. Start the Backend

```bash
cd backend
go mod tidy
go run main.go
```

Expected output:

```
listening on :8080
```

> Note: the server starts and accepts requests immediately — it does not block on the MongoDB connection. The connection is pinged in the background, and any connection problem will only surface once you make a request that actually touches the database (e.g. `/api/collections`), rather than at startup.

---

### 3. Start the Frontend

```bash
cd frontend
npm install
npm run dev
```

Open:

```
http://localhost:5173
```

---

## Project Structure

```
mongo-viewer/
├── backend/
│   ├── main.go
│   └── go.mod
│
└── frontend/
    ├── src/
    │   ├── App.jsx
    │   └── main.jsx
    ├── package.json
    └── vite.config.js
```

---

## How It Works

### Collection Selection

The frontend loads all available MongoDB collections and displays them in a dropdown.
When a collection is selected, the application clears previous data/filters and loads a **preview** of the first 100 documents.

### Pagination

Documents are loaded in batches of **100**.
The backend returns:

* documents (`items`)
* available columns (`keys`)
* next skip value (`nextSkip`)
* whether more data exists (`hasMore`)

If more data exists and the collection isn't in preview mode, the frontend automatically requests the next batch (with a short delay between requests) until all documents are loaded. If a batch fails with a server error, it's retried automatically (up to 2 times, with backoff) before an error is shown.

Pagination uses `skip`/`limit` rather than a range cursor, because this dataset's `_id` is a custom compound object rather than a standard MongoDB `ObjectID`, so `_id`-based keyset pagination isn't reliable here. The trade-off is that `skip` gets more expensive the further into a collection you page — see [Performance Notes](#performance-notes) below.

### Preview Mode vs. Full Load

Selecting a collection with no filters applied only loads the first 100 rows (preview mode), shown with a banner. Applying **any** device, tag, time, or metric filter (or clicking Execute) switches to a full load of every matching document. Clearing all filters returns to full-load mode for the unfiltered collection; switching collections always resets back to a fresh preview.

### Dynamic Columns

MongoDB collections do not have a fixed schema.
The backend collects all unique field names from the first batch and sends them to the frontend, allowing the table to adapt automatically to different collections. Nested fields are flattened with dot notation (e.g. `_id.device_instance_id`, `raw_readings.tag_103`).

### Filtering

The application supports server-side filtering for:

* **Device** — one or more devices, matched against `_id.device_instance_id`
* **Tags** — one or more tags, matched against either `raw_readings.<tag_id>` (raw-reading collections) or `<tag_id>-<function>` (tag-function collections), depending on what's present in the collection
* **Time range** — matched against whichever datetime column is selected, supporting both native BSON dates and ISO string timestamps
* **Metric/function** (client-side column visibility) — narrows which `tag-function` columns are shown once a collection has them, e.g. only `avg` or only `max`

These server-side filters are applied in MongoDB, so only matching documents are transferred and paginated. Each column also provides a text search box for quick client-side filtering of already-loaded rows.

### Device Hierarchy

The "Show Hierarchy" button opens a modal listing every device grouped by State / District / Block, with a multi-word search (e.g. typing `Karnataka Kalaburagi` narrows to devices in that state *and* that district). Selecting devices here is equivalent to selecting them in the Device dropdown — both write to the same filter.

### Sorting

Click any column header to sort the currently loaded data. Both numeric and text values are supported; the sort direction toggles on repeated clicks.

### Excel Export

Once all documents matching the current filters are loaded, the current table (including any client-side filters and sort order, and with device IDs resolved to names) can be exported as an Excel (`.xlsx`) file.

---

## API Endpoints

| Endpoint            | Description                                                                 |
| -------------------- | ---------------------------------------------------------------------------|
| `/api/collections`   | List all collections in the database                                       |
| `/api/items`         | Fetch paginated documents (`collection`, `skip`, plus optional filters)    |
| `/api/tags`          | Get tag ID → name mapping, read from the `tag` collection                  |
| `/api/devices`       | Get all devices with `id`, `name`, `stateName`, `districtName`, `blockName`, read from `device_instance` |
| `/api/distinct`      | Get distinct values for a field in a collection (`collection`, `field`)    |

### `/api/items` query parameters

| Parameter      | Description                                                                 |
| -------------- | ---------------------------------------------------------------------------|
| `collection`   | **Required.** Collection name to query                                     |
| `skip`         | Number of documents to skip (pagination offset)                            |
| `filterField`  | Field to equality-filter on (currently `_id.device_instance_id`)           |
| `filterValue`  | Comma-separated value(s) to match against `filterField` (matched via `$in`) |
| `timeField`    | Datetime field to range-filter on                                          |
| `fromTime`     | Range start (ISO 8601)                                                     |
| `toTime`       | Range end (ISO 8601)                                                       |
| `tagFields`    | Comma-separated list of tag-derived field names that must be present       |

Responses use HTTP `504` (not `500`) when a query exceeds its timeout, so slow/unindexed queries are distinguishable from genuine server errors.

---

## Configuration

All configuration currently lives as constants at the top of `main.go`:

```go
const (
    MONGO_URI = "mongodb://localhost:27017"
    DB_NAME   = "selco_data"
    LIMIT     = 100

    ITEMS_QUERY_TIMEOUT      = 30 * time.Second // timeout for /api/items queries
    METADATA_QUERY_TIMEOUT   = 20 * time.Second // timeout for /api/tags, /api/devices, /api/distinct
    COLLECTIONS_LIST_TIMEOUT = 10 * time.Second // timeout for /api/collections
)
```

Change `DB_NAME` if your MongoDB database has a different name, and `MONGO_URI` if MongoDB isn't running on the default local port.

The Mongo client is also configured with a bounded connection pool (`SetMaxPoolSize` / `SetMinPoolSize`) and an explicit socket timeout, so it doesn't open a fresh connection per request under bursty polling from the frontend's pagination loop.

The frontend's backend URL is set at the top of `App.jsx`:

```js
const API = "http://localhost:8080";
```

Update this if the backend is hosted somewhere other than `localhost:8080`.

---

## Performance Notes

* **Deep pagination is the main cost driver.** Because `skip`/`limit` is used instead of a range cursor, later pages get progressively more expensive to fetch, since MongoDB must walk and discard every skipped document first. For very large collections, this is the most likely cause of a slow or timed-out request — a proper fix would be a range cursor on a stable, consistently-ordered field (e.g. a timestamp), rather than raising the timeout further.
* **Add indexes on whatever you filter or sort by.** In particular: `_id.device_instance_id` (device filter), your time column (time-range filter), and any `raw_readings.<tag_id>` / `<tag_id>-<function>` fields you filter on (tag filter). Without supporting indexes, filtered queries fall back to full collection scans.
* If you see an HTTP `504` from `/api/items`, it means the query exceeded `ITEMS_QUERY_TIMEOUT` — narrow the filter, add an index, or both, rather than assuming the server is broken.

---

## Future Improvements

* Full-text search
* Column visibility controls
* Configurable page size
* Authentication
* Virtual scrolling
* Range-cursor pagination for large collections (replacing `skip`/`limit`)
