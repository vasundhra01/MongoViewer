package main

import (
	"context"       //timeout and cancellation
	"encoding/json" // converst go structs to json format
	"errors"
	"fmt"
	"log"
	"math"
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
	DB_NAME   = "selco_data"
	LIMIT     = 100

	// Previously each request context was given only 5s. Large/filtered
	// collections routinely need longer than that (skip-based pagination
	// gets slower the further in you page, since Mongo has to walk and
	// discard every skipped document; the time-range filter also uses an
	// $or across a BSON-date condition and two string-format conditions,
	// which can't always be served by a single index). A 5s ceiling meant
	// the context was cancelled mid-read as soon as a query ran long,
	// surfacing as: "context deadline exceeded" -> a broken TCP read ->
	// "incomplete read of message header". Bumping this gives real queries
	// room to finish instead of being killed by an artificially tight
	// deadline. If you still hit timeouts at this value under normal load,
	// that's usually a sign an index is missing on whatever field you're
	// filtering/sorting by (device id field, time field, tag fields),
	// rather than a reason to raise the timeout further.
	ITEMS_QUERY_TIMEOUT      = 30 * time.Second
	METADATA_QUERY_TIMEOUT   = 20 * time.Second
	COLLECTIONS_LIST_TIMEOUT = 10 * time.Second
)

var client *mongo.Client // single mongo connection shared by all

func main() {
	// Connect with short timeouts — mongo.Connect is non-blocking; the actual
	// TCP handshake happens lazily on the first real operation.
	clientOpts := options.Client().
		ApplyURI(MONGO_URI).
		SetConnectTimeout(10 * time.Second).
		SetServerSelectionTimeout(10 * time.Second).
		// SocketTimeout bounds how long a single network round-trip on an
		// established connection may take. Left at the driver default (30s)
		// this is fine, but we set it explicitly so it's always >= the
		// longest request-context timeout below — otherwise the socket
		// could be torn down by the driver before our own context deadline
		// even fires, which produces the exact "incomplete read of message
		// header" symptom reported.
		SetSocketTimeout(45 * time.Second).
		// A small, bounded pool avoids opening a fresh connection per
		// request (which is slow and can exhaust Mongo's own connection
		// limit under bursty polling from the frontend's fetch loop).
		SetMaxPoolSize(50).
		SetMinPoolSize(2)

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
		if err := client.Ping(ctx, nil); err != nil {
			log.Printf("initial MongoDB ping failed (will retry lazily on first request): %v", err)
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/collections", withCORS(handleCollections))
	mux.HandleFunc("/api/items", withCORS(handleItems))
	mux.HandleFunc("/api/tags", withCORS(handleTags))
	mux.HandleFunc("/api/distinct", withCORS(handleDistinct))
	mux.HandleFunc("/api/devices", withCORS(handleDevices))

	log.Println("listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}

// writeMongoError inspects a Mongo error and responds with an appropriate
// status + message. Deadline/timeout errors get a 504 with an actionable
// hint instead of a bare 500, since "the query was too slow" and "the
// query is broken" need different responses from the caller.
func writeMongoError(w http.ResponseWriter, label string, err error) {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, mongo.ErrClientDisconnected) {
		http.Error(w, fmt.Sprintf(
			"%s: query timed out. This usually means the collection is large and the "+
				"query has no supporting index for the filter/sort fields in use. "+
				"Try narrowing the filter (device/tag/time range) or adding an index. (%v)",
			label, err), http.StatusGatewayTimeout)
		return
	}
	http.Error(w, label+": "+err.Error(), http.StatusInternalServerError)
}

func handleCollections(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), COLLECTIONS_LIST_TIMEOUT)
	defer cancel()

	names, err := client.Database(DB_NAME).ListCollectionNames(ctx, bson.M{})
	if err != nil {
		writeMongoError(w, "failed to list collections", err)
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
	ctx, cancel := context.WithTimeout(context.Background(), METADATA_QUERY_TIMEOUT)
	defer cancel()

	coll := client.Database(DB_NAME).Collection("tag")

	cur, err := coll.Find(ctx, bson.M{})
	if err != nil {
		writeMongoError(w, "query error", err)
		return
	}
	defer cur.Close(ctx)

	var docs []bson.M
	if err := cur.All(ctx, &docs); err != nil {
		writeMongoError(w, "decode error", err)
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

// toDisplayString coerces a BSON value into a display string. Some
// datasets store fields like stateName/districtName inconsistently
// (numbers, or missing entirely) — a bare .(string) assertion silently
// returns "" for anything that isn't exactly a string, which is
// indistinguishable from the field genuinely being empty. This widens
// the accepted types so a non-string value still renders instead of
// disappearing.
func toDisplayString(v interface{}) string {
	switch val := v.(type) {
	case string:
		return val
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

// mapKeys lists the keys of a bson.M — used only for the one-time debug
// log in handleDevices so you can see the actual field names/casing
// present in general_info when a hierarchy field comes back empty.
func mapKeys(m bson.M) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// GET /api/devices
// Reads the device_instance collection and returns
// [{id, name, stateName, districtName, blockName}] where id is the
// document _id, name is general_info.device_name, and the hierarchy
// fields come from general_info.stateName / districtName / blockName.
// Used to populate the device dropdown and the "Show Hierarchy" view
// in the toolbar.
func handleDevices(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), METADATA_QUERY_TIMEOUT)
	defer cancel()

	cur, err := client.Database(DB_NAME).Collection("device_instance").Find(ctx, bson.M{})
	if err != nil {
		writeMongoError(w, "query error", err)
		return
	}
	defer cur.Close(ctx)

	var docs []bson.M
	if err := cur.All(ctx, &docs); err != nil {
		writeMongoError(w, "decode error", err)
		return
	}

	type Device struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		StateName    string `json:"stateName"`
		DistrictName string `json:"districtName"`
		BlockName    string `json:"blockName"`
	}

	devices := make([]Device, 0, len(docs))
	loggedSample := false
	for _, doc := range docs {
		id := stringifyID(doc["_id"])
		if id == "" {
			continue
		}
		name := ""
		stateName := ""
		districtName := ""
		blockName := ""
		if gi, ok := doc["general_info"].(bson.M); ok {
			name = toDisplayString(gi["device_name"])
			stateName = toDisplayString(gi["stateName"])
			districtName = toDisplayString(gi["districtName"])
			blockName = toDisplayString(gi["blockName"])

			// One-time debug print: if any hierarchy field came back empty,
			// dump the actual keys present under general_info so you can
			// check the real field names/casing in the live data instead
			// of guessing. Check your server's stdout/log after hitting
			// /api/devices.
			if !loggedSample && (stateName == "" || districtName == "" || blockName == "") {
				log.Printf("handleDevices debug: general_info keys for device %s: %v", id, mapKeys(gi))
				loggedSample = true
			}
		} else if !loggedSample {
			log.Printf("handleDevices debug: general_info missing or not a document for device %s (go type %T)", id, doc["general_info"])
			loggedSample = true
		}
		if name == "" {
			name = id // fall back to id if name missing
		}
		devices = append(devices, Device{
			ID:           id,
			Name:         name,
			StateName:    stateName,
			DistrictName: districtName,
			BlockName:    blockName,
		})
	}

	sort.Slice(devices, func(i, j int) bool {
		return devices[i].Name < devices[j].Name
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"devices": devices})
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

	ctx, cancel := context.WithTimeout(context.Background(), METADATA_QUERY_TIMEOUT)
	defer cancel()

	coll := client.Database(DB_NAME).Collection(collName)
	values, err := coll.Distinct(ctx, field, bson.M{})
	if err != nil {
		writeMongoError(w, "distinct error", err)
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
//
// Trade-off to be aware of: skip/limit cost grows with skip size, since
// Mongo must walk and discard every skipped document before returning the
// next page. For very large collections/deep pagination this is the most
// likely source of slow queries — if you outgrow ITEMS_QUERY_TIMEOUT even
// after adding indexes, the real fix is a proper range cursor on a stable,
// consistently-ordered field (e.g. a timestamp), not a bigger timeout.
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

	ctx, cancel := context.WithTimeout(context.Background(), ITEMS_QUERY_TIMEOUT)
	defer cancel()

	coll := client.Database(DB_NAME).Collection(collName)

	opts := options.Find().
		SetSkip(skip).
		SetLimit(int64(LIMIT + 1))

	cur, err := coll.Find(ctx, filter, opts)
	if err != nil {
		writeMongoError(w, "query error", err)
		return
	}
	defer cur.Close(ctx)

	var rawDocs []bson.M
	if err := cur.All(ctx, &rawDocs); err != nil {
		writeMongoError(w, "decode error", err)
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

// buildEqualityFilter matches a field against one or more comma-separated
// values (used for multi-select filters like "device A,device B"), trying
// int/float/bool coercions for each so it works regardless of how the
// value is stored in Mongo.
func buildEqualityFilter(field, value string) bson.M {
	if field == "" || value == "" {
		return nil
	}

	parts := strings.Split(value, ",")
	var candidates []interface{}
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		candidates = append(candidates, p)
		if i, err := strconv.ParseInt(p, 10, 64); err == nil {
			candidates = append(candidates, i, int32(i))
		}
		if f, err := strconv.ParseFloat(p, 64); err == nil {
			candidates = append(candidates, f)
		}
		if b, err := strconv.ParseBool(p); err == nil {
			candidates = append(candidates, b)
		}
	}
	if len(candidates) == 0 {
		return nil
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
		case float64:
			// JSON has no NaN/Infinity literals — encoding/json returns an
			// error mid-write when it hits them, truncating the response and
			// causing "Unexpected end of JSON input" on the frontend.
			// Replace with null so the response is always valid JSON.
			if math.IsNaN(val) || math.IsInf(val, 0) {
				out[k] = nil
			} else {
				out[k] = val
			}
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
		case float64:
			if math.IsNaN(val) || math.IsInf(val, 0) {
				out[i] = nil
			} else {
				out[i] = val
			}
		case bson.M:
			out[i] = bsonToMap(val)
		case bson.A:
			out[i] = bsonArrayToSlice(val)
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
