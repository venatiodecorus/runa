package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/VenatioDecorus/runa/server/internal/store"
)

// --- M7 test helpers (docs/protocol.md §9) ---

// newStandingServer builds a client whose server runs on an injected clock
// and (optionally) an operator token, and hands back the store so tests can
// seed adjudication state directly. Seeding `standing` rows is how the
// enforcement tests avoid staging a full mass-reporting campaign for every
// assertion — the campaign itself is exercised end-to-end by
// TestStandingMassCapsAndOpensReview.
func newStandingServer(t *testing.T, now func() time.Time, adminToken string) (*testClient, *store.Store) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	ts := httptest.NewServer(New(st, Config{InstanceName: "test", Now: now, AdminToken: adminToken}))
	t.Cleanup(ts.Close)
	return &testClient{t: t, ts: ts}, st
}

// reportFields builds a §9.1 report record. Optional fields are omitted
// when empty, so the same builder covers the whole ingest matrix.
func reportFields(root, device keypair, subject, reason, createdAt, recordID, comment, plaintext string) map[string]any {
	f := map[string]any{
		"v": 1, "type": "report", "author": root.pub, "device": device.pub,
		"created_at": createdAt, "subject": subject, "reason": reason,
	}
	if recordID != "" {
		f["record"] = recordID
	}
	if comment != "" {
		f["comment"] = comment
	}
	if plaintext != "" {
		f["plaintext"] = plaintext
	}
	return f
}

// tryReport submits a report without asserting the outcome, returning the
// status and (for failures) the error code.
func (c *testClient) tryReport(root, device keypair, fields map[string]any) (int, string) {
	c.t.Helper()
	return c.submit(fields, device)
}

// report submits a report, asserting 201, and returns its record id.
func (c *testClient) report(root, device keypair, subject, reason, createdAt string) string {
	c.t.Helper()
	fields := reportFields(root, device, subject, reason, createdAt, "", "", "")
	body, id := signRecord(c.t, fields, device.priv)
	status, resp := c.do("POST", "/records", "", body)
	if status != http.StatusCreated {
		c.t.Fatalf("report: status = %d, body %v", status, resp)
	}
	return id
}

// dmWithID submits a dm and returns its record id (the content address the
// reporter names in `record`).
func (c *testClient) dmWithID(root, device keypair, to, createdAt string) string {
	c.t.Helper()
	body, id := signRecord(c.t, dmFields(root, device, to, createdAt), device.priv)
	status, resp := c.do("POST", "/records", "", body)
	if status != http.StatusCreated {
		c.t.Fatalf("dm: status = %d, body %v", status, resp)
	}
	return id
}

// scopedPostWithID submits a scoped post and returns its record id.
func (c *testClient) scopedPostWithID(root, device keypair, epochID, ciphertext, createdAt string) string {
	c.t.Helper()
	body, id := signRecord(c.t, scopedPostFields(root, device, epochID, ciphertext, createdAt), device.priv)
	status, resp := c.do("POST", "/records", "", body)
	if status != http.StatusCreated {
		c.t.Fatalf("scoped-post: status = %d, body %v", status, resp)
	}
	return id
}

// --- ingest matrix (§9.1, §9.2) ---

// TestReportIngestValidityMatrix walks the whole §9.1/§9.2 ingest matrix:
// the accepted shapes, every documented rejection code, and the structural
// recipiency proof for encrypted content.
func TestReportIngestValidityMatrix(t *testing.T) {
	c := newClient(t)
	rootR, devR := c.signup("2026-08-20T12:00:00Z") // reporter
	rootS, devS := c.signup("2026-08-20T12:00:00Z") // subject
	rootT, _ := c.signup("2026-08-20T12:00:00Z")    // third party

	// Valid public report, no `record`.
	c.report(rootR, devR, rootS.pub, "spam", "2026-08-24T12:00:00Z")

	// Valid report naming one of the subject's public posts.
	_, postID := c.postWithID(rootS, devS, "reported content", "2026-08-24T11:00:00Z")
	if status, code := c.tryReport(rootR, devR,
		reportFields(rootR, devR, rootS.pub, "harassment", "2026-08-24T12:01:00Z", postID, "same link again", "")); status != http.StatusCreated {
		t.Fatalf("report with record: status = %d code = %s, want 201", status, code)
	}

	// Unknown subject account -> 400 unknown_account.
	ghost := genKey(t)
	if status, code := c.tryReport(rootR, devR,
		reportFields(rootR, devR, ghost.pub, "spam", "2026-08-24T12:02:00Z", "", "", "")); status != http.StatusBadRequest || code != "unknown_account" {
		t.Fatalf("unknown subject: status = %d code = %s, want 400 unknown_account", status, code)
	}

	// Self-report -> 400 invalid_record.
	if status, code := c.tryReport(rootR, devR,
		reportFields(rootR, devR, rootR.pub, "spam", "2026-08-24T12:03:00Z", "", "", "")); status != http.StatusBadRequest || code != "invalid_record" {
		t.Fatalf("self-report: status = %d code = %s, want 400 invalid_record", status, code)
	}

	// Unknown reason -> 400 invalid_record.
	if status, code := c.tryReport(rootR, devR,
		reportFields(rootR, devR, rootS.pub, "vibes", "2026-08-24T12:04:00Z", "", "", "")); status != http.StatusBadRequest || code != "invalid_record" {
		t.Fatalf("unknown reason: status = %d code = %s, want 400 invalid_record", status, code)
	}

	// Over-long comment -> 400 invalid_record.
	long := make([]byte, 1001)
	for i := range long {
		long[i] = 'x'
	}
	if status, code := c.tryReport(rootR, devR,
		reportFields(rootR, devR, rootS.pub, "other", "2026-08-24T12:05:00Z", "", string(long), "")); status != http.StatusBadRequest || code != "invalid_record" {
		t.Fatalf("over-long comment: status = %d code = %s, want 400 invalid_record", status, code)
	}

	// A well-formed record id this instance has never seen -> 400
	// unknown_record: standing is per-instance enforcement.
	unknownRecord := genKey(t).pub // 43-char b64url, the record-id shape
	if status, code := c.tryReport(rootR, devR,
		reportFields(rootR, devR, rootS.pub, "spam", "2026-08-24T12:06:00Z", unknownRecord, "", "")); status != http.StatusBadRequest || code != "unknown_record" {
		t.Fatalf("unknown record: status = %d code = %s, want 400 unknown_record", status, code)
	}

	// The referenced record exists but its author is not the subject.
	if status, code := c.tryReport(rootR, devR,
		reportFields(rootR, devR, rootT.pub, "spam", "2026-08-24T12:07:00Z", postID, "", "")); status != http.StatusBadRequest || code != "invalid_record" {
		t.Fatalf("record author != subject: status = %d code = %s, want 400 invalid_record", status, code)
	}

	// plaintext on a public post -> 400 invalid_record: forwarding is only
	// meaningful for encrypted content (§9.2).
	if status, code := c.tryReport(rootR, devR,
		reportFields(rootR, devR, rootS.pub, "illegal", "2026-08-24T12:08:00Z", postID, "", "forwarded")); status != http.StatusBadRequest || code != "invalid_record" {
		t.Fatalf("plaintext on a public post: status = %d code = %s, want 400 invalid_record", status, code)
	}

	// plaintext with no `record` at all -> 400 invalid_record.
	if status, code := c.tryReport(rootR, devR,
		reportFields(rootR, devR, rootS.pub, "illegal", "2026-08-24T12:09:00Z", "", "", "forwarded")); status != http.StatusBadRequest || code != "invalid_record" {
		t.Fatalf("plaintext without record: status = %d code = %s, want 400 invalid_record", status, code)
	}
}

// TestReportEncryptedRecipiency covers §9.2: the recipiency proof is
// structural — the reported record already names its recipients, so the
// server verifies from what it stores and no key material ever travels.
func TestReportEncryptedRecipiency(t *testing.T) {
	c := newClient(t)
	rootS, devS := c.signup("2026-08-20T12:00:00Z") // subject: dm sender / epoch author
	rootB, devB := c.signup("2026-08-20T12:00:00Z") // recipient / epoch member
	rootC, devC := c.signup("2026-08-20T12:00:00Z") // third party

	// --- dm: the envelope's `to` must equal the reporter ---
	dmID := c.dmWithID(rootS, devS, rootB.pub, "2026-08-24T10:00:00Z")

	// The actual recipient may report it, forwarded plaintext included.
	if status, code := c.tryReport(rootB, devB,
		reportFields(rootB, devB, rootS.pub, "harassment", "2026-08-24T12:00:00Z", dmID, "", "the forwarded message body")); status != http.StatusCreated {
		t.Fatalf("dm report by recipient: status = %d code = %s, want 201", status, code)
	}
	// A third party may not — with or without plaintext.
	if status, code := c.tryReport(rootC, devC,
		reportFields(rootC, devC, rootS.pub, "harassment", "2026-08-24T12:01:00Z", dmID, "", "invented")); status != http.StatusForbidden || code != "not_recipient" {
		t.Fatalf("dm report by third party: status = %d code = %s, want 403 not_recipient", status, code)
	}
	if status, code := c.tryReport(rootC, devC,
		reportFields(rootC, devC, rootS.pub, "harassment", "2026-08-24T12:02:00Z", dmID, "", "")); status != http.StatusForbidden || code != "not_recipient" {
		t.Fatalf("dm report by third party (no plaintext): status = %d code = %s, want 403 not_recipient", status, code)
	}

	// --- scoped-post: an accepted epoch-key naming the reporter ---
	epochID := c.epoch(rootS, devS, "web", "2026-08-24T10:10:00Z")
	c.epochKey(rootS, devS, epochID, rootB.pub, "2026-08-24T10:11:00Z")
	spID := c.scopedPostWithID(rootS, devS, epochID, vectorCiphertext, "2026-08-24T10:12:00Z")

	if status, code := c.tryReport(rootB, devB,
		reportFields(rootB, devB, rootS.pub, "illegal", "2026-08-24T12:03:00Z", spID, "", vectorPlaintext)); status != http.StatusCreated {
		t.Fatalf("scoped-post report by member: status = %d code = %s, want 201", status, code)
	}
	if status, code := c.tryReport(rootC, devC,
		reportFields(rootC, devC, rootS.pub, "illegal", "2026-08-24T12:04:00Z", spID, "", "invented")); status != http.StatusForbidden || code != "not_recipient" {
		t.Fatalf("scoped-post report by non-member: status = %d code = %s, want 403 not_recipient", status, code)
	}
}

// TestReportNotMetered covers §9.1: reports are the defense mechanism, so
// they are never metered — a zero-trust stranger's report costs no token,
// even one naming an account they have never interacted with.
func TestReportNotMetered(t *testing.T) {
	c := newClient(t)
	rootR, devR := c.signup("2026-08-20T12:00:00Z")
	rootS, _ := c.signup("2026-08-20T12:00:00Z")
	tokenR := c.authenticate(rootR, devR)

	before := c.budget(tokenR)
	for i := 0; i < 6; i++ { // more reports than the base budget of 5 tokens
		c.report(rootR, devR, rootS.pub, "spam", "2026-08-24T12:00:0"+string(rune('0'+i))+"Z")
	}
	after := c.budget(tokenR)
	if after.Tokens != before.Tokens {
		t.Errorf("tokens changed after unmetered reports: before = %v, after = %v", before.Tokens, after.Tokens)
	}
}

// TestReportInvisibleToUsers covers §9.1's "server visibility: private" —
// a report never appears in any listing, feed, or count served to users,
// and GET /records/{id} 404s on it exactly as on an unknown id, so its
// existence is never revealed (not even to its own author).
func TestReportInvisibleToUsers(t *testing.T) {
	c := newClient(t)
	rootR, devR := c.signup("2026-08-20T12:00:00Z")
	rootS, devS := c.signup("2026-08-20T12:00:00Z")
	tokenR := c.authenticate(rootR, devR)
	c.post(rootS, devS, "hello", "2026-08-24T11:00:00Z")
	c.graphRecord("follow", rootR, devR, rootS.pub, "2026-08-24T11:30:00Z")

	reportID := c.report(rootR, devR, rootS.pub, "spam", "2026-08-24T12:00:00Z")

	// Not in the author's own public listing, by type or by default.
	if recs := c.records(tokenR, rootR.pub, "?type=report"); len(recs) != 0 {
		t.Errorf("type=report listing returned %d records, want 0", len(recs))
	}
	for _, rec := range c.records(tokenR, rootR.pub, "") {
		var r struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(rec, &r); err != nil {
			t.Fatal(err)
		}
		if r.Type == "report" {
			t.Errorf("default record listing leaked a report: %s", rec)
		}
	}
	// Not fetchable by id, authenticated or not — the same 404 as any
	// unknown id.
	for _, token := range []string{"", tokenR} {
		status, body := c.do("GET", "/records/"+reportID, token, nil)
		if status != http.StatusNotFound || c.errorCode(body) != "not_found" {
			t.Errorf("GET /records/{report}: status = %d code = %s, want 404 not_found", status, c.errorCode(body))
		}
	}
	// Not in the feed: the reporter follows the subject, so the subject's
	// post is there, but nothing of type report ever is.
	for _, rec := range c.feedRecords(tokenR) {
		var r struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(rec, &r); err != nil {
			t.Fatal(err)
		}
		if r.Type == "report" {
			t.Errorf("feed leaked a report: %s", rec)
		}
	}
}
