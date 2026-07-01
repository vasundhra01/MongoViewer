# MongoDB Viewer

A lightweight full-stack application for viewing MongoDB collections in a dynamic table.

The application automatically detects collection fields, supports server-side filtering, sorting, pagination, and Excel export without requiring a fixed schema.

---

## Features

* View any collection in the database
* Dynamic table columns
* Server-side pagination (100 documents per request)
* Device, tag, and time filters
* Column search and sorting
* Excel export
* Automatic tag name mapping
* Automatic device detection

---

## Tech Stack

### Backend

* Go
* MongoDB

### Frontend

* React
* Vite

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
Connected to MongoDB at mongodb://localhost:27017
Server running at http://localhost:8080
```

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

When a collection is selected, the application clears previous data and starts loading the selected collection.

---

### Pagination

Documents are loaded in batches of **100**.

The backend returns:

* documents
* available columns
* next skip value
* `hasMore`

If more data exists, the frontend automatically requests the next batch until all documents are loaded.

---

### Dynamic Columns

MongoDB collections do not have a fixed schema.

The backend collects all unique field names from the first batch and sends them to the frontend, allowing the table to adapt automatically to different collections.

---

### Filtering

The application supports server-side filtering for:

* Device
* Tags
* Time range

These filters are applied in MongoDB, so only matching documents are returned.

Each column also provides a search box for quick client-side filtering.

---

### Sorting

Click any column header to sort the currently loaded data.

Both numeric and text values are supported.

---

### Excel Export

Once all documents are loaded, the current table can be exported as an Excel (`.xlsx`) file.

---

## API Endpoints

| Endpoint           | Description                     |
| ------------------ | ------------------------------- |
| `/api/collections` | List all collections            |
| `/api/items`       | Fetch paginated documents       |
| `/api/tags`        | Get tag ID to name mapping      |
| `/api/distinct`    | Get distinct values for a field |

---

## Configuration

Change the database name in:

```go
DB_NAME = "theiox_data"
```

if your MongoDB database has a different name.

---

## Future Improvements

* Full-text search
* Column visibility controls
* Configurable page size
* Authentication
* Virtual scrolling
