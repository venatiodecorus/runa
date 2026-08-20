package api

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/VenatioDecorus/runa/server/internal/store"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	ts := httptest.NewServer(New(st, Config{InstanceName: "test"}))
	t.Cleanup(ts.Close)
	return ts
}

func TestHealthz(t *testing.T) {
	ts := newTestServer(t)
	resp, err := ts.Client().Get(ts.URL + "/api/v1/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
}

func TestMeta(t *testing.T) {
	ts := newTestServer(t)
	resp, err := ts.Client().Get(ts.URL + "/api/v1/meta")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Name            string         `json:"name"`
		ProtocolVersion string         `json:"protocol_version"`
		Constants       map[string]any `json:"constants"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Name != "test" || body.ProtocolVersion != "1" {
		t.Fatalf("unexpected meta: %+v", body)
	}
	if body.Constants["per_hop_decay"] != 0.35 {
		t.Fatalf("per_hop_decay = %v, want 0.35", body.Constants["per_hop_decay"])
	}
}
