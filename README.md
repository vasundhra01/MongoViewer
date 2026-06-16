# MongoDB Viewer

Dynamic table viewer for MongoDB. Select any collection from a dropdown, data loads 10 rows at a time.
A lightweight full-stack app to browse MongoDB collections in a clean table UI with sorting, filtering, and Excel export.

---

## Setup

### 1. Start MongoDB pointing at your data folder

Open a terminal and run:

```bash
mongod --dbpath "path of the database"
```

Keep this terminal open. MongoDB must be running for the backend to connect.

---

### 2. Start the Go backend

Open a second terminal:

```bash
cd backend
go mod tidy
go run main.go
```

You should see:
```
Connected to MongoDB at mongodb://localhost:27017
Server running at http://localhost:8080
```

---

### 3. Start the React frontend

Open a third terminal:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

---

## How it works

- Dropdown lists all collections in your `graphql_demo` database
- Selecting a collection fetches the first 10 documents
- Scrolling to the bottom automatically fetches the next 10
- Table columns are **dynamic** — built from whatever fields exist in the documents
- `_id` (ObjectID) is converted to a readable hex string
- Nested objects are shown as compact JSON
- Booleans are colour-coded green/red

---

## Project structure

```
mongo-viewer/
├── backend/
│   ├── main.go       ← Go HTTP server + MongoDB queries
│   └── go.mod
└── frontend/
    ├── src/
    │   ├── App.jsx   ← React table + dropdown + scroll logic
    │   └── main.jsx
    ├── index.html
    ├── package.json
    └── vite.config.js
```

---

## Changing the database name

In `backend/main.go`, line:

```go
DB_NAME = "graphql_demo"
```

Change `graphql_demo` to whatever your actual MongoDB database name is. If you're unsure, run:

```bash
mongosh
> show dbs
```
## How pagination works
 
Instead of `skip(n).limit(10)` (slow on large collections), the app uses **keyset pagination**:
 
- Every document in MongoDB has a built-in `_id` field (an ObjectID)
- The first fetch has no cursor: `find({}).limit(10)`
- Each response returns `nextCursor` = the `_id` of the last document
- The next fetch uses: `find({ _id: { $gt: nextCursor } }).limit(10)`
- This is O(log n) via index — stays fast regardless of collection size
- Stops when the backend returns `hasMore: false`
---
 
## How dynamic columns work
 
MongoDB is schemaless so different documents can have different fields. The backend scans all returned documents, collects every unique key, and sends them as a `keys` array alongside the data. The frontend locks the column list after the very first batch and never changes it, so the table header stays stable as more rows load.
 
---
 
## How the fetch loop works
 
Fetching is driven by a plain recursive async function and  not by `useEffect`. After each batch completes, if `hasMore` is true, `setTimeout(fetchBatch, 250)` schedules the next one. This avoids React's stale closure and re-render problems that arise when using `useEffect` as a fetch loop driver.
 
