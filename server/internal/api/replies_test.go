package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
)

// postReply signs and submits a post record carrying `reply_to`, asserting
// 201, and returns its canonical bytes and content-addressed id.
func (c *testClient) postReply(root, device keypair, text, replyTo, createdAt string) ([]byte, string) {
	c.t.Helper()
	body, id := signRecord(c.t, map[string]any{
		"v": 1, "type": "post", "author": root.pub, "device": device.pub,
		"created_at": createdAt, "body": text, "reply_to": replyTo,
	}, device.priv)
	status, resp := c.do("POST", "/records", "", body)
	if status != http.StatusCreated {
		c.t.Fatalf("post reply: status = %d, body %v", status, resp)
	}
	return body, id
}

// postWithID signs and submits a post record, asserting 201, and returns
// its canonical bytes and content-addressed id (unlike the `post` helper in
// graph_test.go, which discards the id).
func (c *testClient) postWithID(root, device keypair, text, createdAt string) ([]byte, string) {
	c.t.Helper()
	body, id := signRecord(c.t, map[string]any{
		"v": 1, "type": "post", "author": root.pub, "device": device.pub,
		"created_at": createdAt, "body": text,
	}, device.priv)
	status, resp := c.do("POST", "/records", "", body)
	if status != http.StatusCreated {
		c.t.Fatalf("post: status = %d, body %v", status, resp)
	}
	return body, id
}

type recordGetResponse struct {
	Record json.RawMessage `json:"record"`
	Author struct {
		DeviceCerts       []json.RawMessage `json:"device_certs"`
		DeviceRevocations []json.RawMessage `json:"device_revocations"`
		Profile           json.RawMessage   `json:"profile"`
	} `json:"author"`
	ReplyCount     int     `json:"reply_count"`
	CandidateTrust float64 `json:"candidate_trust"`
}

func TestRecordGet(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z") // parent author
	rootF, devF := c.signup("2026-08-20T12:00:00Z") // reply author, followed by viewer
	rootS, devS := c.signup("2026-08-20T12:00:00Z") // reply author, stranger
	rootV, devV := c.signup("2026-08-20T12:00:00Z") // viewer
	tokenV := c.authenticate(rootV, devV)

	profile, _ := signRecord(t, map[string]any{
		"v": 1, "type": "profile", "author": rootA.pub, "device": devA.pub,
		"created_at": "2026-08-20T12:30:00Z", "display_name": "A",
	}, devA.priv)
	if status, _ := c.do("POST", "/records", "", profile); status != http.StatusCreated {
		t.Fatal("profile submit failed")
	}

	_, parentID := c.postWithID(rootA, devA, "parent post", "2026-08-20T13:00:00Z")
	c.postReply(rootF, devF, "reply 1", parentID, "2026-08-20T13:01:00Z")
	c.postReply(rootS, devS, "reply 2", parentID, "2026-08-20T13:02:00Z")

	// Viewer follows the parent's author.
	c.graphRecord("follow", rootV, devV, rootA.pub, "2026-08-20T12:45:00Z")

	// Anonymous fetch: reply_count and profile are visible, trust is 0.
	status, body := c.do("GET", "/records/"+parentID, "", nil)
	if status != http.StatusOK {
		t.Fatalf("get record: status = %d, body %v", status, body)
	}
	var resp recordGetResponse
	mustDecode(t, body, &resp)
	if resp.ReplyCount != 2 {
		t.Errorf("reply_count = %d, want 2", resp.ReplyCount)
	}
	if !bytes.Equal(bytes.TrimSpace(resp.Author.Profile), profile) {
		t.Errorf("author.profile = %s, want the exact posted profile %s", resp.Author.Profile, profile)
	}
	if resp.CandidateTrust != 0 {
		t.Errorf("anonymous candidate_trust = %v, want 0", resp.CandidateTrust)
	}

	// Authenticated as a follower of the parent's author: positive trust.
	status, body = c.do("GET", "/records/"+parentID, tokenV, nil)
	if status != http.StatusOK {
		t.Fatalf("get record (auth): status = %d", status)
	}
	mustDecode(t, body, &resp)
	if resp.CandidateTrust <= 0 {
		t.Errorf("authenticated candidate_trust = %v, want > 0", resp.CandidateTrust)
	}
}

func mustDecode(t *testing.T, body map[string]json.RawMessage, v any) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("decode: %v (body %s)", err, raw)
	}
}

func TestRecordReplies(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootF, devF := c.signup("2026-08-20T12:00:00Z")
	rootS, devS := c.signup("2026-08-20T12:00:00Z")

	_, parentID := c.postWithID(rootA, devA, "parent", "2026-08-20T13:00:00Z")
	c.postReply(rootF, devF, "first", parentID, "2026-08-20T13:01:00Z")
	c.postReply(rootS, devS, "second", parentID, "2026-08-20T13:02:00Z")

	type item struct {
		Record         json.RawMessage `json:"record"`
		Author         string          `json:"author"`
		CandidateTrust float64         `json:"candidate_trust"`
		ReplyCount     int             `json:"reply_count"`
	}
	type repliesResp struct {
		Items     []item                     `json:"items"`
		Authors   map[string]json.RawMessage `json:"authors"`
		NextAfter *string                    `json:"next_after"`
	}

	status, body := c.do("GET", "/records/"+parentID+"/replies", "", nil)
	if status != http.StatusOK {
		t.Fatalf("replies: status = %d, body %v", status, body)
	}
	var resp repliesResp
	mustDecode(t, body, &resp)
	if len(resp.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(resp.Items))
	}
	if resp.Items[0].Author != rootF.pub || resp.Items[1].Author != rootS.pub {
		t.Errorf("order = [%s, %s], want [%s, %s] (created_at asc)",
			resp.Items[0].Author, resp.Items[1].Author, rootF.pub, rootS.pub)
	}
	if len(resp.Authors) != 2 {
		t.Errorf("authors has %d entries, want 2", len(resp.Authors))
	}
	if _, ok := resp.Authors[rootF.pub]; !ok {
		t.Errorf("authors missing %s", rootF.pub)
	}
	if _, ok := resp.Authors[rootS.pub]; !ok {
		t.Errorf("authors missing %s", rootS.pub)
	}
	if resp.NextAfter != nil {
		t.Errorf("next_after = %v, want nil", *resp.NextAfter)
	}

	// Pagination: limit=1 forces a second page.
	status, body = c.do("GET", "/records/"+parentID+"/replies?limit=1", "", nil)
	if status != http.StatusOK {
		t.Fatalf("page 1: status = %d", status)
	}
	mustDecode(t, body, &resp)
	if len(resp.Items) != 1 || resp.Items[0].Author != rootF.pub {
		t.Fatalf("page 1 = %+v, want [%s]", resp.Items, rootF.pub)
	}
	if resp.NextAfter == nil {
		t.Fatal("page 1 next_after = nil, want set")
	}
	status, body = c.do("GET", "/records/"+parentID+"/replies?limit=1&after="+*resp.NextAfter, "", nil)
	if status != http.StatusOK {
		t.Fatalf("page 2: status = %d", status)
	}
	mustDecode(t, body, &resp)
	if len(resp.Items) != 1 || resp.Items[0].Author != rootS.pub {
		t.Fatalf("page 2 = %+v, want [%s]", resp.Items, rootS.pub)
	}
	// Page 2 exactly fills limit=1, so next_after is set even though no
	// replies remain (the same "full page" cursor heuristic as next_before
	// elsewhere: a genuinely final page that exactly fills the limit costs
	// one harmless extra round trip). A third fetch confirms it is empty.
	if resp.NextAfter == nil {
		t.Fatal("page 2 next_after = nil, want set (page exactly filled the limit)")
	}
	status, body = c.do("GET", "/records/"+parentID+"/replies?limit=1&after="+*resp.NextAfter, "", nil)
	if status != http.StatusOK {
		t.Fatalf("page 3: status = %d", status)
	}
	mustDecode(t, body, &resp)
	if len(resp.Items) != 0 {
		t.Fatalf("page 3 = %+v, want empty", resp.Items)
	}
	if resp.NextAfter != nil {
		t.Errorf("page 3 next_after = %v, want nil", *resp.NextAfter)
	}
}

func TestReplyToValidation(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")

	// Malformed reply_to.
	rec, _ := signRecord(t, map[string]any{
		"v": 1, "type": "post", "author": rootA.pub, "device": devA.pub,
		"created_at": "2026-08-20T13:00:00Z", "body": "bad", "reply_to": "not-a-valid-id!!",
	}, devA.priv)
	status, body := c.do("POST", "/records", "", rec)
	if status != http.StatusBadRequest || c.errorCode(body) != "invalid_record" {
		t.Fatalf("malformed reply_to: status = %d code = %s, want 400 invalid_record", status, c.errorCode(body))
	}

	// reply_to pointing at a non-post (profile) record.
	profile, profileID := signRecord(t, map[string]any{
		"v": 1, "type": "profile", "author": rootA.pub, "device": devA.pub,
		"created_at": "2026-08-20T13:00:01Z", "display_name": "A",
	}, devA.priv)
	if status, _ := c.do("POST", "/records", "", profile); status != http.StatusCreated {
		t.Fatal("profile submit failed")
	}
	rec, _ = signRecord(t, map[string]any{
		"v": 1, "type": "post", "author": rootA.pub, "device": devA.pub,
		"created_at": "2026-08-20T13:00:02Z", "body": "reply to profile", "reply_to": profileID,
	}, devA.priv)
	status, body = c.do("POST", "/records", "", rec)
	if status != http.StatusBadRequest || c.errorCode(body) != "invalid_record" {
		t.Fatalf("reply_to non-post: status = %d code = %s, want 400 invalid_record", status, c.errorCode(body))
	}

	// reply_to pointing at an unknown (well-formed) id: accepted — the
	// parent may live off-instance.
	unknown := genKey(t) // any well-formed 32-byte b64url id, unused as a record
	rec, _ = signRecord(t, map[string]any{
		"v": 1, "type": "post", "author": rootA.pub, "device": devA.pub,
		"created_at": "2026-08-20T13:00:03Z", "body": "reply to nowhere", "reply_to": unknown.pub,
	}, devA.priv)
	status, body = c.do("POST", "/records", "", rec)
	if status != http.StatusCreated {
		t.Fatalf("reply_to unknown id: status = %d code = %s, want 201", status, c.errorCode(body))
	}
}

func TestRecordGetVisibility(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z")
	rootB, _ := c.signup("2026-08-20T12:00:00Z")

	// A dm record id: never served, 404 identical to unknown.
	dmBody, dmID := signRecord(t, dmFields(rootA, devA, rootB.pub, "2026-08-20T13:00:00Z"), devA.priv)
	if status, _ := c.do("POST", "/records", "", dmBody); status != http.StatusCreated {
		t.Fatal("dm submit failed")
	}
	status, body := c.do("GET", "/records/"+dmID, "", nil)
	if status != http.StatusNotFound || c.errorCode(body) != "not_found" {
		t.Fatalf("dm record: status = %d code = %s, want 404 not_found", status, c.errorCode(body))
	}
	dmNotFoundBody := body

	// A mute record id: also never served.
	muteBody, muteID := signRecord(t, map[string]any{
		"v": 1, "type": "mute", "author": rootA.pub, "device": devA.pub,
		"created_at": "2026-08-20T13:00:01Z", "subject": rootB.pub,
	}, devA.priv)
	if status, _ := c.do("POST", "/records", "", muteBody); status != http.StatusCreated {
		t.Fatal("mute submit failed")
	}
	status, body = c.do("GET", "/records/"+muteID, "", nil)
	if status != http.StatusNotFound || c.errorCode(body) != "not_found" {
		t.Fatalf("mute record: status = %d code = %s, want 404 not_found", status, c.errorCode(body))
	}
	muteNotFoundBody := body

	// An unknown id: identical response body to the two above, so record
	// existence is never revealed by shape.
	ghost := genKey(t)
	status, body = c.do("GET", "/records/"+ghost.pub, "", nil)
	if status != http.StatusNotFound || c.errorCode(body) != "not_found" {
		t.Fatalf("unknown record: status = %d code = %s, want 404 not_found", status, c.errorCode(body))
	}
	if string(dmNotFoundBody["error"]) != string(body["error"]) || string(muteNotFoundBody["error"]) != string(body["error"]) {
		t.Errorf("404 bodies differ: dm=%s mute=%s unknown=%s", dmNotFoundBody["error"], muteNotFoundBody["error"], body["error"])
	}
}

func TestFeedProfileAndReplyCount(t *testing.T) {
	c := newClient(t)
	rootA, devA := c.signup("2026-08-20T12:00:00Z") // parent author, has a profile
	rootB, devB := c.signup("2026-08-20T12:00:00Z") // reply author, no profile
	rootC, devC := c.signup("2026-08-20T12:00:00Z") // viewer
	tokenC := c.authenticate(rootC, devC)
	c.graphRecord("follow", rootC, devC, rootA.pub, "2026-08-20T12:30:00Z")
	c.graphRecord("follow", rootC, devC, rootB.pub, "2026-08-20T12:30:01Z")

	profile, _ := signRecord(t, map[string]any{
		"v": 1, "type": "profile", "author": rootA.pub, "device": devA.pub,
		"created_at": "2026-08-20T12:45:00Z", "display_name": "A",
	}, devA.priv)
	if status, _ := c.do("POST", "/records", "", profile); status != http.StatusCreated {
		t.Fatal("profile submit failed")
	}

	_, parentID := c.postWithID(rootA, devA, "parent", "2026-08-20T13:00:00Z")
	c.postReply(rootB, devB, "a reply", parentID, "2026-08-20T13:01:00Z")

	status, body := c.do("GET", "/feed", tokenC, nil)
	if status != http.StatusOK {
		t.Fatalf("feed: status = %d", status)
	}
	var items []struct {
		Author     string `json:"author"`
		ReplyCount int    `json:"reply_count"`
	}
	if err := json.Unmarshal(body["items"], &items); err != nil {
		t.Fatalf("items = %s", body["items"])
	}
	var found bool
	for _, it := range items {
		if it.Author == rootA.pub {
			found = true
			if it.ReplyCount != 1 {
				t.Errorf("parent post reply_count = %d, want 1", it.ReplyCount)
			}
		}
	}
	if !found {
		t.Fatalf("feed missing A's post: %+v", items)
	}

	var authors map[string]struct {
		Profile json.RawMessage `json:"profile"`
	}
	if err := json.Unmarshal(body["authors"], &authors); err != nil {
		t.Fatalf("authors = %s", body["authors"])
	}
	a, ok := authors[rootA.pub]
	if !ok {
		t.Fatalf("authors missing %s", rootA.pub)
	}
	if !bytes.Equal(bytes.TrimSpace(a.Profile), profile) {
		t.Errorf("authors[A].profile = %s, want the exact posted profile %s", a.Profile, profile)
	}
	// B posted no profile: null.
	b, ok := authors[rootB.pub]
	if !ok {
		t.Fatalf("authors missing %s", rootB.pub)
	}
	if string(b.Profile) != "null" {
		t.Errorf("authors[B].profile = %s, want null", b.Profile)
	}
}
