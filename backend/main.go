package main

import (
	"context"       //timeout and cancellation
	"encoding/json" // converts go structs to json format
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
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	coll := client.Database(DB_NAME).Collection(collName)
	opts := options.Find().
		SetSkip(skip).
		SetLimit(int64(LIMIT + 1)) // fetch 11 to detect hasMore

	cur, err := coll.Find(ctx, bson.M{}, opts)
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
