package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/VenatioDecorus/runa/server/internal/store"
)

func TestImageboardMode(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ts := httptest.NewServer(New(st, Config{InstanceName: "ib", Imageboard: true}))
	t.Cleanup(ts.Close)
	c := &testClient{t: t, ts: ts}

	// /meta discloses the mode.
	status, meta := c.do("GET", "/meta", "", nil)
	if status != http.StatusOK {
		t.Fatalf("meta: status = %d", status)
	}
	var mode bool
	if err := json.Unmarshal(meta["imageboard_mode"], &mode); err != nil || !mode {
		t.Fatalf("imageboard_mode not disclosed in /meta: %v %v", meta["imageboard_mode"], err)
	}

	// profile records are rejected with 403 profile_disabled; posts still work.
	root, device := c.signup("2026-08-21T10:00:00Z")
	profile, _ := signRecord(t, map[string]any{
		"v": 1, "type": "profile", "author": root.pub, "device": device.pub,
		"created_at": "2026-08-21T10:00:01Z", "display_name": "nope",
	}, device.priv)
	status, resp := c.do("POST", "/records", "", profile)
	if status != http.StatusForbidden || c.errorCode(resp) != "profile_disabled" {
		t.Fatalf("profile in imageboard mode: got %d %s, want 403 profile_disabled", status, c.errorCode(resp))
	}
	c.post(root, device, "content is identity", "2026-08-21T10:00:02Z")

	// The default (non-imageboard) server still discloses the mode as false.
	c2 := newClient(t)
	_, meta2 := c2.do("GET", "/meta", "", nil)
	if err := json.Unmarshal(meta2["imageboard_mode"], &mode); err != nil || mode {
		t.Fatalf("default instance should publish imageboard_mode=false: %v", meta2["imageboard_mode"])
	}
}
