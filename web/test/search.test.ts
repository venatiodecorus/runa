/**
 * Fuzzy contact search (src/dm/search.ts) for the DM composer: subsequence
 * matching, ranking, and follows/conversations merge.
 */
import { describe, expect, it } from "vitest";
import {
  fuzzyScore,
  looksLikeAccountId,
  mergeContacts,
  rankContacts,
  type Contact,
} from "../src/dm/search.js";

describe("fuzzyScore", () => {
  it("matches a case-insensitive subsequence", () => {
    expect(fuzzyScore("alc", "alice")).not.toBeNull();
    expect(fuzzyScore("ALC", "alice")).not.toBeNull();
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xz", "alice")).toBeNull();
  });

  it("returns 0 for an empty query against anything", () => {
    expect(fuzzyScore("", "alice")).toBe(0);
    expect(fuzzyScore("", "")).toBe(0);
  });

  it("never throws for an empty text", () => {
    expect(fuzzyScore("a", "")).toBeNull();
  });

  it("scores a prefix match higher than an infix match", () => {
    const prefix = fuzzyScore("al", "alice")!;
    const infix = fuzzyScore("al", "value")!;
    expect(prefix).toBeGreaterThan(infix);
  });

  it("scores a contiguous run higher than the same letters scattered with gaps", () => {
    const contiguous = fuzzyScore("ali", "alice")!;
    const scattered = fuzzyScore("ali", "a-l-i-ce")!;
    expect(contiguous).toBeGreaterThan(scattered);
  });
});

describe("looksLikeAccountId", () => {
  const valid43 = "A".repeat(43);

  it("accepts exactly 43 base64url characters", () => {
    expect(looksLikeAccountId(valid43)).toBe(true);
    expect(looksLikeAccountId("a".repeat(21) + "_-" + "b".repeat(20))).toBe(true);
  });

  it("rejects the wrong length", () => {
    expect(looksLikeAccountId("a".repeat(42))).toBe(false);
    expect(looksLikeAccountId("a".repeat(44))).toBe(false);
  });

  it("rejects non-base64url characters", () => {
    expect(looksLikeAccountId("+".repeat(43))).toBe(false);
    expect(looksLikeAccountId("/".repeat(43))).toBe(false);
  });
});

describe("mergeContacts", () => {
  it("marks source as follow, conversation, or both", () => {
    const contacts = mergeContacts(["a", "b"], ["b", "c"], {});
    const byId = Object.fromEntries(contacts.map((c) => [c.id, c]));
    expect(byId.a!.source).toBe("follow");
    expect(byId.b!.source).toBe("both");
    expect(byId.c!.source).toBe("conversation");
  });

  it("attaches display names, defaulting to null", () => {
    const contacts = mergeContacts(["a"], [], { a: "Alice" });
    expect(contacts).toEqual([{ id: "a", displayName: "Alice", source: "follow" }]);
  });

  it("is deterministic regardless of input order", () => {
    const x = mergeContacts(["b", "a"], ["c"], { a: "Alice", b: "Bob" });
    const y = mergeContacts(["a", "b"], ["c"], { b: "Bob", a: "Alice" });
    expect(x).toEqual(y);
  });
});

describe("rankContacts", () => {
  const contacts: Contact[] = [
    { id: "id-for-alice-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", displayName: "Alice", source: "follow" },
    { id: "id-for-bob---xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", displayName: "Bob", source: "conversation" },
    { id: "carol-account-id-no-display-name-xxxxxxxxxxxxxxxxxxx", displayName: null, source: "follow" },
  ];

  it("a name hit outranks an id hit of equal quality", () => {
    // "carol" is not a subsequence of Alice/Bob's names, but IS a literal
    // prefix of the nameless contact's id — a strong id-only match — while
    // a weaker, scattered name match should still win via the name bonus.
    const withNameMatch: Contact[] = [
      { id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", displayName: "c-a-r-o-l", source: "follow" },
      { id: "carolxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", displayName: null, source: "follow" },
    ];
    const ranked = rankContacts("carol", withNameMatch);
    expect(ranked[0]!.displayName).toBe("c-a-r-o-l");
  });

  it("drops contacts that match neither name nor id", () => {
    const ranked = rankContacts("zzz-no-match-zzz", contacts);
    expect(ranked).toHaveLength(0);
  });

  it("respects the limit", () => {
    expect(rankContacts("", contacts, 2)).toHaveLength(2);
  });

  it("empty query returns named contacts alphabetically, then nameless by id", () => {
    const ranked = rankContacts("", contacts, 10);
    expect(ranked.map((c) => c.displayName ?? c.id)).toEqual(["Alice", "Bob", contacts[2]!.id]);
  });

  it("ranks a matching contact by name over a matching contact by id only", () => {
    const byName: Contact = { id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", displayName: "alice", source: "follow" };
    const byIdOnly: Contact = { id: "aliceyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", displayName: null, source: "follow" };
    const ranked = rankContacts("alice", [byIdOnly, byName]);
    expect(ranked[0]).toBe(byName);
  });
});
