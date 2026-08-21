package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
)

// dmFields builds a structurally-valid tier-2 envelope (protocol §4). The
// nonce/ciphertext/recipient contents are arbitrary well-shaped strings —
// the server treats them as opaque and never attempts decryption, so the
// API tests need no real cryptography.
func dmFields(root, device keypair, to, createdAt string) map[string]any {
	return map[string]any{
		"v": 1, "type": "dm", "alg": "x25519-hkdf-sha256+xchacha20poly1305",
		"author": root.pub, "device": device.pub, "created_at": createdAt,
		"to":    to,
		"nonce": "ISMlJykrLS8xMzU3OTs9P0FDRUdJS01P",
		"recipients": []any{map[string]any{
			"device":      device.pub,
			"eph_pub":     "kAtA1UP7cYSWq-ptwZFEG6rATvyzLAJrmRnJ3aGz1wo",
			"wrap_nonce":  "WVtdX2FjZWdpa21vcXN1d3l7fX-Bg4WH",
			"wrapped_key": "b3BhcXVlLXdyYXBwZWQta2V5",
		}},
		"ciphertext": "b3BhcXVlLWNpcGhlcnRleHQtYnl0ZXM",
	}
}

// dm signs and submits a dm record, asserting 201, and returns its
// canonical bytes.
func (c *testClient) dm(root, device keypair, to, createdAt string) []byte {
	c.t.Helper()
	body, _ := signRecord(c.t, dmFields(root, device, to, createdAt), device.priv)
	status, resp := c.do("POST", "/records", "", body)
	if status != http.StatusCreated {
		c.t.Fatalf("dm: status = %d, body %v", status, resp)
	}
	return body
}

func (c *testClient) dmWith(token, id, query string) ([]json.RawMessage, json.RawMessage) {
	c.t.Helper()
	status, body := c.do("GET", "/dm/with/"+id+query, token, nil)
	if status != http.StatusOK {
		c.t.Fatalf("dm/with/%s: status = %d, body %v", id, status, body)
	}
	var records []json.RawMessage
	if err := json.Unmarshal(body["records"], &records); err != nil {
		c.t.Fatalf("records = %s", body["records"])
	}
	return records, body["next_before"]
}

type inboxEntry struct {
	With    string          `json:"with"`
	Last    json.RawMessage `json:"last"`
	Request bool            `json:"request"`
}

func (c *testClient) inbox(token string) []inboxEntry {
	c.t.Helper()
	status, body := c.do("GET", "/dm/inbox", token, nil)
	if status != http.StatusOK {
		c.t.Fatalf("dm/inbox: status = %d, body %v", status, body)
	}
	var entries []inboxEntry
	if err := json.Unmarshal(body["conversations"], &entries); err != nil {
		c.t.Fatalf("conversations = %s", body["conversations"])
	}
	return entries
}

func TestDMRoundtrip(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootB, devB := c.signup("2026-08-20T12:00:00Z")
	tokenA := c.authenticate(rootA, devA)
	tokenB := c.authenticate(rootB, devB)

	dmAB := c.dm(rootA, devA, rootB.pub, "2026-08-20T13:00:00Z")
	dmBA := c.dm(rootB, devB, rootA.pub, "2026-08-20T13:00:01Z")

	// Both endpoints require auth.
	if status, _ := c.do("GET", "/dm/with/"+rootB.pub, "", nil); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated dm/with: status = %d, want 401", status)
	}
	if status, _ := c.do("GET", "/dm/inbox", "", nil); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated dm/inbox: status = %d, want 401", status)
	}

	// Each side sees the same conversation, oldest→newest, verbatim bytes.
	for _, side := range []struct {
		token, other string
	}{{tokenA, rootB.pub}, {tokenB, rootA.pub}} {
		records, nextBefore := c.dmWith(side.token, side.other, "")
		if len(records) != 2 {
			t.Fatalf("dm/with/%s: %d records, want 2", side.other, len(records))
		}
		if !bytes.Equal(bytes.TrimSpace(records[0]), dmAB) || !bytes.Equal(bytes.TrimSpace(records[1]), dmBA) {
			t.Errorf("dm/with/%s is not the exact canonical bytes oldest→newest", side.other)
		}
		if string(nextBefore) != "null" {
			t.Errorf("next_before = %s, want null", nextBefore)
		}
	}

	// One inbox conversation on each side; both have sent, so no request
	// classification; `last` is the newest record of the pair.
	for _, side := range []struct {
		token, with string
	}{{tokenA, rootB.pub}, {tokenB, rootA.pub}} {
		entries := c.inbox(side.token)
		if len(entries) != 1 {
			t.Fatalf("inbox: %d conversations, want 1", len(entries))
		}
		e := entries[0]
		if e.With != side.with || e.Request {
			t.Errorf("inbox entry = {with: %s, request: %v}, want {%s, false}", e.With, e.Request, side.with)
		}
		if !bytes.Equal(bytes.TrimSpace(e.Last), dmBA) {
			t.Errorf("inbox last = %s, want the newest dm verbatim", e.Last)
		}
	}

	// Unknown counterparty → 404.
	ghost := genKey(t)
	if status, _ := c.do("GET", "/dm/with/"+ghost.pub, tokenA, nil); status != http.StatusNotFound {
		t.Fatalf("dm/with unknown account: status = %d, want 404", status)
	}
}

func TestDMThirdPartyCannotSee(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootB, devB := c.signup("2026-08-20T12:00:00Z")
	rootC, devC := c.signup("2026-08-20T12:00:00Z")
	tokenC := c.authenticate(rootC, devC)

	c.dm(rootA, devA, rootB.pub, "2026-08-20T13:00:00Z")
	c.dm(rootB, devB, rootA.pub, "2026-08-20T13:00:01Z")

	// C's pair views with either participant are empty: /dm/with/{id} only
	// ever serves conversations the viewer is a party to.
	for _, id := range []string{rootA.pub, rootB.pub} {
		if records, _ := c.dmWith(tokenC, id, ""); len(records) != 0 {
			t.Fatalf("third party sees %d records via dm/with/%s", len(records), id)
		}
	}
	if entries := c.inbox(tokenC); len(entries) != 0 {
		t.Fatalf("third party inbox has %d conversations, want 0", len(entries))
	}

	// The public records listing never serves dm records — not unfiltered,
	// not via the type filter.
	c.graphRecord("follow", rootC, devC, rootA.pub, "2026-08-20T13:00:02Z")
	for _, path := range []string{
		"/accounts/" + rootA.pub + "/records",
		"/accounts/" + rootA.pub + "/records?type=dm",
		"/feed",
	} {
		status, body := c.do("GET", path, tokenC, nil)
		if status != http.StatusOK {
			t.Fatalf("%s: status = %d", path, status)
		}
		raw, _ := json.Marshal(body)
		if bytes.Contains(raw, []byte(`"dm"`)) || bytes.Contains(raw, []byte("b3BhcXVlLWNpcGhlcnRleHQ")) {
			t.Fatalf("%s leaked dm content: %s", path, raw)
		}
	}
}

func TestDMRequestClassification(t *testing.T) {
	c := newClient(t)
	rootS, devS := c.signup("2026-08-20T12:00:00Z") // stranger
	rootB, devB := c.signup("2026-08-20T12:00:00Z") // viewer under test
	rootF, devF := c.signup("2026-08-20T12:00:00Z") // followee of B
	tokenS := c.authenticate(rootS, devS)
	tokenB := c.authenticate(rootB, devB)

	// A stranger's dm lands as a request for the recipient...
	c.dm(rootS, devS, rootB.pub, "2026-08-20T13:00:00Z")
	entries := c.inbox(tokenB)
	if len(entries) != 1 || entries[0].With != rootS.pub || !entries[0].Request {
		t.Fatalf("stranger dm: inbox = %+v, want [{with: S, request: true}]", entries)
	}
	// ...but never for the sender's own view of the conversation.
	entries = c.inbox(tokenS)
	if len(entries) != 1 || entries[0].With != rootB.pub || entries[0].Request {
		t.Fatalf("sender inbox = %+v, want [{with: B, request: false}]", entries)
	}

	// Once the recipient replies, they have sent into the conversation:
	// their own entry stops being a request even without a trust path.
	c.dm(rootB, devB, rootS.pub, "2026-08-20T13:30:00Z")
	entries = c.inbox(tokenB)
	if len(entries) != 1 || entries[0].Request {
		t.Fatalf("after reply: inbox = %+v, want request: false", entries)
	}

	// A dm from someone the viewer has a trust path to (direct follow) is
	// never a request, even though the viewer hasn't sent anything.
	c.graphRecord("follow", rootB, devB, rootF.pub, "2026-08-20T14:00:00Z")
	c.dm(rootF, devF, rootB.pub, "2026-08-20T14:30:00Z")
	entries = c.inbox(tokenB)
	if len(entries) != 2 {
		t.Fatalf("inbox has %d conversations, want 2", len(entries))
	}
	// Sorted by last activity desc: F (14:30) before S (13:30).
	if entries[0].With != rootF.pub || entries[0].Request {
		t.Errorf("entry 0 = %+v, want {with: F, request: false}", entries[0])
	}
	if entries[1].With != rootS.pub || entries[1].Request {
		t.Errorf("entry 1 = %+v, want {with: S, request: false}", entries[1])
	}
}

func TestDMRevokedDeviceRejected(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootB, _ := c.signup("2026-08-20T12:00:00Z")

	revoke, _ := signRecord(t, map[string]any{
		"v": 1, "type": "device-revoke", "author": rootA.pub,
		"created_at": "2026-08-21T00:00:00Z", "device_sign_pub": devA.pub,
	}, rootA.priv)
	if status, _ := c.do("POST", "/records", "", revoke); status != http.StatusCreated {
		t.Fatal("revoke submit failed")
	}

	body, _ := signRecord(t, dmFields(rootA, devA, rootB.pub, "2026-08-21T00:00:01Z"), devA.priv)
	status, resp := c.do("POST", "/records", "", body)
	if status != http.StatusForbidden || c.errorCode(resp) != "revoked_device" {
		t.Fatalf("status = %d code = %s, want 403 revoked_device", status, c.errorCode(resp))
	}
}

func TestDMValidationRejects(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootB, _ := c.signup("2026-08-20T12:00:00Z")

	submit := func(mutate func(map[string]any)) (int, string) {
		fields := dmFields(rootA, devA, rootB.pub, "2026-08-20T13:00:00Z")
		mutate(fields)
		body, _ := signRecord(t, fields, devA.priv)
		status, resp := c.do("POST", "/records", "", body)
		return status, c.errorCode(resp)
	}

	// Unknown alg → unsupported_alg (reject, never guess).
	if status, code := submit(func(f map[string]any) { f["alg"] = "x25519-hkdf-sha256+aes256gcm" }); status != http.StatusBadRequest || code != "unsupported_alg" {
		t.Errorf("unknown alg: status = %d code = %s, want 400 unsupported_alg", status, code)
	}
	// `to` must name a local account: well-formed-but-absent and malformed
	// both → unknown_account.
	offInstance := genKey(t)
	if status, code := submit(func(f map[string]any) { f["to"] = offInstance.pub }); status != http.StatusBadRequest || code != "unknown_account" {
		t.Errorf("off-instance to: status = %d code = %s, want 400 unknown_account", status, code)
	}
	if status, code := submit(func(f map[string]any) { f["to"] = "not-b64url!!" }); status != http.StatusBadRequest || code != "unknown_account" {
		t.Errorf("malformed to: status = %d code = %s, want 400 unknown_account", status, code)
	}
	// Structural failures → invalid_record.
	for name, mutate := range map[string]func(map[string]any){
		"empty nonce":          func(f map[string]any) { f["nonce"] = "" },
		"empty ciphertext":     func(f map[string]any) { f["ciphertext"] = "" },
		"missing ciphertext":   func(f map[string]any) { delete(f, "ciphertext") },
		"empty recipients":     func(f map[string]any) { f["recipients"] = []any{} },
		"missing recipients":   func(f map[string]any) { delete(f, "recipients") },
		"non-object recipient": func(f map[string]any) { f["recipients"] = []any{"nope"} },
		"recipient missing field": func(f map[string]any) {
			f["recipients"] = []any{map[string]any{"device": devA.pub, "eph_pub": "eA", "wrap_nonce": "bg"}}
		},
	} {
		if status, code := submit(mutate); status != http.StatusBadRequest || code != "invalid_record" {
			t.Errorf("%s: status = %d code = %s, want 400 invalid_record", name, status, code)
		}
	}

	// A valid envelope still passes after all the rejects.
	c.dm(rootA, devA, rootB.pub, "2026-08-20T13:00:01Z")
}

func TestDMPagination(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootB, devB := c.signup("2026-08-20T12:00:00Z")
	tokenB := c.authenticate(rootB, devB)

	stamps := []string{"2026-08-20T13:00:00Z", "2026-08-20T13:00:01Z", "2026-08-20T13:00:02Z"}
	sent := make([][]byte, len(stamps))
	for i, ts := range stamps {
		sent[i] = c.dm(rootA, devA, rootB.pub, ts)
	}

	// Page 1 holds the newest two, still oldest→newest within the page.
	records, nextBefore := c.dmWith(tokenB, rootA.pub, "?limit=2")
	if len(records) != 2 ||
		!bytes.Equal(bytes.TrimSpace(records[0]), sent[1]) ||
		!bytes.Equal(bytes.TrimSpace(records[1]), sent[2]) {
		t.Fatalf("page 1 = %s, want the newest two dms oldest→newest", records)
	}
	if got := str(t, nextBefore); got != stamps[1] {
		t.Fatalf("next_before = %s, want %s", got, stamps[1])
	}

	// Page 2 walks backwards past the cursor to the oldest message.
	records, nextBefore = c.dmWith(tokenB, rootA.pub, "?limit=2&before="+stamps[1])
	if len(records) != 1 || !bytes.Equal(bytes.TrimSpace(records[0]), sent[0]) {
		t.Fatalf("page 2 = %s, want just the oldest dm", records)
	}
	if string(nextBefore) != "null" {
		t.Errorf("final next_before = %s, want null", nextBefore)
	}
}
