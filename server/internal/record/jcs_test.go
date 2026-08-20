package record

import "testing"

// Edge cases beyond the shared vectors, pinned here so a refactor cannot
// silently regress them.
func TestCanonicalizeEdgeCases(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		// UTF-16 order: U+1F600 (surrogate pair, first unit 0xD83D) sorts
		// before U+FF21 (single unit 0xFF21) — a byte sort would disagree.
		{"supplementary plane key order", `{"Ａ":1,"😀":2}`, "{\"\U0001F600\":2,\"Ａ\":1}"},
		{"html chars not escaped", `{"s":"<a>&"}`, `{"s":"<a>&"}`},
		{"control chars lowercase hex", `{"s":"\u001F"}`, "{\"s\":\"\\u001f\"}"},
		{"negative zero", `{"n":-0}`, `{"n":0}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v, err := ParseValue([]byte(c.input))
			if err != nil {
				t.Fatal(err)
			}
			got, err := Canonicalize(v)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != c.want {
				t.Errorf("canonical = %q, want %q", got, c.want)
			}
		})
	}
}

func TestCanonicalizeRejectsNonIntegers(t *testing.T) {
	for _, input := range []string{
		`{"n":0.5}`,
		`{"n":1e3}`,
		`{"n":1E-2}`,
		`{"n":9007199254740992}`,  // > MAX_SAFE_INTEGER
		`{"n":-9007199254740992}`, // < -MAX_SAFE_INTEGER
	} {
		v, err := ParseValue([]byte(input))
		if err != nil {
			t.Fatalf("parse %s: %v", input, err)
		}
		if _, err := Canonicalize(v); err == nil {
			t.Errorf("Canonicalize(%s) succeeded, want error", input)
		}
	}
}
