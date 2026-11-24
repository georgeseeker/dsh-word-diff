# Word-level diff

Colours the *changed words* inside a changed line, not just the line.

A unified diff already tells you which lines differ. It does not tell you what
inside a rewritten line survived: renaming an argument or editing one condition
repaints the whole line green or red, and the reader compares two long lines by
eye. This plugin pairs each removed line with the added line that replaced it,
diffs the pair token by token, and marks the surviving text as unchanged:

- the removed words on a red line get a **deeper red**;
- the inserted words on a green line get a **brighter green**;
- everything that did not change keeps only the line's own background.

## Where it appears

It takes over the changed-files review tab — the right-Sidebar pane a turn's
"changed files" card opens, showing one file's turn-start and turn-end
comparison at a time. Every review of that kind is drawn by this plugin while it
is enabled; disabling or removing the plugin hands the tab straight back to the
built-in view.

The compact hover preview over a changed-file row is the product's own view and
stays as shipped.

## Controls

| Control | Effect |
|---|---|
| File picker | Switches the comparison between the turn's changed files. |
| **Side by side / Unified** | Two-column pairing, or the usual single-column diff. |
| **Wrap lines / No wrap** | Whether long lines wrap or scroll horizontally. |
| **Word highlights** | Turns intra-line marks off, leaving the plain line backgrounds. |

## What it does not do

- No Host work: the comparison is the `api/changes.diff` record the Harness
  already serves, so what counts as "changed" is unchanged and no extra
  snapshots or diffs are computed server-side.
- Tokens are compared, not syntax trees: a renamed identifier matches as text, so
  a variable swap inside a call shows as two short marks rather than a moved
  block.
- A removal is paired with an addition by token overlap, aligned in order and
  maximising the summed similarity (git's rule of thumb). A line whose best
  counterpart is still below 30% overlap stays unpaired and keeps only its line
  background, so an unrelated insertion cannot "steal" a neighbouring removal and
  paint misleading marks. Runs longer than 40 lines fall back to positional
  pairing.
- Very large line pairs fall back to marking the whole differing span instead of
  running a quadratic token comparison.
