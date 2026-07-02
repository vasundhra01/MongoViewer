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
	// Connect with short timeouts — mongo.Connect is non-blocking; the actual
	// TCP handshake happens lazily on the first real operation.
	clientOpts := options.Client().
		ApplyURI(MONGO_URI).
		SetConnectTimeout(3 * time.Second).
		SetServerSelectionTimeout(5 * time.Second)

	var err error
	client, err = mongo.Connect(context.Background(), clientOpts)
	if err != nil {
		log.Fatal("MongoDB connect error:", err)
	}
	defer client.Disconnect(context.Background())

	// Ping in background — don't block server startup waiting for Mongo.
	// The HTTP server is accepting connections in milliseconds regardless.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		client.Ping(ctx, nil) // best-effort; errors surface on first real request
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/collections", withCORS(handleCollections))
	mux.HandleFunc("/api/items", withCORS(handleItems))
	mux.HandleFunc("/api/tags", withCORS(handleTags))
	mux.HandleFunc("/api/distinct", withCORS(handleDistinct))

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
		id := stringifyID(doc["_id"])
		if id == "" {
			continue // skip tags with no usable id
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
// Returns every distinct value for a field path in a collection.
// Used to populate the device dropdown with all values that exist,
// not just whatever is loaded in the browser.
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

	// Optional server-side filters — device, time range, tag fields
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

	opts := options.Find().
		SetSkip(skip).
		SetLimit(int64(LIMIT + 1))

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

// buildEqualityFilter matches a field against a value, trying int/float/bool
// coercions so it works regardless of how the value is stored in Mongo.
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

const dtLayoutNaive = "2006-01-02T15:04"

func parseFrontendTime(value string) (time.Time, bool) {
	if value == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339, value); err == nil {
		return t, true
	}
	if t, err := time.Parse("2006-01-02T15:04:05.000Z07:00", value); err == nil {
		return t, true
	}
	if t, err := time.Parse(dtLayoutNaive, value); err == nil {
		return t, true
	}
	return time.Time{}, false
}

// buildTimeFilter builds a Mongo range filter on a datetime field.
// Handles both native BSON dates and ISO string representations.
func buildTimeFilter(field, from, to string) bson.M {
	if field == "" || (from == "" && to == "") {
		return nil
	}
	fromT, hasFrom := parseFrontendTime(from)
	toT, hasTo := parseFrontendTime(to)
	if !hasFrom && !hasTo {
		return nil
	}

	dateRange := bson.M{}
	if hasFrom {
		dateRange["$gte"] = primitive.NewDateTimeFromTime(fromT)
	}
	if hasTo {
		dateRange["$lte"] = primitive.NewDateTimeFromTime(toT)
	}

	strFormats := []string{time.RFC3339, "2006-01-02T15:04:05.000Z07:00"}
	var strConds []bson.M
	for _, layout := range strFormats {
		strRange := bson.M{}
		if hasFrom {
			strRange["$gte"] = fromT.UTC().Format(layout)
		}
		if hasTo {
			strRange["$lte"] = toT.UTC().Format(layout)
		}
		strConds = append(strConds, bson.M{field: strRange})
	}

	orConds := append([]bson.M{{field: dateRange}}, strConds...)
	return bson.M{"$or": orConds}
}

// buildTagsFilter returns a filter matching docs that have any of the given
// raw_readings.* fields present.
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

// stringifyID converts a Mongo _id of any plausible type (string,
// ObjectID, number, etc.) into its string form, so tag lookups work
// regardless of how _id was stored on import. Returns "" if it can't
// be reasonably stringified.
func stringifyID(v interface{}) string {
	switch val := v.(type) {
	case string:
		return val
	case primitive.ObjectID:
		return val.Hex()
	case int32:
		return strconv.FormatInt(int64(val), 10)
	case int64:
		return strconv.FormatInt(val, 10)
	case float64:
		return strconv.FormatFloat(val, 'f', -1, 64)
	default:
		return ""
	}
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
