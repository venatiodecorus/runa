// Package record implements the signed-record wire format of
// docs/protocol.md §3: JCS (RFC 8785) canonicalization, Ed25519 signature
// verification, device-cert chain verification, and content-addressed IDs.
// It is the Go half of the deliberately-duplicated implementation kept in
// lockstep with packages/core via docs/protocol/vectors/.
package record

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// maxSafeInteger mirrors JavaScript's Number.MAX_SAFE_INTEGER; the TS
// reference implementation rejects anything beyond it, so we must too.
const maxSafeInteger = 9007199254740991

// Canonicalize renders a parsed JSON value as RFC 8785 canonical JSON.
// The value must come from a json.Decoder with UseNumber() (or be built
// from strings, bools, nil, json.Number, int/int64, map[string]any,
// []any). Per ADR-0005 only integer numbers are permitted; any
// non-integer json.Number is an error, which is what makes float
// canonicalization differences across languages impossible by construction.
func Canonicalize(v any) ([]byte, error) {
	var b strings.Builder
	if err := writeCanonical(&b, v); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}

func writeCanonical(b *strings.Builder, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		writeJCSString(b, x)
	case json.Number:
		s, err := canonicalNumber(string(x))
		if err != nil {
			return err
		}
		b.WriteString(s)
	case int:
		b.WriteString(strconv.Itoa(x))
	case int64:
		b.WriteString(strconv.FormatInt(x, 10))
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeCanonical(b, e); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJCSString(b, k)
			b.WriteByte(':')
			if err := writeCanonical(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("jcs: cannot canonicalize value of type %T", v)
	}
	return nil
}

// canonicalNumber validates a JSON number literal under the ADR-0005
// no-floats convention and returns its canonical form. Integer literals
// within the safe range are already canonical (JSON forbids leading
// zeros), except "-0" which ECMAScript renders as "0".
func canonicalNumber(s string) (string, error) {
	if strings.ContainsAny(s, ".eE") {
		return "", fmt.Errorf("record contains non-integer number: %s", s)
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return "", fmt.Errorf("invalid integer: %s", s)
	}
	if n < -maxSafeInteger || n > maxSafeInteger {
		return "", fmt.Errorf("integer outside safe range: %s", s)
	}
	if n == 0 {
		return "0", nil
	}
	return s, nil
}

// writeJCSString escapes per RFC 8785 §3.2.2.2: two-char shortcuts for
// \" \\ \b \t \n \f \r, \u00xx (lowercase hex) for remaining control
// chars, everything else as literal UTF-8. Notably JCS does NOT escape
// < > & like Go's json.Marshal does.
func writeJCSString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\f':
			b.WriteString(`\f`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

// lessUTF16 orders keys by UTF-16 code units as JCS requires. A plain
// byte/rune comparison differs for supplementary-plane characters, whose
// surrogate pairs sort below some BMP code points in UTF-16 order.
func lessUTF16(a, b string) bool {
	ua := utf16.Encode([]rune(a))
	ub := utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

// ParseValue decodes arbitrary JSON preserving number literals as
// json.Number, the form Canonicalize expects.
func ParseValue(data []byte) (any, error) {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	var trailing any
	if err := dec.Decode(&trailing); err == nil {
		return nil, errors.New("trailing data after JSON value")
	}
	return v, nil
}
