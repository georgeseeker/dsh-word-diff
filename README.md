# dsh-word-diff

Word-level highlighting for the changed-files review in the DeepSeek Harness Web GUI.
A red line keeps its red background and the words it lost get a deeper red; a green
line keeps its green background and the words it gained get a brighter green.

> 改动审阅里的行内高亮：删除行内的被删片段用更深的红，新增行内的新增片段用更亮的绿 ——
> 类似 Claude Code / VS Code 的逐词 diff，而不是整行染色。

## How it hooks in

The right-Sidebar tab registry keeps one `builtin` and one `extension` registration per
tab kind, and the extension is the one in force. This plugin registers the
`changes-review` kind (the review a turn's "changed files" card opens) as an extension
with the same address globs, so every review of that kind is drawn by
[`client.js`](client.js) while the plugin is enabled. Disable or remove the plugin and
the shipped view takes over again — there is no patching of shipped files.

Comparisons come from the Host routes the product already serves
(`api/changes.summary`, `api/changes.diff`), so what counts as a change is unchanged and
no extra diffs are computed server-side.

## Controls

| Control | Effect |
|---|---|
| file picker | switch between the turn's changed files |
| side by side / unified | two-column pairing or the usual single-column diff |
| wrap lines / no wrap | wrap long lines, or scroll horizontally |
| word highlights | turn the intra-line marks off |

The **side by side / unified** and **wrap** choices are remembered in the browser
(`localStorage`, key `dsh-word-diff:view`), so every review — and every reload — opens the
way you left it instead of resetting to unified. The word-highlight toggle is per-view.

## Install

The package is private and not published to npm. Install the directory as a bundle:

```text
Plugins → Add plugin → C:\Develop\dsh-plugins\word-diff
```

or

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "@local/dsh-word-diff": "link:C:/Develop/dsh-plugins/word-diff" },
  "dsh": { "profile": { "bundles": ["...", "@local/dsh-word-diff"] } }
}
```

The bundle patch mounts the plugin row as `word-diff`; the Client module registers
itself immediately and takes over the review tab.

## Layout

```
index.js           # Host half: no Host behaviour at all
client.js          # tab-type takeover, comparison reader, intra-line diff, view
cordis.patch.yml   # bundle patch inserting the word-diff row
locale/{en,zh}.json# plugin name / description / detail document
docs/DETAIL.md     # the detail document shown on the plugin page
icon.svg
```

## Where the marks come from

**Only a rewrite is marked.** A removal is paired with the addition that rewrote it by
token overlap: the run's removals and additions are aligned in order so that the summed
line similarity is largest (git's heuristic). A line whose best counterpart still overlaps
less than 30% stays unpaired, and a pair whose marks would cover more than 75% of both
lines is drawn plain — in both cases the line background is the only signal, which is what
a purely added or purely deleted line gets too.

A pair is tokenized (each CJK character, each word, each whitespace run, each punctuation
mark) and diffed with a longest-common-subsequence pass after trimming the common prefix
and suffix, so only the genuinely replaced tokens carry a mark. Pairs whose token matrix
would exceed 250 000 cells fall back to marking the whole differing span, and runs longer
than 40 lines fall back to positional pairing.
