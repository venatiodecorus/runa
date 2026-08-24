# How reach works on Runa

*Plain-language explainer. The precise math lives in [`trust-and-reach.md`](../trust-and-reach.md); if this page and the spec ever disagree, the spec is right and this page has a bug. This page must be updated in the same change as any algorithm change — being open about how reach works is a core feature of the network, not marketing.*

## The one-sentence version

**Posting is free; being *heard* by strangers is the limited resource — and the only way to get more of it is for real people to choose to trust you.**

## There is no global score

Most networks compute one worldwide answer to "how good is this account?" Runa never does. Whether your post surfaces in someone's feed depends on *that person's* position in the follow graph relative to yours:

- If **they follow you**, your trust weight for them is 1.0 — the maximum a single connection can give.
- If **someone they follow follows you**, you're at two hops: each such path is worth 0.35.
- **Multiple independent paths add up** (several people they trust all following you counts for more than one), but the total is capped at 2× a direct follow — popularity in someone's neighborhood can never drown out their own explicit choices.
- **Beyond two hops, there is no path.** You're a stranger, and reaching strangers is the metered part (below).
- If **they've muted you**, your weight is zero for them, and nothing propagates through you *to them*. Muting is private and affects only the muter's view.

Only two signals ever build trust: **follows and mutes** — deliberate acts. Likes, replies, reshares, and time-spent never create trust. You cannot engagement-farm your way into someone's web.

Every number above is published (see the [constants table](../trust-and-reach.md#6-constants-published-initial-values-tune-in-testing)), and your client recomputes the ranking itself — the server proposes an order, but nothing renders as trusted unless *your own device's* math agrees. Anyone can check the work; that's the point.

## Standing: the one global number, and it only goes down (temporarily)

There is one global value per account, `standing`, between 0 and 1, starting and resting at 1. It is **enforcement, not reputation**: it can only reduce reach, never boost it, and it decays back to 1 (half-life 30 days — no permanent marks). It moves in response to reports, weighted by how *diverse* the reporters are in the graph — five reports from five unconnected regions matter far more than five hundred from one tight cluster, which is what a brigade looks like. Filing false reports burns the reporter's own standing.

How that works in practice (since M7):

- **Reporting** is a signed record like everything else. Reporting a private (encrypted) message forwards *your* decrypted copy along with proof you were genuinely one of its recipients — the server checks the envelope it already stores, and never gains any decryption key from a report. Sharing what was sent *to you* is a recipient's right; the report flow is just its accountable form.
- **Diversity beats volume.** Reporters are grouped by how connected they are to each other; each group counts once, at the strength of its single most-established member. A reporter's strength comes from the same earned inbound trust that grows reach budgets — so a freshly minted swarm of accounts has almost none.
- **Automation has a hard ceiling.** Reports alone can shrink an account's stranger-reach only so far (the cap is published). Anything beyond — a stronger penalty, a cold-outreach freeze — requires a human reviewer looking at the actual reports, and a reviewer who finds the reports false burns the *reporters'* standing instead.
- **You're told, not profiled.** If your reach is limited, your client shows you that, and why in kind (reports, a review decision, a freeze) — never who reported you or the exact trigger numbers.
- **Your existing followers notice nothing.** Standing gates reach to strangers; people who follow you see your posts exactly as before — that's promise 1 below, enforced in your reader's own client, not just on the server.

Two hard promises, versioned like code:

1. **Throttle, don't silence.** Penalties shrink your reach *to strangers*. They never disconnect you from people who already chose to follow you, and never delete your content.
2. **Reach is earned, never bought.** There is no mechanism — payment, proof-of-work, account age, anything — that mints reach. None will be added.

## Cold outreach: the token bucket

Contacting people who have no trust path to you — a first DM to a stranger, tagging a stranger, the notification for a reply to a stranger — costs a token from a daily budget (starting at 5/day for open signups, 15/day if you joined via a personal invite). Things that **never** cost tokens: posting to your own feed, anything within your trust neighborhood, and replying to anyone who contacted you first — once a conversation starts, it's free in both directions forever.

Your budget grows with the trust real people place in you — logarithmically, weighted by *their* standing, so it's generous early (~10 genuine followers roughly triples it) and flat later. A spam ring following itself adds nothing, because its members have no standing-weighted inbound trust of their own.

## See for yourself

Two ways to check any claim on this page: read your own feed's ranking math (your client can show you why each post ranks where it does — it computed the ranking), or run **simlab**, the in-repo simulator that executes the same trust and budget code the client ships with, on a synthetic population, with every constant adjustable and the results charted. Constants only change via public review citing simlab scenarios.

*The honest caveats — what these mechanisms don't protect against, and what the server can still see — are in the [threat model](../threat-model.md). One layer is deliberately unpublished: the exact numeric thresholds that trigger anti-spam friction (publishing them would be a spammer's manual). That this layer exists, and its boundaries, is public — you're reading it.*
