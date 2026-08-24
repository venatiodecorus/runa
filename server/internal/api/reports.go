package api

import (
	"encoding/json"
	"net/http"

	"github.com/VenatioDecorus/runa/server/internal/record"
	"github.com/VenatioDecorus/runa/server/internal/store"
	"github.com/VenatioDecorus/runa/server/internal/trust"
)

// Report ingest (Phase 7 / M7, docs/protocol.md §9.1–§9.2). Reports are the
// defense mechanism, so they are never metered; their abuse is priced in
// standing, not tokens (an adjudicated-false report burns the reporter,
// §9.4). They are also server-**private**: `report` is absent from
// publicListTypes, so it never appears in /accounts/{id}/records, the feed,
// a reply listing, or GET /records/{id} (which 404s on it exactly as on any
// unknown id — existence is never revealed). The only read surface is the
// operator review queue (admin.go).

// encryptedReportTypes are the record types whose reports require the §9.2
// structural recipiency proof: the reported record already names its
// recipients, so the server verifies recipiency from what it stores and no
// key material ever travels.
var encryptedReportTypes = map[string]bool{
	"dm":          true,
	"scoped-post": true,
}

// validateReportIngest runs the §9.1/§9.2 ingest rules after the usual
// signature + cert-chain verification. Returns false after writing the
// error response.
func (s *server) validateReportIngest(w http.ResponseWriter, rec *record.Record) bool {
	subject, _ := rec.String("subject")
	if _, err := record.DecodeKey(subject); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_record", "subject: "+err.Error())
		return false
	}
	exists, err := s.st.AccountExists(subject)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return false
	}
	if !exists {
		writeError(w, http.StatusBadRequest, "unknown_account", "subject has no account on this instance")
		return false
	}
	if err := record.ValidateReport(rec); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_record", err.Error())
		return false
	}

	reportedID, _ := rec.String("record")
	var reported *store.RecordRow
	if reportedID != "" {
		reported, err = s.st.GetRecord(reportedID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return false
		}
		// Standing is per-instance enforcement: there is nothing to enforce
		// against a record this instance has never seen (§9.1).
		if reported == nil {
			writeError(w, http.StatusBadRequest, "unknown_record", "record: no such record on this instance")
			return false
		}
		if reported.Account != subject {
			writeError(w, http.StatusBadRequest, "invalid_record", "record: reported record was not authored by subject")
			return false
		}
	}

	// `plaintext` is the reporter's forwarded testimony about encrypted
	// content; on anything else it is meaningless and rejected (§9.1).
	if rec.Has("plaintext") && (reported == nil || !encryptedReportTypes[reported.Type]) {
		writeError(w, http.StatusBadRequest, "invalid_record",
			"plaintext is permitted only with a `record` naming a dm or scoped-post")
		return false
	}
	// Recipiency, structurally (§9.2): reporting an encrypted record at all
	// requires being one of its recipients — with or without forwarded
	// plaintext. No key material is inspected, ever.
	if reported != nil && encryptedReportTypes[reported.Type] {
		return s.checkRecipiency(w, rec.Author(), reported)
	}
	return true
}

// checkRecipiency verifies the §9.2 structural proof against what the
// server already stores: a dm names its recipient in `to`; a scoped-post's
// audience is the set of accounts an accepted epoch-key was addressed to.
func (s *server) checkRecipiency(w http.ResponseWriter, reporter string, reported *store.RecordRow) bool {
	switch reported.Type {
	case "dm":
		var env struct {
			To string `json:"to"`
		}
		if err := json.Unmarshal(reported.Body, &env); err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return false
		}
		if env.To != reporter {
			writeError(w, http.StatusForbidden, "not_recipient", "the reported dm is not addressed to you")
			return false
		}
		return true
	case "scoped-post":
		var sp struct {
			Epoch string `json:"epoch"`
		}
		if err := json.Unmarshal(reported.Body, &sp); err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return false
		}
		member, err := s.st.HasEpochKeyFor(sp.Epoch, reporter)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return false
		}
		if !member {
			writeError(w, http.StatusForbidden, "not_recipient", "you are not a member of the reported post's epoch")
			return false
		}
		return true
	}
	return true
}

// applyReportRecord materializes a verified, stored report and re-evaluates
// the subject's automated rung: when p_auto reaches report_auto_cap,
// automation is exhausted and a review-queue entry opens for a human
// (§9.4). An entry is not re-opened while one is already open, nor on
// reports a human has already ruled on (a resolution newer than the newest
// window report closes the matter until something new arrives).
func (s *server) applyReportRecord(rec *record.Record, recordID string) error {
	subject, _ := rec.String("subject")
	reportedID, _ := rec.String("record")
	reason, _ := rec.String("reason")
	if err := s.st.InsertReport(store.ReportRow{
		RecordID:       recordID,
		Reporter:       rec.Author(),
		Subject:        subject,
		ReportedRecord: reportedID,
		Reason:         reason,
		CreatedAt:      rec.CreatedAt(),
	}); err != nil {
		return err
	}
	c := s.standingCalc()
	pAuto, err := c.autoPenalty(subject)
	if err != nil {
		return err
	}
	if pAuto < trust.ReportAutoCap {
		return nil
	}
	open, err := s.st.OpenReviewFor(subject)
	if err != nil || open != nil {
		return err
	}
	reports, err := s.st.ReportsForSubjectSince(subject, c.windowStart())
	if err != nil {
		return err
	}
	newest := ""
	for _, r := range reports {
		if r.CreatedAt > newest {
			newest = r.CreatedAt
		}
	}
	resolvedAt, err := s.st.LatestReviewResolvedAt(subject)
	if err != nil {
		return err
	}
	if resolvedAt != "" && resolvedAt > newest {
		return nil // already adjudicated; nothing new to review
	}
	return s.st.OpenReview(subject, rfc3339(c.now))
}
