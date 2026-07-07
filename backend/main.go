package main

import (
	"context"     
	"encoding/json" 
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/bson" 
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

const (
	MONGO_URI = "mongodb://localhost:27017"
	DB_NAME   = "selco_data"
	LIMIT     = 100
	ITEMS_QUERY_TIMEOUT      = 30 * time.Second
	METADATA_QUERY_TIMEOUT   = 20 * time.Second
	COLLECTIONS_LIST_TIMEOUT = 10 * time.Second
	UPDATE_QUERY_TIMEOUT     = 15 * time.Second
)

var client *mongo.Client

func main() {
	clientOpts := options.Client().
		ApplyURI(MONGO_URI).
		SetConnectTimeout(10 * time.Second).
		SetServerSelectionTimeout(10 * time.Second).
		SetSocketTimeout(45 * time.Second).
		SetMaxPoolSize(50).
		SetMinPoolSize(2)

	var err error
	client, err = mongo.Connect(context.Background(), clientOpts)
	if err != nil {
		log.Fatal("MongoDB connect error:", err)
	}
	defer client.Disconnect(context.Background())
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
	mux.HandleFunc("/api/items/update", withCORS(handleUpdateItem))
	mux.HandleFunc("/api/tags", withCORS(handleTags))
	mux.HandleFunc("/api/distinct", withCORS(handleDistinct))
	mux.HandleFunc("/api/devices", withCORS(handleDevices))

	log.Println("listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}

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
	sort.Strings(names)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"collections": names,
	})
}

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
			continue 
		}
		name, _ := doc["name"].(string)
		if name == "" {
			name = id 
		}
		tags[id] = name
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"tags": tags,
	})
}


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

func mapKeys(m bson.M) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

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
			if !loggedSample && (stateName == "" || districtName == "" || blockName == "") {
				log.Printf("handleDevices debug: general_info keys for device %s: %v", id, mapKeys(gi))
				loggedSample = true
			}
		} else if !loggedSample {
			log.Printf("handleDevices debug: general_info missing or not a document for device %s (go type %T)", id, doc["general_info"])
			loggedSample = true
		}
		if name == "" {
			name = id 
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
	
	}
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

type updateRequest struct {
	Collection string                 `json:"collection"`
	ID         string                 `json:"id"`
	Updates    map[string]interface{} `json:"updates"`
}
func normalizeJSONNumber(v interface{}) interface{} {
	switch val := v.(type) {
	case float64:
		if val == math.Trunc(val) && !math.IsInf(val, 0) {
			return int64(val)
		}
		return val
	case map[string]interface{}:
		out := make(map[string]interface{}, len(val))
		for k, nv := range val {
			out[k] = normalizeJSONNumber(nv)
		}
		return out
	case []interface{}:
		out := make([]interface{}, len(val))
		for i, nv := range val {
			out[i] = normalizeJSONNumber(nv)
		}
		return out
	default:
		return v
	}
}
func handleUpdateItem(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		http.Error(w, "method not allowed, use POST", http.StatusMethodNotAllowed)
		return
	}

	var body updateRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if body.Collection == "" {
		http.Error(w, "collection is required", http.StatusBadRequest)
		return
	}
	if body.ID == "" {
		http.Error(w, "id is required", http.StatusBadRequest)
		return
	}
	if len(body.Updates) == 0 {
		http.Error(w, "updates must contain at least one field", http.StatusBadRequest)
		return
	}
	delete(body.Updates, "_id")
	if len(body.Updates) == 0 {
		http.Error(w, "updates must contain at least one editable field", http.StatusBadRequest)
		return
	}

	setDoc := bson.M{}
	for k, v := range body.Updates {
		setDoc[k] = normalizeJSONNumber(v)
	}

	ctx, cancel := context.WithTimeout(context.Background(), UPDATE_QUERY_TIMEOUT)
	defer cancel()

	coll := client.Database(DB_NAME).Collection(body.Collection)
	res, err := coll.UpdateOne(ctx, bson.M{"_id": body.ID}, bson.M{"$set": setDoc})
	if err != nil {
		writeMongoError(w, "update error", err)
		return
	}
	if res.MatchedCount == 0 {
		http.Error(w, fmt.Sprintf("no document found in %q with _id %q", body.Collection, body.ID), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":       true,
		"matchedCount":  res.MatchedCount,
		"modifiedCount": res.ModifiedCount,
	})
}

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

func bsonToMap(doc bson.M) map[string]interface{} {
	out := make(map[string]interface{}, len(doc))
	for k, v := range doc {
		switch val := v.(type) {
		case primitive.ObjectID:
			out[k] = val.Hex()
		case primitive.DateTime:
			out[k] = val.Time().Format(time.RFC3339)
		case float64:
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
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h(w, r)
	}
}
