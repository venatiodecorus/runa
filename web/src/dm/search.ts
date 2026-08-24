/**
 * Fuzzy contact search for the DM composer: subsequence matching over a
 * merged follows+conversations contact list. Framework-free, pure.
 */

export interface Contact {
  id: string;
  displayName: string | null;
  source: "follow" | "conversation" | "both";
}

const WORD_BOUNDARY_CHARS = new Set([" ", "-", "_", "."]);

/**
 * Case-insensitive subsequence match: every character of `query` must occur
 * in `text` in order (gaps allowed). Returns null when it isn't a
 * subsequence at all; otherwise a score that rewards a literal prefix or
 * substring, contiguous runs, and word-boundary starts, and penalizes gaps.
 * Empty query matches everything with score 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  let bonus = 0;
  if (t.startsWith(q)) bonus += 100;
  else if (t.includes(q)) bonus += 40;

  let qIdx = 0;
  let lastMatch = -1;
  let run = 0;
  let score = 0;
  for (let tIdx = 0; tIdx < t.length && qIdx < q.length; tIdx++) {
    if (t[tIdx] !== q[qIdx]) continue;
    let charScore = 1;
    const prev = tIdx > 0 ? t[tIdx - 1] : undefined;
    if (tIdx === 0 || (prev !== undefined && WORD_BOUNDARY_CHARS.has(prev))) {
      charScore += 3; // word-boundary (incl. start-of-text) bonus
    }
    if (lastMatch === tIdx - 1) {
      run += 1;
      charScore += run; // reward growing contiguous runs
    } else {
      run = 0;
      if (lastMatch !== -1) {
        charScore -= Math.min(tIdx - lastMatch - 1, 4); // penalize gaps, capped
      }
    }
    score += charScore;
    lastMatch = tIdx;
    qIdx += 1;
  }

  if (qIdx < q.length) return null; // not a subsequence
  return score + bonus;
}

// Large enough to dominate any plausible fuzzyScore so a name hit always
// outranks an id hit of equal (or noticeably better) raw quality.
const NAME_MATCH_BONUS = 10_000;

/** (hasName ? 0 : 1, key asc) — names sort alphabetically before nameless-by-id. */
function tieBreakKey(c: Contact): [number, string] {
  return c.displayName !== null ? [0, c.displayName] : [1, c.id];
}

function compareTieBreak(a: Contact, b: Contact): number {
  const [aGroup, aKey] = tieBreakKey(a);
  const [bGroup, bKey] = tieBreakKey(b);
  if (aGroup !== bGroup) return aGroup - bGroup;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

/**
 * Score every contact against its displayName and id, keep the best (with a
 * bonus favoring a name match), drop non-matches, and sort score desc then
 * deterministically. Empty query returns everything: named contacts
 * alphabetically, then nameless contacts by id.
 */
export function rankContacts(query: string, contacts: Contact[], limit = 8): Contact[] {
  const scored: Array<{ contact: Contact; score: number }> = [];
  for (const contact of contacts) {
    const nameScore = contact.displayName !== null ? fuzzyScore(query, contact.displayName) : null;
    const idScore = fuzzyScore(query, contact.id);
    const candidates: number[] = [];
    if (nameScore !== null) candidates.push(nameScore + NAME_MATCH_BONUS);
    if (idScore !== null) candidates.push(idScore);
    if (candidates.length === 0) continue;
    scored.push({ contact, score: Math.max(...candidates) });
  }
  scored.sort((a, b) => (a.score !== b.score ? b.score - a.score : compareTieBreak(a.contact, b.contact)));
  return scored.slice(0, limit).map((s) => s.contact);
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** 43 chars of the base64url alphabet — the shape of an account id (root pubkey). */
export function looksLikeAccountId(s: string): boolean {
  return ACCOUNT_ID_RE.test(s);
}

/** Union of follow ids and conversation-partner ids, deterministically ordered. */
export function mergeContacts(
  follows: string[],
  conversations: string[],
  names: Record<string, string | null>,
): Contact[] {
  const followSet = new Set(follows);
  const conversationSet = new Set(conversations);
  const ids = new Set<string>([...follows, ...conversations]);
  const contacts: Contact[] = [];
  for (const id of ids) {
    const inFollow = followSet.has(id);
    const inConversation = conversationSet.has(id);
    const source: Contact["source"] = inFollow && inConversation ? "both" : inFollow ? "follow" : "conversation";
    contacts.push({ id, displayName: names[id] ?? null, source });
  }
  contacts.sort(compareTieBreak);
  return contacts;
}
