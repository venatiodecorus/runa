package api

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/VenatioDecorus/runa/server/internal/record"
)

// --- signing helpers (the client side of the protocol, for tests) ---

type keypair struct {
	pub  string
	priv ed25519.PrivateKey
}

func genKey(t *testing.T) keypair {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return keypair{pub: base64.RawURLEncoding.EncodeToString(pub), priv: priv}
}

// signRecord canonicalizes fields minus sig, signs with priv, and returns
// the full record's canonical JSON bytes plus its content-addressed ID.
func signRecord(t *testing.T, fields map[string]any, priv ed25519.PrivateKey) ([]byte, string) {
	t.Helper()
	sb, err := record.Canonicalize(fields)
	if err != nil {
		t.Fatalf("canonicalize signing fields: %v", err)
	}
	signed := make(map[string]any, len(fields)+1)
	for k, v := range fields {
		signed[k] = v
	}
	signed["sig"] = base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, sb))
	rec := record.FromMap(signed)
	body, err := rec.CanonicalBytes()
	if err != nil {
		t.Fatal(err)
	}
	id, err := rec.ID()
	if err != nil {
		t.Fatal(err)
	}
	return body, id
}

func deviceCert(t *testing.T, root, device keypair, kexPub, createdAt string) []byte {
	t.Helper()
	body, _ := signRecord(t, map[string]any{
		"v": 1, "type": "device-cert", "author": root.pub, "created_at": createdAt,
		"device_sign_pub": device.pub, "device_kex_pub": kexPub,
	}, root.priv)
	return body
}

// --- HTTP helpers ---

type testClient struct {
	t  *testing.T
	ts *httptest.Server
}

func (c *testClient) do(method, path, token string, body []byte) (int, map[string]json.RawMessage) {
	c.t.Helper()
	req, err := http.NewRequest(method, c.ts.URL+"/api/v1"+path, bytes.NewReader(body))
	if err != nil {
		c.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.ts.Client().Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]json.RawMessage
	if resp.StatusCode != http.StatusNoContent {
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			c.t.Fatalf("%s %s: decode response: %v", method, path, err)
		}
	}
	return resp.StatusCode, out
}

func (c *testClient) errorCode(body map[string]json.RawMessage) string {
	c.t.Helper()
	var e struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body["error"], &e); err != nil {
		c.t.Fatalf("no error object in response: %v", body)
	}
	return e.Code
}

func str(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("expected JSON string, got %s", raw)
	}
	return s
}

// signup creates an account with one certified device and returns the
// account/device keypairs.
func (c *testClient) signup(createdAt string) (root, device keypair) {
	c.t.Helper()
	root, device = genKey(c.t), genKey(c.t)
	kex := genKey(c.t) // any 32-byte b64url key works as a kex pub here
	cert := deviceCert(c.t, root, device, kex.pub, createdAt)
	reqBody, _ := json.Marshal(map[string]json.RawMessage{
		"root_pub":    json.RawMessage(`"` + root.pub + `"`),
		"device_cert": json.RawMessage(cert),
	})
	status, body := c.do("POST", "/accounts", "", reqBody)
	if status != http.StatusCreated {
		c.t.Fatalf("signup: status = %d, body %v", status, body)
	}
	if got := str(c.t, body["account"]); got != root.pub {
		c.t.Fatalf("signup account = %s, want %s", got, root.pub)
	}
	return root, device
}

// authenticate runs the challenge flow and returns a session token.
func (c *testClient) authenticate(root, device keypair) string {
	c.t.Helper()
	status, body := c.do("GET", "/auth/challenge", "", nil)
	if status != http.StatusOK {
		c.t.Fatalf("challenge: status = %d", status)
	}
	challenge := str(c.t, body["challenge"])
	sig := ed25519.Sign(device.priv, []byte("runa-auth-v1:"+challenge))
	reqBody, _ := json.Marshal(map[string]string{
		"account":   root.pub,
		"device":    device.pub,
		"challenge": challenge,
		"sig":       base64.RawURLEncoding.EncodeToString(sig),
	})
	status, body = c.do("POST", "/auth/session", "", reqBody)
	if status != http.StatusOK {
		c.t.Fatalf("session: status = %d, body %v", status, body)
	}
	return str(c.t, body["token"])
}

func newClient(t *testing.T) *testClient {
	return &testClient{t: t, ts: newTestServer(t)}
}

// --- tests ---

func TestSignupAuthPostReadback(t *testing.T) {
	c := newClient(t)
	root, device := c.signup("2026-08-20T12:00:00Z")
	c.authenticate(root, device)

	post, wantID := signRecord(t, map[string]any{
		"v": 1, "type": "post", "author": root.pub, "device": device.pub,
		"created_at": "2026-08-20T12:00:01Z", "body": "hello runa",
	}, device.priv)
	status, body := c.do("POST", "/records", "", post)
	if status != http.StatusCreated {
		t.Fatalf("post: status = %d, body %v", status, body)
	}
	if got := str(t, body["id"]); got != wantID {
		t.Fatalf("record id = %s, want %s", got, wantID)
	}

	status, body = c.do("GET", "/accounts/"+root.pub+"/records?type=post", "", nil)
	if status != http.StatusOK {
		t.Fatalf("list: status = %d", status)
	}
	var records []json.RawMessage
	if err := json.Unmarshal(body["records"], &records); err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("got %d records, want 1", len(records))
	}
	if !bytes.Equal(bytes.TrimSpace(records[0]), post) {
		t.Errorf("stored record = %s, want the exact canonical bytes %s", records[0], post)
	}
	if string(body["next_before"]) != "null" {
		t.Errorf("next_before = %s, want null", body["next_before"])
	}

	status, body = c.do("GET", "/accounts/"+root.pub, "", nil)
	if status != http.StatusOK {
		t.Fatalf("get account: status = %d", status)
	}
	if string(body["profile"]) != "null" {
		t.Errorf("profile = %s, want null", body["profile"])
	}
	var certs []json.RawMessage
	if err := json.Unmarshal(body["device_certs"], &certs); err != nil || len(certs) != 1 {
		t.Errorf("device_certs = %s, want one cert", body["device_certs"])
	}
	if string(body["follower_count"]) != "0" {
		t.Errorf("follower_count = %s, want 0", body["follower_count"])
	}
}

func TestTamperedRecordRejected(t *testing.T) {
	c := newClient(t)
	root, device := c.signup("2026-08-20T12:00:00Z")
	post, _ := signRecord(t, map[string]any{
		"v": 1, "type": "post", "author": root.pub, "device": device.pub,
		"created_at": "2026-08-20T12:00:01Z", "body": "original",
	}, device.priv)
	tampered := bytes.Replace(post, []byte(`"original"`), []byte(`"evil"`), 1)
	status, body := c.do("POST", "/records", "", tampered)
	if status != http.StatusBadRequest || c.errorCode(body) != "invalid_record" {
		t.Fatalf("status = %d code = %s, want 400 invalid_record", status, c.errorCode(body))
	}
}

func TestRevokedDeviceRejected(t *testing.T) {
	c := newClient(t)
	root, device := c.signup("2026-08-20T12:00:00Z")

	revoke, _ := signRecord(t, map[string]any{
		"v": 1, "type": "device-revoke", "author": root.pub,
		"created_at": "2026-08-21T00:00:00Z", "device_sign_pub": device.pub,
	}, root.priv)
	status, body := c.do("POST", "/records", "", revoke)
	if status != http.StatusCreated {
		t.Fatalf("revoke: status = %d, body %v", status, body)
	}

	post, _ := signRecord(t, map[string]any{
		"v": 1, "type": "post", "author": root.pub, "device": device.pub,
		"created_at": "2026-08-21T00:00:01Z", "body": "too late",
	}, device.priv)
	status, body = c.do("POST", "/records", "", post)
	if status != http.StatusForbidden || c.errorCode(body) != "revoked_device" {
		t.Fatalf("status = %d code = %s, want 403 revoked_device", status, c.errorCode(body))
	}

	// Pre-revocation records remain valid: revocation is not retroactive.
	earlier, _ := signRecord(t, map[string]any{
		"v": 1, "type": "post", "author": root.pub, "device": device.pub,
		"created_at": "2026-08-20T23:59:59Z", "body": "still fine",
	}, device.priv)
	if status, body = c.do("POST", "/records", "", earlier); status != http.StatusCreated {
		t.Fatalf("pre-revocation post: status = %d, body %v", status, body)
	}

	// A revoked device can no longer authenticate.
	status, resp := c.do("GET", "/auth/challenge", "", nil)
	if status != http.StatusOK {
		t.Fatal("challenge failed")
	}
	challenge := str(t, resp["challenge"])
	sig := ed25519.Sign(device.priv, []byte("runa-auth-v1:"+challenge))
	authReq, _ := json.Marshal(map[string]string{
		"account": root.pub, "device": device.pub, "challenge": challenge,
		"sig": base64.RawURLEncoding.EncodeToString(sig),
	})
	status, body = c.do("POST", "/auth/session", "", authReq)
	if status != http.StatusForbidden || c.errorCode(body) != "revoked_device" {
		t.Fatalf("auth with revoked device: status = %d code = %s, want 403 revoked_device", status, c.errorCode(body))
	}
}

func TestUnknownTypeRejected(t *testing.T) {
	c := newClient(t)
	root, device := c.signup("2026-08-20T12:00:00Z")
	rec, _ := signRecord(t, map[string]any{
		"v": 1, "type": "follow", "author": root.pub, "device": device.pub,
		"created_at": "2026-08-20T12:00:01Z", "subject": root.pub,
	}, device.priv)
	status, body := c.do("POST", "/records", "", rec)
	if status != http.StatusBadRequest || c.errorCode(body) != "unknown_type" {
		t.Fatalf("status = %d code = %s, want 400 unknown_type", status, c.errorCode(body))
	}
}

func TestBackupRoundtrip(t *testing.T) {
	c := newClient(t)
	root, device := c.signup("2026-08-20T12:00:00Z")
	token := c.authenticate(root, device)

	blob := `{"v":1,"salt":"c2FsdA","nonce":"bm9uY2U","ciphertext":"Y3Q"}`
	reqBody := []byte(`{"blob":` + blob + `}`)

	if status, _ := c.do("POST", "/backup", "", reqBody); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated backup: status = %d, want 401", status)
	}
	if status, _ := c.do("POST", "/backup", token, reqBody); status != http.StatusNoContent {
		t.Fatalf("backup upsert: status = %d, want 204", status)
	}

	status, body := c.do("GET", "/backup/"+root.pub, "", nil)
	if status != http.StatusOK {
		t.Fatalf("backup fetch: status = %d", status)
	}
	if string(bytes.TrimSpace(body["blob"])) != blob {
		t.Errorf("blob = %s, want %s", body["blob"], blob)
	}

	// Overwrite is allowed: one blob per account.
	blob2 := []byte(`{"blob":{"v":1,"salt":"bmV3","nonce":"bm9uY2U","ciphertext":"Y3Qy"}}`)
	if status, _ := c.do("POST", "/backup", token, blob2); status != http.StatusNoContent {
		t.Fatalf("backup overwrite: status = %d, want 204", status)
	}
	other := genKey(t)
	if status, _ := c.do("GET", "/backup/"+other.pub, "", nil); status != http.StatusNotFound {
		t.Fatalf("missing backup: status = %d, want 404", status)
	}
}

func TestPagination(t *testing.T) {
	c := newClient(t)
	root, device := c.signup("2026-08-20T12:00:00Z")
	for _, ts := range []string{"2026-08-20T13:00:00Z", "2026-08-20T13:00:01Z", "2026-08-20T13:00:02Z"} {
		post, _ := signRecord(t, map[string]any{
			"v": 1, "type": "post", "author": root.pub, "device": device.pub,
			"created_at": ts, "body": "at " + ts,
		}, device.priv)
		if status, body := c.do("POST", "/records", "", post); status != http.StatusCreated {
			t.Fatalf("post: status = %d, body %v", status, body)
		}
	}
	status, body := c.do("GET", "/accounts/"+root.pub+"/records?type=post&limit=2", "", nil)
	if status != http.StatusOK {
		t.Fatalf("page 1: status = %d", status)
	}
	nextBefore := str(t, body["next_before"])
	if nextBefore != "2026-08-20T13:00:01Z" {
		t.Fatalf("next_before = %s, want 2026-08-20T13:00:01Z", nextBefore)
	}
	status, body = c.do("GET", "/accounts/"+root.pub+"/records?type=post&limit=2&before="+nextBefore, "", nil)
	if status != http.StatusOK {
		t.Fatalf("page 2: status = %d", status)
	}
	var page2 []struct {
		CreatedAt string `json:"created_at"`
	}
	if err := json.Unmarshal(body["records"], &page2); err != nil {
		t.Fatal(err)
	}
	if len(page2) != 1 || page2[0].CreatedAt != "2026-08-20T13:00:00Z" {
		t.Fatalf("page 2 = %v, want the single oldest post", page2)
	}
	if string(body["next_before"]) != "null" {
		t.Errorf("final next_before = %s, want null", body["next_before"])
	}
}

func TestChallengeSingleUse(t *testing.T) {
	c := newClient(t)
	root, device := c.signup("2026-08-20T12:00:00Z")
	_, resp := c.do("GET", "/auth/challenge", "", nil)
	challenge := str(t, resp["challenge"])
	sig := ed25519.Sign(device.priv, []byte("runa-auth-v1:"+challenge))
	authReq, _ := json.Marshal(map[string]string{
		"account": root.pub, "device": device.pub, "challenge": challenge,
		"sig": base64.RawURLEncoding.EncodeToString(sig),
	})
	if status, body := c.do("POST", "/auth/session", "", authReq); status != http.StatusOK {
		t.Fatalf("first use: status = %d, body %v", status, body)
	}
	status, body := c.do("POST", "/auth/session", "", authReq)
	if status != http.StatusBadRequest || c.errorCode(body) != "invalid_challenge" {
		t.Fatalf("second use: status = %d code = %s, want 400 invalid_challenge", status, c.errorCode(body))
	}
}
