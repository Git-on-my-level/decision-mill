# Design notes: label mode

Label mode was designed from three throwaway labeling apps that were actually used,
and from the feedback given while using them. Each choice below names the finding
that drove it. Only UX feedback is quoted; no labeled content appears here.

## Sources studied

| Source | What it was |
| ------ | ----------- |
| `~/.local/share/jev-pilots/judge/` (server.py, index.html, labels.jsonl) | The 2026-09-23 benchmark judge: 172 labels over four planned rounds of 32–52 cards, two queues, blind model answers, a Results tab. The closest prior art. |
| `~/.local/share/jev-pilots/mentor/judge/` | A port-8766 variant: useful / neutral / annoying on keys 1/2/3, waves of ~20, served over `tailscale serve`. |
| memory-eval `ui/` and `docs/gold-adjudication-principles.md` (scratch benchmark) | Card-based adjudication ("Majority says drop — confirm or flip"), append-only per-reviewer JSONL. |
| Session transcripts (`~/.claude/projects/...`) | The feedback quoted below. |
| This repository's spec-review | The existing keyboard model, one-click decide/undo, and surgical-write discipline. |

## Findings → choices

1. **Snippets are not judgeable.** Quote: "its really hard to judge sometimes from just
   a snippet? Why am I just judging a snippet?" The judge was rebuilt around the whole
   transcript, a note saying "This is the whole conversation, not an excerpt", and the
   neighbors captured within 45 minutes.
   → Items carry full `content`; the card says when it is the whole item and flags
   `truncated` excerpts; `context[]` neighbors are first-class and expandable to
   their own transcripts.

2. **Summaries help but bias.** In the same message: are there summaries "or no because
   that would be too much selection bias?" The rebuilt judge hid the app's summary
   behind a disclosure with a caveat that it is model-written and "can make a fragment
   look meaningful".
   → `summary` is collapsed by default with that caveat; `summary: open` is opt-in.

3. **The reviewer's first question is "is my labeling useful?"** Asked twice in one
   session ("Is my labeling useful?", "is it useful so far?"), then "Do we have enough
   signal now…?". The old Results tab answered with hand-written stat cards per
   experiment.
   → Results leads with a generic usefulness read: disagreements found (the labels
   that move a decision), each model's agreement with a 95% Wilson interval, how many
   more labels would tighten it, a one-sided-labels warning, and a small-sample flag.

4. **Rounds with a plan, not an endless queue.** The judge had a plan banner ("Now:
   Memories, round 1 — 32 cards, about 10 minutes"), per-round milestones, and
   auto-advance to the next unlabeled card. The mentor judge used waves of ~20, and the
   later instruction was "3 waves of 20 cards, and use a strong model like yourself to
   infer from my labels to create the rest".
   → `round_size`, a round bar with one dot per card, a pace estimate, a round-done
   screen with the usefulness headline, and deterministic rounds that resume with no
   stored state. Explicit `round` pins support hand-picked waves.

5. **Hand-picked rounds give biased rates.** The judge separated "random rounds only:
   the rates you can generalise" from rounds of hard cases.
   → Every result is broken down by `stratum`; `stratify: proportional` and a stratum
   named `random` cover the unbiased case; `balanced` (default) covers the score range.

6. **Model stand-ins fill the rest, and must be checked.** "Can the agent labels stand
   in for yours?" was a Results section, with a toggle to fill unjudged items from the
   agent's labels.
   → `source: model-standin` rows, a "Can the stand-in replace you?" table graded
   against human labels only, and a fill toggle. Human labels always outrank.

7. **Blind by default, and resist the majority.** The judge kept model answers hidden
   until Results ("Model answers stay hidden until the Results tab"). The adjudication
   principles warn: "Do not let model-majority become the gold definition … Models
   agreeing means they are similar, not correct."
   → `blind` defaults to true and is enforced by the server (hidden fields and the
   stratum, which usually encodes model answers, are withheld). Answers appear only
   after labeling, collapsed so they do not anchor the next card.

8. **Unsure is data.** Every prior app had a "Not sure" / "Can't tell" choice, and
   Results left them out of rates.
   → Unsure is always present (added if a task omits it) and excluded from agreement;
   Results counts it and suggests it as rubric material.

9. **Keyboard first, mistakes cheap.** Keys on every button (K/D/S, 1/2/3), `/` to
   type a note, arrows to move, and in spec-review one-click decide with one-click
   undo.
   → One keyboard model across both modes: j/k move, number keys are verdicts, u
   undoes, n notes, ⌘K searches, ? lists keys. Undo appends `label: null`, so the trail
   survives.

10. **Served to another machine over Tailscale.** The mentor judge was published with
    `tailscale serve --https=8766` and hard-coded its tailnet origin into a CSRF check.
    → Loopback bind by default plus `HOST`; relative URLs only (works behind a proxy
    at `/`); writes require same-origin JSON, with the proxy's
    `Tailscale-User-Login` header accepted as proof of proxying and used as the
    reviewer when `REVIEWER` is unset.

11. **Append-only, latest wins, per reviewer.** All three apps appended JSONL and took
    the last write per item; memory-eval split files per reviewer.
    → `labels/<reviewer>.jsonl`, folded latest-wins, with a per-file write queue so a
    stand-in agent and the browser can write at once.

12. **Audio needs to be checkable.** Voice-clip feedback elsewhere ("the voice clips are
    still wrong … static noise … maybe wrong time stamps") showed that a reviewer
    needs to hear what the label is about.
    → Optional `media[]` with an audio player (Range-served so seeking works), and
    transcript timestamps that seek the audio.

13. **Calm, obvious UI.** The request was "make the UI easy to use and obvious"; the
    judge used a warm light palette with a dark-mode variant and one card at a time.
    → One centered card, large choice buttons with visible keys, light and dark
    themes on shared tokens, and a phone-width layout.
