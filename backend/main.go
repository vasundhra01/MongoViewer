package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)
const (
	MONGO_URI = "mongodb://localhost:27017"
	DB_NAME   = "graphql_demo"
	LIMIT     = 10
)
var client *mongo.Client
func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var err error
	client, err = mongo.Connect(ctx, options.Client().ApplyURI(MONGO_URI))
	if err != nil {
		log.Fatal("MongoDB connect error:", err)
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

	cursorParam := r.URL.Query().Get("cursor")
	filter := bson.M{}
	if cursorParam != "" {
		oid, err := primitive.ObjectIDFromHex(cursorParam)
		if err != nil {
			http.Error(w, "invalid cursor", http.StatusBadRequest)
			return
		}
		filter = bson.M{"_id": bson.M{"$gt": oid}}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	coll := client.Database(DB_NAME).Collection(collName)
	opts := options.Find().
		SetSort(bson.D{{Key: "_id", Value: 1}}).
		SetLimit(int64(LIMIT + 1))

	cur, err := coll.Find(ctx, filter, opts)
	if err != nil {
		http.Error(w, "query error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer cur.Close(ctx)

	// Decode as raw documents to preserve dynamic fields
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
		items = append(items, bsonToMap(doc))
	}

	nextCursor := ""
	if hasMore && len(items) > 0 {
		if id, ok := rawDocs[len(rawDocs)-1]["_id"].(primitive.ObjectID); ok {
			nextCursor = id.Hex()
		}
	}

	keySet := map[string]bool{}
	for _, doc := range items {
		for k := range doc {
			keySet[k] = true
		}
	}
	keys := make([]string, 0, len(keySet))
	if keySet["_id"] {
		keys = append(keys, "_id")
		delete(keySet, "_id")
	}
	for k := range keySet {
		keys = append(keys, k)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"items":      items,
		"keys":       keys,
		"nextCursor": nextCursor,
		"hasMore":    hasMore,
	})
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
