# MongoDB Viewer

Dynamic table viewer for MongoDB. Select any collection from a dropdown, data loads 10 rows at a time as you scroll.

---

## Setup

### 1. Start MongoDB pointing at your data folder

Open a terminal and run:

```bash
mongod --dbpath "C:\Users\hp\Desktop\theiox_metadata\graphql_demo"
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
