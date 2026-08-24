package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
)

// attestation signs and submits an attestation record, asserting 201.
func (c *testClient) attestation(root, device keypair, subject, method, createdAt string) []byte {
	c.t.Helper()
	body, _ := signRecord(c.t, map[string]any{
		"v": 1, "type": "attestation", "author": root.pub, "device": device.pub,
		"created_at": createdAt, "subject": subject, "subject_root_pub": subject, "method": method,
	}, device.priv)
	status, resp := c.do("POST", "/records", "", body)
	if status != http.StatusCreated {
		c.t.Fatalf("attestation: status = %d, body %v", status, resp)
	}
	return body
}

// attestationRevoke signs and submits an attestation-revoke record,
// asserting 201.
func (c *testClient) attestationRevoke(root, device keypair, subject, createdAt string) []byte {
	c.t.Helper()
	body, _ := signRecord(c.t, map[string]any{
		"v": 1, "type": "attestation-revoke", "author": root.pub, "device": device.pub,
		"created_at": createdAt, "subject": subject,
	}, device.priv)
	status, resp := c.do("POST", "/records", "", body)
	if status != http.StatusCreated {
		c.t.Fatalf("attestation-revoke: status = %d, body %v", status, resp)
	}
	return body
}

type attestationsResponse struct {
	Attestations []json.RawMessage          `json:"attestations"`
	Authors      map[string]json.RawMessage `json:"authors"`
	NextBefore   *string                    `json:"next_before"`
}

func (c *testClient) getAttestations(id, query string) attestationsResponse {
	c.t.Helper()
	status, body := c.do("GET", "/accounts/"+id+"/attestations"+query, "", nil)
	if status != http.StatusOK {
		c.t.Fatalf("get attestations: status = %d, body %v", status, body)
	}
	var resp attestationsResponse
	mustDecode(c.t, body, &resp)
	return resp
}

// TestAttestationIngestValidityMatrix covers docs/protocol.md §6's ingest
// rules for attestation/attestation-revoke/domain-claim beyond signature +
// cert chain: unknown subject, subject_root_pub mismatch, unknown method,
// self-attestation, bad domain, and a tampered signature.
func TestAttestationIngestValidityMatrix(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z") // attester
	rootB, _ := c.signup("2026-08-20T12:00:00Z")    // subject

	// Valid attestation.
	c.attestation(rootA, devA, rootB.pub, "safety-number", "2026-08-24T12:00:00Z")

	// Unknown subject account -> 400 unknown_account.
	ghost := genKey(t)
	rec, _ := signRecord(t, map[string]any{
		"v": 1, "type": "attestation", "author": rootA.pub, "device": devA.pub,
		"created_at": "2026-08-24T12:00:01Z", "subject": ghost.pub, "subject_root_pub": ghost.pub, "method": "qr",
	}, devA.priv)
	status, body := c.do("POST", "/records", "", rec)
	if status != http.StatusBadRequest || c.errorCode(body) != "unknown_account" {
		t.Fatalf("unknown subject: status = %d code = %s, want 400 unknown_account", status, c.errorCode(body))
	}

	// attestation-revoke with an unknown subject -> also unknown_account.
	rec, _ = signRecord(t, map[string]any{
		"v": 1, "type": "attestation-revoke", "author": rootA.pub, "device": devA.pub,
		"created_at": "2026-08-24T12:00:01Z", "subject": ghost.pub,
	}, devA.priv)
	status, body = c.do("POST", "/records", "", rec)
	if status != http.StatusBadRequest || c.errorCode(body) != "unknown_account" {
		t.Fatalf("revoke of unknown subject: status = %d code = %s, want 400 unknown_account", status, c.errorCode(body))
	}

	// subject_root_pub mismatch -> 400 invalid_record.
	rec, _ = signRecord(t, map[string]any{
		"v": 1, "type": "attestation", "author": rootA.pub, "device": devA.pub,
		"created_at": "2026-08-24T12:00:02Z", "subject": rootB.pub, "subject_root_pub": rootA.pub, "method": "qr",
	}, devA.priv)
	status, body = c.do("POST", "/records", "", rec)
	if status != http.StatusBadRequest || c.errorCode(body) != "invalid_record" {
		t.Fatalf("subject_root_pub mismatch: status = %d code = %s, want 400 invalid_record", status, c.errorCode(body))
	}

	// Unknown method -> 400 invalid_record.
	rec, _ = signRecord(t, map[string]any{
		"v": 1, "type": "attestation", "author": rootA.pub, "device": devA.pub,
		"created_at": "2026-08-24T12:00:03Z", "subject": rootB.pub, "subject_root_pub": rootB.pub, "method": "vibes",
	}, devA.priv)
	status, body = c.do("POST", "/records", "", rec)
	if status != http.StatusBadRequest || c.errorCode(body) != "invalid_record" {
		t.Fatalf("unknown method: status = %d code = %s, want 400 invalid_record", status, c.errorCode(body))
	}

	// Self-attestation -> 400 invalid_record.
	rec, _ = signRecord(t, map[string]any{
		"v": 1, "type": "attestation", "author": rootA.pub, "device": devA.pub,
		"created_at": "2026-08-24T12:00:04Z", "subject": rootA.pub, "subject_root_pub": rootA.pub, "method": "qr",
	}, devA.priv)
	status, body = c.do("POST", "/records", "", rec)
	if status != http.StatusBadRequest || c.errorCode(body) != "invalid_record" {
		t.Fatalf("self-attestation: status = %d code = %s, want 400 invalid_record", status, c.errorCode(body))
	}

	// Bad domain (scheme included) -> 400 invalid_record.
	rec, _ = signRecord(t, map[string]any{
		"v": 1, "type": "domain-claim", "author": rootA.pub, "device": devA.pub,
		"created_at": "2026-08-24T12:00:05Z", "domain": "https://example.com",
	}, devA.priv)
	status, body = c.do("POST", "/records", "", rec)
	if status != http.StatusBadRequest || c.errorCode(body) != "invalid_record" {
		t.Fatalf("bad domain: status = %d code = %s, want 400 invalid_record", status, c.errorCode(body))
	}

	// Tampered signature -> 400 invalid_record (the generic signature path,
	// not the type-specific validator).
	good, _ := signRecord(t, map[string]any{
		"v": 1, "type": "attestation", "author": rootA.pub, "device": devA.pub,
		"created_at": "2026-08-24T12:00:06Z", "subject": rootB.pub, "subject_root_pub": rootB.pub, "method": "qr",
	}, devA.priv)
	tampered := bytes.Replace(good, []byte(`"qr"`), []byte(`"safety-number"`), 1)
	status, body = c.do("POST", "/records", "", tampered)
	if status != http.StatusBadRequest || c.errorCode(body) != "invalid_record" {
		t.Fatalf("tampered sig: status = %d code = %s, want 400 invalid_record", status, c.errorCode(body))
	}
}

// TestAttestationRevokeSupersession covers latest-wins per (attester,
// subject) with the §8.1 tie-break: a revoke with created_at >= the
// attestation's supersedes it, in either arrival order.
func TestAttestationRevokeSupersession(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootB, _ := c.signup("2026-08-20T12:00:00Z")

	c.attestation(rootA, devA, rootB.pub, "safety-number", "2026-08-24T12:00:00Z")
	if resp := c.getAttestations(rootB.pub, ""); len(resp.Attestations) != 1 {
		t.Fatalf("after attest: got %d, want 1", len(resp.Attestations))
	}

	// A later revoke supersedes it.
	c.attestationRevoke(rootA, devA, rootB.pub, "2026-08-25T12:00:00Z")
	if resp := c.getAttestations(rootB.pub, ""); len(resp.Attestations) != 0 {
		t.Fatalf("after revoke: got %d, want 0", len(resp.Attestations))
	}

	// Re-attesting with a newer created_at reinstates it.
	c.attestation(rootA, devA, rootB.pub, "qr", "2026-08-26T12:00:00Z")
	if resp := c.getAttestations(rootB.pub, ""); len(resp.Attestations) != 1 {
		t.Fatalf("after re-attest: got %d, want 1", len(resp.Attestations))
	}

	// Tie case: a revoke with a created_at identical to the stored
	// attestation's supersedes it.
	c.attestationRevoke(rootA, devA, rootB.pub, "2026-08-26T12:00:00Z")
	if resp := c.getAttestations(rootB.pub, ""); len(resp.Attestations) != 0 {
		t.Fatalf("after tied revoke: got %d, want 0", len(resp.Attestations))
	}

	// Tie the other direction: the revoke lands first, then an attestation
	// with the identical created_at arrives — ties favor the revoke
	// regardless of arrival order, so it must not reinstate.
	rootC, _ := c.signup("2026-08-20T12:00:00Z")
	c.attestationRevoke(rootA, devA, rootC.pub, "2026-08-27T12:00:00Z")
	c.attestation(rootA, devA, rootC.pub, "qr", "2026-08-27T12:00:00Z")
	if resp := c.getAttestations(rootC.pub, ""); len(resp.Attestations) != 0 {
		t.Fatalf("attestation tied with a pre-existing revoke: got %d, want 0", len(resp.Attestations))
	}
}

// TestAttestationsEndpoint covers GET /accounts/{id}/attestations:
// unauthenticated access, the authors bundle (cert + profile), pagination,
// and the unknown-account 404.
func TestAttestationsEndpoint(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z") // attester 1
	rootB, devB := c.signup("2026-08-20T12:00:00Z") // attester 2
	rootS, _ := c.signup("2026-08-20T12:00:00Z")    // subject

	profile, _ := signRecord(t, map[string]any{
		"v": 1, "type": "profile", "author": rootA.pub, "device": devA.pub,
		"created_at": "2026-08-20T12:30:00Z", "display_name": "A",
	}, devA.priv)
	if status, _ := c.do("POST", "/records", "", profile); status != http.StatusCreated {
		t.Fatal("profile submit failed")
	}

	c.attestation(rootA, devA, rootS.pub, "safety-number", "2026-08-24T12:00:00Z")
	c.attestation(rootB, devB, rootS.pub, "qr", "2026-08-24T12:00:01Z")

	resp := c.getAttestations(rootS.pub, "")
	if len(resp.Attestations) != 2 {
		t.Fatalf("attestations = %d, want 2", len(resp.Attestations))
	}
	if len(resp.Authors) != 2 {
		t.Fatalf("authors = %d, want 2", len(resp.Authors))
	}
	aBundle, ok := resp.Authors[rootA.pub]
	if !ok {
		t.Fatalf("authors missing %s", rootA.pub)
	}
	var bundle struct {
		DeviceCerts []json.RawMessage `json:"device_certs"`
		Profile     json.RawMessage   `json:"profile"`
	}
	if err := json.Unmarshal(aBundle, &bundle); err != nil {
		t.Fatal(err)
	}
	if len(bundle.DeviceCerts) != 1 {
		t.Errorf("attester A device_certs = %d, want 1", len(bundle.DeviceCerts))
	}
	if !bytes.Equal(bytes.TrimSpace(bundle.Profile), profile) {
		t.Errorf("attester A profile = %s, want %s", bundle.Profile, profile)
	}

	// Pagination: limit=1 forces a second page, newest first.
	page1 := c.getAttestations(rootS.pub, "?limit=1")
	if len(page1.Attestations) != 1 {
		t.Fatalf("page1 = %d, want 1", len(page1.Attestations))
	}
	if page1.NextBefore == nil {
		t.Fatal("page1 next_before = nil, want set")
	}
	page2 := c.getAttestations(rootS.pub, "?limit=1&before="+*page1.NextBefore)
	if len(page2.Attestations) != 1 {
		t.Fatalf("page2 = %d, want 1", len(page2.Attestations))
	}
	if string(page1.Attestations[0]) == string(page2.Attestations[0]) {
		t.Fatal("page1 and page2 returned the same record")
	}

	// Unknown account -> 404 not_found.
	ghost := genKey(t)
	status, body := c.do("GET", "/accounts/"+ghost.pub+"/attestations", "", nil)
	if status != http.StatusNotFound || c.errorCode(body) != "not_found" {
		t.Fatalf("unknown account: status = %d code = %s, want 404 not_found", status, c.errorCode(body))
	}
}

// TestDomainClaimPublicListing covers §8.4: a domain-claim record is
// accepted and appears, unauthenticated, in the author's public record
// listing.
func TestDomainClaimPublicListing(t *testing.T) {
	c := newClient(t)
	root, dev := c.signup("2026-08-20T12:00:00Z")
	claim, _ := signRecord(t, map[string]any{
		"v": 1, "type": "domain-claim", "author": root.pub, "device": dev.pub,
		"created_at": "2026-08-24T12:00:00Z", "domain": "example.com",
	}, dev.priv)
	status, body := c.do("POST", "/records", "", claim)
	if status != http.StatusCreated {
		t.Fatalf("domain-claim: status = %d, body %v", status, body)
	}
	status, body = c.do("GET", "/accounts/"+root.pub+"/records?type=domain-claim", "", nil)
	if status != http.StatusOK {
		t.Fatalf("list domain-claim: status = %d", status)
	}
	var records []json.RawMessage
	if err := json.Unmarshal(body["records"], &records); err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || !bytes.Equal(bytes.TrimSpace(records[0]), claim) {
		t.Fatalf("records = %s, want [%s]", records, claim)
	}
}

// TestAttestationNotMetered covers §8.1: attestation records are never
// metered, so a zero-trust stranger's attestation costs no cold-outreach
// token.
func TestAttestationNotMetered(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z") // sender: no followers, zero trust
	rootB, _ := c.signup("2026-08-20T12:00:00Z")    // subject: never interacted with A
	tokenA := c.authenticate(rootA, devA)

	before := c.budget(tokenA)
	c.attestation(rootA, devA, rootB.pub, "qr", "2026-08-24T12:00:00Z")
	after := c.budget(tokenA)

	if after.Tokens != before.Tokens {
		t.Errorf("tokens changed after an unmetered attestation: before = %v, after = %v", before.Tokens, after.Tokens)
	}
}
