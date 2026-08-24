package record

import (
	"errors"
	"fmt"
)

// ValidatePost checks the post-specific optional field (docs/protocol.md
// §3.1): `reply_to`, when present, must be a well-formed record id. It does
// not verify the signature. Whether that id resolves to a known record on
// this instance — and whether that record is itself a `post` — is a
// store-backed check made by the API layer: a reply to an unknown id is
// accepted (the parent may live off-instance), but a reply to a
// known-non-post id is not.
func ValidatePost(rec *Record) error {
	if rec.Type() != "post" {
		return errors.New("not a post")
	}
	if replyTo, present := rec.m["reply_to"]; present {
		s, ok := replyTo.(string)
		if !ok {
			return errors.New("reply_to must be a string")
		}
		if _, err := DecodeID(s); err != nil {
			return fmt.Errorf("reply_to: %w", err)
		}
	}
	return nil
}
