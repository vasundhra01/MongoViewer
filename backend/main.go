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
	MONGO_URI = "mongodb://localhost:27017" // single mongo connection shared by all
	DB_NAME   = "theiox_data"
	LIMIT     = 100
)

var client *mongo.Client 
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

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	coll := client.Database(DB_NAME).Collection(collName)
	opts := options.Find().
		SetSkip(skip).
		SetLimit(int64(LIMIT + 1)) // fetch 101 to detect hasMore

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
const dtLayout = "2006-01-02T15:04"

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
