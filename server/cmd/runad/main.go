package main

import (
	"flag"
	"log"
	"net/http"
	"os"

	"github.com/VenatioDecorus/runa/server/internal/api"
	"github.com/VenatioDecorus/runa/server/internal/store"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	addr := flag.String("addr", envOr("RUNAD_ADDR", ":8080"), "listen address")
	dbPath := flag.String("db", envOr("RUNAD_DB", "./runa.db"), "path to SQLite database")
	instanceName := flag.String("instance-name", envOr("RUNAD_INSTANCE_NAME", "runa-dev"), "instance name published via /api/v1/meta")
	flag.Parse()

	st, err := store.Open(*dbPath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()

	handler := api.New(st, api.Config{InstanceName: *instanceName})
	log.Printf("runad listening on %s (db: %s)", *addr, *dbPath)
	if err := http.ListenAndServe(*addr, handler); err != nil {
		log.Fatal(err)
	}
}
