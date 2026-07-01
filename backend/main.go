package main

import (
	"context"       //timeout and cancellation
	"encoding/json" // converst go structs to json format
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/bson" //bson is Mongodb doc format
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

const (
	MONGO_URI = "mongodb://localhost:27017"
	DB_NAME   = "theiox_data"
	LIMIT     = 100
)

var client *mongo.Client // single mongo connection shared by all
func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second) //timeout context
	defer cancel()                                                           // this context will expire auto after 10 sec. change acc to will

	var err error
	client, err = mongo.Connect(ctx, options.Client().ApplyURI(MONGO_URI))
	if err != nil {
		log.Fatal("MongoDB connect error:", err) //connection error handler
	}
	defer client.Disconnect(context.Background())

	if err := client.Ping(ctx, nil); err != nil {
		log.Fatal("MongoDB ping error:", err)
	}
	log.Println("Connected to MongoDB at", MONGO_URI)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/collections", withCORS(handleCollections))
	mux.HandleFunc("/api/items", withCORS(handleItems))
	mux.HandleFunc("/api/tags", withCORS(handleTags))
	mux.HandleFunc("/api/distinct", withCORS(handleDistinct))

	log.Println("Server running at http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
func handleCollections(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	names, err := client.Database(DB_NAME).ListCollectionNames(ctx, bson.M{})
	if err != nil {
		http.Error(w, "failed to list collections: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"collections": names,
	})
}

// GET /api/tags
// Returns a map of tag _id (e.g. "tag_103") -> human-readable name from the
// "tag" collection, used by the frontend to label raw_readings.* columns.
func handleTags(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	coll := client.Database(DB_NAME).Collection("tag")

	cur, err := coll.Find(ctx, bson.M{})
	if err != nil {
		http.Error(w, "query error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer cur.Close(ctx)

	var docs []bson.M
	if err := cur.All(ctx, &docs); err != nil {
		http.Error(w, "decode error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	tags := make(map[string]string, len(docs))
	for _, doc := range docs {
		id, ok := doc["_id"].(string)
		if !ok {
			continue // skip tags whose _id isn't the expected string form
		}
		name, _ := doc["name"].(string)
		if name == "" {
			name = id // fall back to the id if no name is set
		}
		tags[id] = name
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"tags": tags,
	})
}

// GET /api/distinct?collection=X&field=Y
// Returns every distinct value Mongo has for a given (possibly dotted) field
// path in a collection, e.g. field=raw_readings.device_id. Used to populate
// filter dropdowns (like the device id selector) with the FULL set of values
// that exist in the collection, not just whatever happens to be loaded into
// the browser so far.
func handleDistinct(w http.ResponseWriter, r *http.Request) {
	collName := r.URL.Query().Get("collection")
	field := r.URL.Query().Get("field")
	if collName == "" || field == "" {
		http.Error(w, "collection and field params required", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	coll := client.Database(DB_NAME).Collection(collName)

	values, err := coll.Distinct(ctx, field, bson.M{})
	if err != nil {
		http.Error(w, "distinct error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Normalize everything to strings — the frontend only needs stable,
	// JSON-safe labels for a <select>, and it round-trips the chosen value
	// back to us as a plain query string anyway.
	strVals := make([]string, 0, len(values))
	for _, v := range values {
		if v == nil {
			continue
		}
		strVals = append(strVals, fmt.Sprintf("%v", v))
	}
	sort.Strings(strVals)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"values": strVals,
	})
}

// Returns 100 documents, dynamic fields, next skip value
// NOTE: pagination uses skip/limit (not _id keyset) because this database's
// _id field is a custom compound object, not a MongoDB ObjectID — so
// "_id $gt cursor" comparisons are meaningless here and were causing
// duplicate/overlapping pages (looked like an infinite loop of rows).
func handleItems(w http.ResponseWriter, r *http.Request) {
	collName := r.URL.Query().Get("collection")
	if collName == "" {
		http.Error(w, "collection param required", http.StatusBadRequest)
		return
	}

	skip := int64(0)
	if skipParam := r.URL.Query().Get("skip"); skipParam != "" {
		if parsed, err := strconv.ParseInt(skipParam, 10, 64); err == nil && parsed >= 0 {
			skip = parsed
		}
		// If parsing fails or value is negative, silently fall back to skip=0
		// rather than rejecting the request — keeps the fetch loop resilient.
	}

	// Optional server-side filters — lets the frontend push filtering (device
	// dropdown, tag toggles, time range) down into Mongo instead of pulling
	// every document across the wire and filtering in JS. Much lower latency
	// on large collections, especially with an index on the filtered fields.
	var andFilters []bson.M

	if f := buildEqualityFilter(r.URL.Query().Get("filterField"), r.URL.Query().Get("filterValue")); f != nil {
		andFilters = append(andFilters, f)
	}
	if f := buildTimeFilter(r.URL.Query().Get("timeField"), r.URL.Query().Get("fromTime"), r.URL.Query().Get("toTime")); f != nil {
		andFilters = append(andFilters, f)
	}
	if f := buildTagsFilter(r.URL.Query().Get("tagFields")); f != nil {
		andFilters = append(andFilters, f)
	}

	filter := bson.M{}
	if len(andFilters) > 0 {
		filter = bson.M{"$and": andFilters}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	coll := client.Database(DB_NAME).Collection(collName)

	// Use natural insertion order ($natural) since _id isn't reliably sortable here
	opts := options.Find().
		SetSkip(skip).
		SetLimit(int64(LIMIT + 1)) // fetch 11 to detect hasMore

	cur, err := coll.Find(ctx, filter, opts)
	if err != nil {
		http.Error(w, "query error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer cur.Close(ctx)

	var rawDocs []bson.M
	if err := cur.All(ctx, &rawDocs); err != nil {
		http.Error(w, "decode error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	hasMore := len(rawDocs) > LIMIT
	if hasMore {
		rawDocs = rawDocs[:LIMIT]
	}

	items := make([]map[string]interface{}, 0, len(rawDocs))
	for _, doc := range rawDocs {
		flat := flattenMap(bsonToMap(doc), "")
		items = append(items, flat)
	}

	nextSkip := skip + int64(len(items))

	keySet := map[string]bool{}
	for _, doc := range items {
		for k := range doc {
			keySet[k] = true
		}
	}

	var idKeys, otherKeys []string
	for k := range keySet {
		if strings.HasPrefix(k, "_id.") || k == "_id" {
			idKeys = append(idKeys, k)
		} else {
			otherKeys = append(otherKeys, k)
		}
	}
	sort.Strings(idKeys)
	sort.Strings(otherKeys)
	keys := append(idKeys, otherKeys...)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"items":    items,
		"keys":     keys,
		"nextSkip": nextSkip,
		"hasMore":  hasMore,
	})
}

// buildEqualityFilter builds an equality filter for an (optional) field/value
// pair. The frontend only ever sends the value as a plain string (it came
// from JSON), but the underlying Mongo field might actually be stored as an
// int, float, or bool — so we match against several type-coerced candidates
// with $in rather than assuming it's a string. Returns nil if there's
// nothing to filter on.
func buildEqualityFilter(field, value string) bson.M {
	if field == "" || value == "" {
		return nil
	}

	candidates := []interface{}{value}

	if i, err := strconv.ParseInt(value, 10, 64); err == nil {
		candidates = append(candidates, i, int32(i))
	}
	if f, err := strconv.ParseFloat(value, 64); err == nil {
		candidates = append(candidates, f)
	}
	if b, err := strconv.ParseBool(value); err == nil {
		candidates = append(candidates, b)
	}

	return bson.M{field: bson.M{"$in": candidates}}
}

// dtLayout matches the value format an HTML <input type="datetime-local">
// sends, e.g. "2024-01-31T14:05" — no seconds, no timezone.
const dtLayout = "2006-01-02T15:04"

// buildTimeFilter builds a range filter on a (possibly dotted) time field.
// The field might be stored in Mongo as a native BSON date, or as an RFC3339
// string (this backend writes dates out as RFC3339 strings when flattening
// docs for the frontend) — since we can't be sure which, we match either
// representation with $or. Returns nil if there's no usable range.
func buildTimeFilter(field, from, to string) bson.M {
	if field == "" || (from == "" && to == "") {
		return nil
	}

	var fromT, toT time.Time
	hasFrom, hasTo := false, false

	if from != "" {
		if t, err := time.Parse(dtLayout, from); err == nil {
			fromT, hasFrom = t, true
		}
	}
	if to != "" {
		if t, err := time.Parse(dtLayout, to); err == nil {
			toT, hasTo = t, true
		}
	}
	if !hasFrom && !hasTo {
		return nil
	}

	dateRange := bson.M{}
	strRange := bson.M{}
	if hasFrom {
		dateRange["$gte"] = primitive.NewDateTimeFromTime(fromT)
		strRange["$gte"] = fromT.Format(time.RFC3339)
	}
	if hasTo {
		dateRange["$lte"] = primitive.NewDateTimeFromTime(toT)
		strRange["$lte"] = toT.Format(time.RFC3339)
	}

	return bson.M{
		"$or": []bson.M{
			{field: dateRange},
			{field: strRange},
		},
	}
}

// buildTagsFilter takes a comma-separated list of (dotted) raw_readings.*
// field names and returns a filter matching documents that have AT LEAST
// ONE of them present (mirrors the "show me docs relevant to these tags"
// intent behind the tag toggle buttons in the UI). Returns nil if the list
// is empty.
func buildTagsFilter(tagsParam string) bson.M {
	if tagsParam == "" {
		return nil
	}

	var conds []bson.M
	for _, f := range strings.Split(tagsParam, ",") {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		conds = append(conds, bson.M{f: bson.M{"$exists": true, "$ne": nil}})
	}

	if len(conds) == 0 {
		return nil
	}
	if len(conds) == 1 {
		return conds[0]
	}
	return bson.M{"$or": conds}
}

// flattenMap converts nested objects into flat dot-notation keys.
// e.g. { _id: { sensor_id: "x", block_no: 1 } }
//
//	-> { "_id.sensor_id": "x", "_id.block_no": 1 }
//
// Arrays are left as-is (not flattened) since their length varies per doc
// and flattening arrays into columns doesn't make sense for a table view.
func flattenMap(m map[string]interface{}, prefix string) map[string]interface{} {
	out := map[string]interface{}{}
	for k, v := range m {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		switch val := v.(type) {
		case map[string]interface{}:
			nested := flattenMap(val, key)
			for nk, nv := range nested {
				out[nk] = nv
			}
		default:
			out[key] = v
		}
	}
	return out
}

// bsonToMap recursively converts bson.M to plain map[string]interface{}
// so ObjectIDs, timestamps etc. serialize correctly
func bsonToMap(doc bson.M) map[string]interface{} {
	out := make(map[string]interface{}, len(doc))
	for k, v := range doc {
		switch val := v.(type) {
		case primitive.ObjectID:
			out[k] = val.Hex()
		case primitive.DateTime:
			out[k] = val.Time().Format(time.RFC3339)
		case bson.M:
			out[k] = bsonToMap(val)
		case bson.A:
			out[k] = bsonArrayToSlice(val)
		default:
			out[k] = v
		}
	}
	return out
}

func bsonArrayToSlice(arr bson.A) []interface{} {
	out := make([]interface{}, len(arr))
	for i, v := range arr {
		switch val := v.(type) {
		case primitive.ObjectID:
			out[i] = val.Hex()
		case bson.M:
			out[i] = bsonToMap(val)
		default:
			out[i] = v
		}
	}
	return out
}

func withCORS(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h(w, r)
	}
}
