/**
 * Word-level diff — browser half.
 *
 * Takes over the `changes-review` tab type (the right-Sidebar review of one
 * turn's changed files) and renders it with intra-line highlighting: a removed
 * word inside a red line gets a deeper red, an inserted word inside a green
 * line gets a brighter green, the way Claude Code and VS Code show a word diff.
 *
 * How the takeover works: the sidebar tab registry keeps one `builtin` and one
 * `extension` registration per kind, and the extension is the one in force, so
 * registering the same kind and address globs from this external package routes
 * every changed-files review to our body. Uninstalling the plugin hands the tab
 * back to the shipped implementation.
 *
 * The comparison itself is read from the Host's own routes — the same
 * `api/changes.summary` / `api/changes.diff` records the shipped view reads —
 * so no Host-side work is involved and nothing about what counts as a change
 * changes.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-word-diff',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    /** Locale namespace this plugin owns. */
    const NS = 'word-diff'
    /** The tab kind we take over. */
    const KIND = 'changes-review'
    /** Resource-address prefix of a turn's review tab. */
    const ADDRESS_PREFIX = 'dsh-resource://changes-review/session/'
    /** Host route serving one turn's change summary. */
    const SUMMARY_ROUTE = 'api/changes.summary'
    /** Host route serving one listed file's comparison. */
    const DIFF_ROUTE = 'api/changes.diff'
    /** Lines drawn per comparison before the remainder is cut off. */
    const MAX_ROWS = 4000
    /** Ceiling on the token matrix one line pair may build. */
    const MAX_MATRIX = 250000
    const GROUPED = new Intl.NumberFormat('en-US')

    const zh = {
      title: '第 {turn} 轮改动',
      select: '选择文件',
      wrap: '自动换行',
      nowrap: '不换行',
      split: '并排对比',
      unified: '统一视图',
      inline: '逐词高亮',
      inlineOff: '只按整行高亮',
      loading: '加载中…',
      missing: '这一轮的改动记录已不可用',
      error: '读取对比失败',
      retry: '重试',
      binary: '二进制文件，无法显示改动',
      oversized: '文件过大，无法显示改动',
      created: '本轮新建的文件',
      deletedFile: '本轮删除的文件',
      unchanged: '两侧内容相同',
      coarse: '逐行对比超时，按整体替换显示',
      truncated: '只显示前 {count} 行',
      added: '+{count}',
      deleted: '-{count}',
      binaryShort: '二进制',
      oversizedShort: '过大',
    }

    const en = {
      title: 'Turn {turn} changes',
      select: 'Select file',
      wrap: 'Wrap lines',
      nowrap: 'No wrap',
      split: 'Side by side',
      unified: 'Unified',
      inline: 'Word highlights',
      inlineOff: 'Line highlights only',
      loading: 'Loading…',
      missing: 'This turn’s change record is no longer available',
      error: 'Could not read this comparison',
      retry: 'Retry',
      binary: 'Binary file; changes cannot be shown',
      oversized: 'File too large; changes cannot be shown',
      created: 'Created in this turn',
      deletedFile: 'Deleted in this turn',
      unchanged: 'Both sides hold the same lines',
      coarse: 'Line comparison timed out; shown as a whole-file replacement',
      truncated: 'Showing the first {count} lines',
      added: '+{count}',
      deleted: '-{count}',
      binaryShort: 'binary',
      oversizedShort: 'too large',
    }

    // ── address and routes ────────────────────────────────────────────────────

    /**
     * Read a review address back into coordinates.
     * @param {unknown} address - a resource address.
     * @returns {{sessionId: string, seq: number, turn: number} | undefined} the coordinates.
     */
    function parseAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(ADDRESS_PREFIX)) return undefined
      const parts = address.slice(ADDRESS_PREFIX.length).split('/')
      if (parts.length !== 3) return undefined
      const [rawSession, seq, turn] = parts
      if (rawSession === '' || !/^\d+$/.test(seq) || !/^[1-9]\d*$/.test(turn)) return undefined
      try {
        return { sessionId: decodeURIComponent(rawSession), seq: Number(seq), turn: Number(turn) }
      } catch {
        return undefined
      }
    }

    /** @returns {string} the summary route for one announced turn. */
    function summaryUrl(sessionId, seq) {
      return SUMMARY_ROUTE + '?' + new URLSearchParams({ sessionId, seq: String(seq) })
    }

    /** @returns {string} the comparison route for one listed file. */
    function diffUrl(sessionId, seq, index) {
      return DIFF_ROUTE + '?' + new URLSearchParams({ sessionId, seq: String(seq), index: String(index) })
    }

    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    function isSummary(value) {
      if (!isRecord(value)) return false
      const { turn, cwd, files, total, added, deleted } = value
      return Number.isSafeInteger(turn) && typeof cwd === 'string'
        && Number.isSafeInteger(total) && Number.isSafeInteger(added) && Number.isSafeInteger(deleted)
        && Array.isArray(files) && files.every(file => isRecord(file)
          && typeof file.path === 'string' && typeof file.display === 'string')
    }

    function isDiff(value) {
      if (!isRecord(value)) return false
      if (value.kind === 'binary' || value.kind === 'oversized') return true
      if (value.kind !== 'text') return false
      return Array.isArray(value.hunks) && value.hunks.every(hunk => isRecord(hunk)
        && Array.isArray(hunk.lines) && hunk.lines.every(line => typeof line === 'string'))
    }

    /** A read settles within this budget, so a stalled request can never leave the view loading. */
    const READ_TIMEOUT_MS = 15000

    /**
     * Read one authenticated Host record.
     * @param {string} url - a document-relative route.
     * @param {AbortSignal} signal - cancelled when the coordinates change.
     * @param {(value: unknown) => boolean} decode - shape check for the served JSON.
     * @returns {Promise<unknown | 'missing' | 'error'>} the record, or the state to show.
     */
    async function readJson(url, signal, decode) {
      const budget = typeof AbortSignal.timeout === 'function' && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
        : signal
      try {
        const response = await fetch(url, { signal: budget })
        if (response.status === 404) return 'missing'
        if (!response.ok) return 'error'
        const value = await response.json()
        return decode(value) ? value : 'error'
      } catch {
        return 'error'
      }
    }

    // ── word diff ─────────────────────────────────────────────────────────────

    /**
     * Split a line into comparison tokens: each CJK character, each word, each
     * whitespace run, and each remaining punctuation mark.
     * @param {string} text - one line of source.
     * @returns {string[]} the tokens in order.
     */
    function tokenize(text) {
      const tokens = []
      const pattern = /[\u3400-\u9fff\u3040-\u30ff\uf900-\ufaff]|[\p{L}\p{N}_$]+|\s+|[\s\S]/gu
      let match
      while ((match = pattern.exec(text)) !== null) tokens.push(match[0])
      return tokens
    }

    /**
     * Longest-common-subsequence edit script over two token arrays.
     * @param {string[]} left - tokens of the old line's changed span.
     * @param {string[]} right - tokens of the new line's changed span.
     * @returns {{kind: 'same' | 'del' | 'add', token: string}[]} the script.
     */
    function lcsOps(left, right) {
      const n = left.length
      const m = right.length
      const width = m + 1
      const table = new Uint32Array((n + 1) * width)
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          table[i * width + j] = left[i] === right[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
        }
      }
      const ops = []
      let i = 0
      let j = 0
      while (i < n && j < m) {
        if (left[i] === right[j]) {
          ops.push({ kind: 'same', token: left[i] })
          i += 1
          j += 1
        } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
          ops.push({ kind: 'del', token: left[i] })
          i += 1
        } else {
          ops.push({ kind: 'add', token: right[j] })
          j += 1
        }
      }
      while (i < n) { ops.push({ kind: 'del', token: left[i] }); i += 1 }
      while (j < m) { ops.push({ kind: 'add', token: right[j] }); j += 1 }
      return ops
    }

    /**
     * Coalesce an edit script into drawn runs for one side.
     * @param {{kind: string, token: string}[]} ops - the edit script.
     * @param {'left' | 'right'} side - which line is being drawn.
     * @returns {{text: string, changed: boolean}[]} the runs.
     */
    function runsOf(ops, side) {
      const runs = []
      const push = (text, changed) => {
        if (text === '') return
        const last = runs[runs.length - 1]
        if (last !== undefined && last.changed === changed) last.text += text
        else runs.push({ text, changed })
      }
      for (const op of ops) {
        if (op.kind === 'same') push(op.token, false)
        else if (side === 'left' ? op.kind === 'del' : op.kind === 'add') push(op.token, true)
      }
      return runs
    }

    /**
     * Mark what changed inside one paired deletion and addition.
     * @param {string} leftText - the removed line, without its sign.
     * @param {string} rightText - the added line, without its sign.
     * @returns {{left: {text: string, changed: boolean}[], right: {text: string, changed: boolean}[]}} both sides.
     */
    function wordDiff(leftText, rightText) {
      const left = tokenize(leftText)
      const right = tokenize(rightText)
      let prefix = 0
      while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1
      let suffix = 0
      while (suffix < left.length - prefix && suffix < right.length - prefix
        && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1
      const leftMiddle = left.slice(prefix, left.length - suffix)
      const rightMiddle = right.slice(prefix, right.length - suffix)
      const leftRuns = []
      const rightRuns = []
      if (prefix > 0) {
        leftRuns.push({ text: left.slice(0, prefix).join(''), changed: false })
        rightRuns.push({ text: right.slice(0, prefix).join(''), changed: false })
      }
      if (leftMiddle.length === 0 && rightMiddle.length === 0) {
        // The two lines tokenize identically; the line backgrounds already say so.
      } else if (leftMiddle.length === 0 || rightMiddle.length === 0
        || leftMiddle.length * rightMiddle.length > MAX_MATRIX) {
        if (leftMiddle.length > 0) leftRuns.push({ text: leftMiddle.join(''), changed: true })
        if (rightMiddle.length > 0) rightRuns.push({ text: rightMiddle.join(''), changed: true })
      } else {
        const ops = lcsOps(leftMiddle, rightMiddle)
        leftRuns.push(...runsOf(ops, 'left'))
        rightRuns.push(...runsOf(ops, 'right'))
      }
      if (suffix > 0) {
        leftRuns.push({ text: left.slice(left.length - suffix).join(''), changed: false })
        rightRuns.push({ text: right.slice(right.length - suffix).join(''), changed: false })
      }
      return { left: leftRuns, right: rightRuns }
    }

    // ── hunk model ────────────────────────────────────────────────────────────

    /** Similarity floor below which a removal and an addition are not treated as a rewritten line. */
    const MIN_PAIR_SIMILARITY = 0.3
    /** Share of either line the marks may cover before the pair is drawn as a plain replacement. */
    const MAX_MARK_RATIO = 0.75
    /** Largest removal/add run aligned by score; longer runs pair by position instead. */
    const MAX_ALIGN_ROWS = 40

    /**
     * Token overlap of two lines, 0..1, used to decide which removal an addition rewrote.
     * @param {string} leftText - the removed line.
     * @param {string} rightText - the added line.
     * @returns {number} twice the shared prefix–suffix-agnostic token count over their total length.
     */
    function similarity(leftText, rightText) {
      // Whitespace is ignored here: every indented line shares it, and it would
      // otherwise score two unrelated lines as half identical.
      const left = tokenize(leftText).filter(token => token.trim() !== '')
      const right = tokenize(rightText).filter(token => token.trim() !== '')
      if (left.length === 0 && right.length === 0) return 1
      if (left.length === 0 || right.length === 0) return 0
      const width = right.length + 1
      const table = new Uint16Array((left.length + 1) * width)
      for (let i = left.length - 1; i >= 0; i -= 1) {
        for (let j = right.length - 1; j >= 0; j -= 1) {
          table[i * width + j] = left[i] === right[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
        }
      }
      return (2 * table[0]) / (left.length + right.length)
    }

    /**
     * Align one run of removals with one run of additions, in order, so that the
     * summed line similarity is largest — git's pairing heuristic. Lines with no
     * good counterpart stay unpaired and keep only their line background.
     * @param {number[]} dels - removal row indexes, ascending.
     * @param {number[]} adds - addition row indexes, ascending.
     * @param {ReturnType<typeof hunkRows>} rows - the hunk's rows.
     * @returns {[number, number][]} removal row → addition row pairs, ascending.
     */
    function alignRun(dels, adds, rows) {
      const n = dels.length
      const m = adds.length
      const pairs = []
      if (n === 0 || m === 0) return pairs
      if (n > MAX_ALIGN_ROWS || m > MAX_ALIGN_ROWS) {
        for (let k = 0; k < Math.min(n, m); k += 1) pairs.push([dels[k], adds[k]])
        return pairs
      }
      const score = []
      for (let i = 0; i < n; i += 1) {
        const row = []
        for (let j = 0; j < m; j += 1) row.push(similarity(rows[dels[i]].text, rows[adds[j]].text))
        score.push(row)
      }
      const best = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          best[i][j] = Math.max(score[i][j] + best[i + 1][j + 1], best[i + 1][j], best[i][j + 1])
        }
      }
      let i = 0
      let j = 0
      while (i < n && j < m) {
        if (best[i][j] === score[i][j] + best[i + 1][j + 1]) {
          if (score[i][j] >= MIN_PAIR_SIMILARITY) pairs.push([dels[i], adds[j]])
          i += 1
          j += 1
        } else if (best[i][j] === best[i + 1][j]) i += 1
        else j += 1
      }
      return pairs
    }

    /**
     * Number a hunk's lines: context lines count on both sides, deletions on the
     * old side, additions on the new side.
     * @param {object} hunk - a served hunk.
     * @returns {{kind: 'add' | 'del' | 'context', old?: number, new?: number, text: string}[]} the rows.
     */
    function hunkRows(hunk) {
      let oldNo = Number(hunk.oldStart) || 0
      let newNo = Number(hunk.newStart) || 0
      return hunk.lines.map((line) => {
        const text = line.slice(1)
        switch (line[0]) {
          case '+': return { kind: 'add', old: undefined, new: newNo++, text }
          case '-': return { kind: 'del', old: oldNo++, new: undefined, text }
          default: return { kind: 'context', old: oldNo++, new: newNo++, text }
        }
      })
    }

    /**
     * Pair each run of removals with the additions that replaced it, then diff the
     * paired lines word by word. Pairing follows git's heuristic: removals and
     * additions are aligned in order so that the total token overlap is largest,
     * which keeps an inserted line from being compared against the wrong removal.
     * @param {ReturnType<typeof hunkRows>} rows - one hunk's rows.
     * @returns {Map<number, number>} removal row index → addition row index.
     */
    function pairRows(rows) {
      const pairing = new Map()
      let at = 0
      while (at < rows.length) {
        if (rows[at].kind === 'context') { at += 1; continue }
        const dels = []
        const adds = []
        while (at < rows.length && rows[at].kind !== 'context') {
          if (rows[at].kind === 'del') dels.push(at)
          else adds.push(at)
          at += 1
        }
        for (const pair of alignRun(dels, adds, rows)) pairing.set(pair[0], pair[1])
      }
      return pairing
    }

    /**
     * Mark what changed inside every paired line.
     *
     * Only a rewrite is marked: a line that was purely added or purely deleted has
     * no counterpart, so it keeps nothing but its line background. A pair whose
     * marks would cover most of both lines is dropped as well — at that point the
     * line is effectively replaced wholesale and full highlighting reads as noise.
     * @param {ReturnType<typeof hunkRows>} rows - one hunk's rows.
     * @param {Map<number, number>} pairing - removal row → addition row.
     * @returns {(undefined | {text: string, changed: boolean}[])[]} runs per row index.
     */
    function annotatePairs(rows, pairing) {
      const runs = new Array(rows.length)
      for (const [del, add] of pairing) {
        const diff = wordDiff(rows[del].text, rows[add].text)
        if (markedRatio(rows[del].text, diff.left) > MAX_MARK_RATIO) continue
        if (markedRatio(rows[add].text, diff.right) > MAX_MARK_RATIO) continue
        runs[del] = diff.left
        runs[add] = diff.right
      }
      return runs
    }

    /**
     * The share of a line the marks would cover.
     * @param {string} text - the line without its sign.
     * @param {{text: string, changed: boolean}[]} runs - its runs.
     * @returns {number} 0..1.
     */
    function markedRatio(text, runs) {
      if (runs === undefined || text.length === 0) return 0
      let marked = 0
      for (const run of runs) if (run.changed) marked += run.text.length
      return marked / text.length
    }

    /**
     * Pair a hunk's rows for the side-by-side view, keeping both sides' order.
     * @param {ReturnType<typeof hunkRows>} rows - one hunk's rows.
     * @param {(undefined | {text: string, changed: boolean}[])[]} runs - per-row runs.
     * @param {Map<number, number>} pairing - removal row → addition row.
     * @returns {{left?: object, right?: object}[]} the paired rows.
     */
    function splitRows(rows, runs, pairing) {
      const consumed = new Set(pairing.values())
      const out = []
      for (let at = 0; at < rows.length; at += 1) {
        const row = rows[at]
        if (row.kind === 'context') {
          out.push({
            left: { no: row.old, text: row.text, kind: 'context', runs: undefined },
            right: { no: row.new, text: row.text, kind: 'context', runs: undefined },
          })
        } else if (row.kind === 'del') {
          const add = pairing.get(at)
          const inserted = add === undefined ? undefined : rows[add]
          out.push({
            left: { no: row.old, text: row.text, kind: 'del', runs: runs[at] },
            right: inserted === undefined ? undefined : { no: inserted.new, text: inserted.text, kind: 'add', runs: runs[add] },
          })
        } else if (!consumed.has(at)) {
          out.push({ right: { no: row.new, text: row.text, kind: 'add', runs: runs[at] } })
        }
      }
      return out
    }

    /** @returns {string} the `@@` header of one hunk. */
    function hunkHeader(hunk) {
      return '@@ -' + hunk.oldStart + ',' + hunk.oldLines + ' +' + hunk.newStart + ',' + hunk.newLines + ' @@'
    }

    /**
     * Build everything one comparison draws, cutting the tail past {@link MAX_ROWS}.
     * @param {object} diff - a served text comparison.
     * @param {boolean} inline - whether word-level runs are wanted.
     * @returns {{hunks: object[], truncated: boolean}} the model.
     */
    function buildModel(diff, inline) {
      let budget = MAX_ROWS
      let truncated = false
      const hunks = []
      for (const hunk of diff.hunks) {
        if (budget <= 0) { truncated = true; break }
        const limited = hunk.lines.length <= budget ? hunk : { ...hunk, lines: hunk.lines.slice(0, budget) }
        budget -= limited.lines.length
        const rows = hunkRows(limited)
        const pairing = pairRows(rows)
        const runs = inline ? annotatePairs(rows, pairing) : new Array(rows.length)
        hunks.push({
          header: hunkHeader(limited),
          rows,
          runs,
          pairing,
          split: splitRows(rows, runs, pairing),
        })
      }
      if (!truncated) truncated = hunks.length < diff.hunks.length
      return { hunks, truncated }
    }

    // ── drawing ───────────────────────────────────────────────────────────────

    /** @returns {string | object[]} the text of one row, with marked runs when it has any. */
    function rowText(text, runs, kind) {
      if (runs === undefined || runs.length === 0) return text
      return runs.map((run, at) => (run.changed
        ? h('span', {
          key: at,
          className: kind === 'add' ? 'wd-mark wd-mark-add' : 'wd-mark wd-mark-del',
          'data-wd-mark': kind,
        }, run.text)
        : run.text))
    }

    function signOf(kind) {
      return kind === 'add' ? '+' : kind === 'del' ? '-' : ' '
    }

    function Status({ text, children }) {
      return h('p', { className: 'wd-status', role: 'status' }, h('span', null, text), children)
    }

    function Counts({ file, t }) {
      if (file.binary === true) return h('span', { className: 'wd-count wd-count-quiet' }, t('binaryShort'))
      if (file.oversized === true) return h('span', { className: 'wd-count wd-count-quiet' }, t('oversizedShort'))
      return h(React.Fragment, null,
        h('span', { className: 'wd-count wd-count-add' }, t('added', { count: GROUPED.format(file.added ?? 0) })),
        h('span', { className: 'wd-count wd-count-del' }, t('deleted', { count: GROUPED.format(file.deleted ?? 0) })))
    }

    /** The glyph inside a header tool: one 15px stroke drawing that inherits the button's colour. */
    function ToolIcon({ kind }) {
      const common = {
        viewBox: '0 0 16 16',
        className: 'wd-glyph wd-glyph-' + kind,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: 'false',
      }
      if (kind === 'split') {
        return h('svg', common,
          h('rect', { x: 1.9, y: 2.4, width: 12.2, height: 11.2, rx: 1.8 }),
          h('path', { d: 'M8 2.4v11.2' }))
      }
      if (kind === 'unified') {
        return h('svg', common,
          h('rect', { x: 1.9, y: 2.4, width: 12.2, height: 11.2, rx: 1.8 }),
          h('path', { d: 'M1.9 8h12.2' }))
      }
      if (kind === 'wrap') {
        return h('svg', common,
          h('path', { d: 'M2.4 4.2h11.2M2.4 7.8h8a2.1 2.1 0 0 1 0 4.2H7.6' }),
          h('path', { d: 'M9.2 10.2 7.3 12l1.9 1.9' }))
      }
      if (kind === 'nowrap') {
        return h('svg', common,
          h('path', { d: 'M2.4 4.2h11.2M2.4 7.8h11.2M2.4 11.4h7.4' }))
      }
      // 'inline': a highlighted word inside a line.
      return h('svg', common,
        h('rect', { x: 1.9, y: 3.1, width: 12.2, height: 9.8, rx: 1.8 }),
        h('rect', { x: 5.2, y: 6.6, width: 5.6, height: 2.8, rx: 0.9, fill: 'currentColor', stroke: 'none' }))
    }

    function ToolButton({ pressed, label, icon, onClick, testId }) {
      return h('button', {
        type: 'button',
        className: 'wd-tool',
        'aria-pressed': pressed,
        'aria-label': label,
        title: label,
        'data-wd-tool': testId,
        onClick,
      }, h(ToolIcon, { kind: icon }))
    }

    /**
     * Draw one comparison.
     * @param {object} props - the served comparison and the layout choices.
     * @returns {import('react').ReactNode} the comparison.
     */
    function DiffView({ diff, split, wrap, inline, t }) {
      const model = useMemo(() => (diff.kind === 'text' ? buildModel(diff, inline) : undefined), [diff, inline])
      if (diff.kind === 'binary') return h(Status, { text: t('binary') })
      if (diff.kind === 'oversized') return h(Status, { text: t('oversized') })
      const note = !diff.before ? 'created' : !diff.after ? 'deletedFile' : model.hunks.length === 0 ? 'unchanged' : undefined
      const children = []
      if (note !== undefined) {
        children.push(h('p', { key: 'note', className: 'wd-note', 'data-wd-note': note }, t(note)))
      }
      if (diff.coarse === true) {
        children.push(h('p', { key: 'coarse', className: 'wd-note' }, t('coarse')))
      }
      if (model.truncated) {
        children.push(h('p', { key: 'truncated', className: 'wd-note' }, t('truncated', { count: String(MAX_ROWS) })))
      }
      const body = h('div', {
        key: 'body',
        className: 'wd-body' + (wrap ? ' wd-wrap' : ''),
        'data-wd-view': split ? 'split' : 'unified',
      }, model.hunks.map((hunk, position) => h('section', { key: position, className: 'wd-hunk' },
        h('div', { className: 'wd-hunk-header' }, hunk.header),
        split
          ? hunk.split.map((row, at) => h('div', {
            key: at,
            className: 'wd-split-line',
            'data-wd-line': row.left?.kind === 'del' ? 'del' : row.right?.kind === 'add' ? 'add' : 'context',
          },
          h('span', {
            className: 'wd-cell' + (row.left === undefined ? ' wd-empty' : row.left.kind === 'del' ? ' wd-del' : ' wd-context'),
          },
          h('span', { className: 'wd-number' }, row.left?.no ?? ''),
          h('span', { className: 'wd-text' }, rowText(row.left?.text ?? '', row.left?.runs, 'del'))),
          h('span', {
            className: 'wd-cell' + (row.right === undefined ? ' wd-empty' : row.right.kind === 'add' ? ' wd-add' : ' wd-context'),
          },
          h('span', { className: 'wd-number' }, row.right?.no ?? ''),
          h('span', { className: 'wd-text' }, rowText(row.right?.text ?? '', row.right?.runs, 'add')))))
          : hunk.rows.map((row, at) => h('div', {
            key: at,
            className: 'wd-line wd-' + row.kind,
            'data-wd-line': row.kind,
          },
          h('span', { className: 'wd-number' }, row.old ?? ''),
          h('span', { className: 'wd-number' }, row.new ?? ''),
          h('span', { className: 'wd-sign' }, signOf(row.kind)),
          h('span', { className: 'wd-text' }, rowText(row.text, hunk.runs[at], row.kind)))))))
      children.push(body)
      return h('div', { className: 'wd-diff' }, children)
    }

    const CSS = `
.wd-root { display: flex; flex-direction: column; box-sizing: border-box; width: 100%; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); }
.wd-header { display: flex; flex: 0 0 auto; gap: 8px; align-items: center; box-sizing: border-box; min-height: 38px; padding: 0 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.wd-selector-label { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wd-select { flex: 1 1 auto; min-width: 0; max-width: 420px; height: 24px; padding: 0 6px; font: inherit; font-size: 12px; color: inherit; background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 6px; }
.wd-counts { display: inline-flex; gap: 6px; flex: 0 0 auto; font: var(--dsw-font-xs-13, inherit); font-variant-numeric: tabular-nums; }
.wd-count-add { color: rgb(1, 162, 65); }
.wd-count-del { color: rgb(186, 39, 35); }
.wd-count-quiet { color: var(--dsw-alias-label-tertiary); }
.wd-tools { display: inline-flex; flex: 0 0 auto; gap: 2px; align-items: center; margin-left: auto; }
.wd-tool { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.wd-tool svg { display: block; width: 15px; height: 15px; }
.wd-tool:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.wd-tool[aria-pressed='true'] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.wd-retry-button { height: 24px; padding: 0 10px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 6px; cursor: pointer; }
.wd-status { margin: 0; padding: 16px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.wd-note { margin: 0; padding: 4px 16px 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.wd-diff { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
.wd-body { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; overflow: auto; padding: 8px 0 16px; font: var(--dsw-font-markdown-code-block); font-size: 12px; line-height: 22px; }
/* Only the unwrapped unified view sizes its track to the longest line so it scrolls sideways. Wrapping must drop that track, or the column stays as wide as the longest line and pre-wrap never has a narrow enough box to wrap into. */
.wd-body[data-wd-view='unified']:not(.wd-wrap) { display: grid; grid-template-columns: minmax(max-content, 100%); align-content: start; }
.wd-hunk { margin-bottom: 8px; }
.wd-hunk-header { padding: 4px 16px; color: var(--dsw-alias-label-tertiary); white-space: pre; }
.wd-line { display: grid; grid-template-columns: 3.5em 3.5em 1.2em minmax(0, 1fr); box-sizing: border-box; min-height: 22px; line-height: 22px; white-space: pre; }
.wd-split-line { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); min-height: 22px; line-height: 22px; white-space: pre; }
.wd-cell { display: grid; grid-template-columns: 3.5em minmax(0, 1fr); box-sizing: border-box; min-width: 0; }
.wd-cell + .wd-cell { border-left: 0.5px solid var(--dsw-alias-border-l2); }
.wd-number { padding-right: 8px; color: var(--dsw-alias-label-tertiary); text-align: right; user-select: none; }
.wd-sign { text-align: center; user-select: none; }
.wd-text { padding-right: 16px; }
.wd-wrap .wd-line, .wd-wrap .wd-split-line { white-space: pre-wrap; }
.wd-wrap .wd-text { overflow-wrap: anywhere; }
/* Unwrapped side-by-side clips each column's long lines so they never run under the peer column. */
.wd-body[data-wd-view='split']:not(.wd-wrap) .wd-cell { overflow: hidden; }
.wd-body[data-wd-view='split']:not(.wd-wrap) .wd-text { overflow: hidden; text-overflow: ellipsis; }
.wd-add { --wd-gutter: var(--dsw-alias-file-diff-added-gutter); --wd-marker: var(--dsw-alias-file-diff-added-marker); background: var(--dsw-alias-file-diff-added-bg); }
.wd-del { --wd-gutter: var(--dsw-alias-file-diff-deleted-gutter); --wd-marker: var(--dsw-alias-file-diff-deleted-marker); background: var(--dsw-alias-file-diff-deleted-bg); }
.wd-add .wd-number, .wd-del .wd-number { background: var(--wd-gutter, transparent); color: var(--wd-marker, var(--dsw-alias-label-tertiary)); }
.wd-add .wd-sign, .wd-del .wd-sign { color: var(--wd-marker, var(--dsw-alias-label-tertiary)); }
.wd-add .wd-number:first-child, .wd-del .wd-number:first-child { box-shadow: inset 3px 0 0 var(--wd-marker, transparent); }
.wd-context .wd-text { color: var(--dsw-alias-label-secondary); }
.wd-empty { background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 50%, transparent); }
.wd-mark { border-radius: 2px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.wd-mark-add { background: color-mix(in srgb, var(--dsw-alias-file-diff-added-marker) 28%, transparent); }
.wd-mark-del { background: color-mix(in srgb, var(--dsw-alias-file-diff-deleted-marker) 28%, transparent); }
.wd-retry { padding: 8px 16px 0; }
`

    // ── remembered view ───────────────────────────────────────────────────────

    /** Where the two layout toggles are remembered across reviews and reloads. */
    const PREFS_KEY = 'dsh-word-diff:view'

    /**
     * Read the remembered layout, falling back to unified and unwrapped.
     * @returns {{split: boolean, wrap: boolean}} the remembered toggles.
     */
    function readViewPrefs() {
      try {
        const raw = window.localStorage.getItem(PREFS_KEY)
        if (raw === null) return { split: false, wrap: false }
        const value = JSON.parse(raw)
        return { split: value?.split === true, wrap: value?.wrap === true }
      } catch {
        return { split: false, wrap: false }
      }
    }

    /**
     * Remember the layout so the next review opens the way this one was left.
     * @param {{split: boolean, wrap: boolean}} prefs - the toggles to remember.
     */
    function writeViewPrefs(prefs) {
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify({ split: prefs.split === true, wrap: prefs.wrap === true }))
      } catch {
        // A browser that refuses storage just keeps the in-memory choice.
      }
    }

    // ── the review body ───────────────────────────────────────────────────────

    /**
     * The changed-files review with intra-line highlighting.
     * @param {object} props - slot props: session identity, the tab hook, and copy.
     * @returns {import('react').ReactNode} the review.
     */
    function WordDiffReview(props) {
      const { useTabInfo, sessionId, t: translate } = props
      const t = useCallback((key, vars) => {
        const value = typeof translate === 'function' ? translate(key, vars) : undefined
        return typeof value === 'string' ? value : key
      }, [translate])
      const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined
      const tab = info === undefined ? undefined : info.tab
      const contentId = tab === undefined ? undefined : tab.contentId
      const coordinates = useMemo(() => parseAddress(contentId), [contentId])

      const [summary, setSummary] = useState(undefined)
      const [summaryReload, setSummaryReload] = useState(0)
      const [diff, setDiff] = useState(undefined)
      const [reload, setReload] = useState(0)
      const [chosen, setChosen] = useState(undefined)
      const [split, setSplit] = useState(() => readViewPrefs().split)
      const [wrap, setWrap] = useState(() => readViewPrefs().wrap)
      const [inline, setInline] = useState(true)

      // Remember the two layout toggles so the next review opens as this one was left.
      useEffect(() => { writeViewPrefs({ split, wrap }) }, [split, wrap])

      const sessionKey = coordinates === undefined ? undefined : coordinates.sessionId
      const seqKey = coordinates === undefined ? undefined : coordinates.seq

      // One request per read, aborted when the coordinates change: the state this
      // effect writes must never be part of its dependencies, or the cleanup would
      // cancel the request that is still in flight and the view would load forever.
      useEffect(() => {
        if (sessionKey === undefined || seqKey === undefined) return undefined
        const controller = new AbortController()
        setSummary('loading')
        readJson(summaryUrl(sessionKey, seqKey), controller.signal, isSummary)
          .then((value) => { if (!controller.signal.aborted) setSummary(value) })
        return () => { controller.abort() }
      }, [sessionKey, seqKey, summaryReload])

      const navigated = tab === undefined || tab.navigation === undefined ? undefined : tab.navigation
      const navigatedRevision = navigated === undefined ? undefined : navigated.revision
      useEffect(() => {
        if (navigated === undefined) return
        const index = navigated.params === undefined ? undefined : navigated.params.index
        if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0) setChosen(index)
      }, [navigatedRevision])

      const files = summary !== null && typeof summary === 'object' ? summary.files : []
      const index = chosen !== undefined && files[chosen] !== undefined ? chosen : 0
      const file = files[index]
      const url = sessionKey === undefined || seqKey === undefined || file === undefined
        ? undefined : diffUrl(sessionKey, seqKey, index)

      useEffect(() => {
        if (url === undefined) { setDiff(undefined); return undefined }
        const controller = new AbortController()
        setDiff('loading')
        readJson(url, controller.signal, isDiff)
          .then((value) => { if (!controller.signal.aborted) setDiff(value) })
        return () => { controller.abort() }
      }, [url, reload])

      const retry = useCallback(() => { setReload((count) => count + 1) }, [])

      if (coordinates === undefined) {
        return h('div', { className: 'wd-root', 'data-word-diff': '' },
          h('style', { key: 'css' }, CSS),
          h(Status, { text: t('missing') }))
      }

      const header = h('div', { className: 'wd-header' },
        file === undefined
          ? h('span', { className: 'wd-selector-label' }, t('title', { turn: String(coordinates.turn) }))
          : h('select', {
            className: 'wd-select',
            'aria-label': t('select'),
            title: file.display,
            'data-wd-file': file.path,
            value: String(index),
            onChange: (event) => { setChosen(Number(event.target.value)) },
          }, files.map((entry, at) => h('option', { key: at, value: String(at) }, entry.display))),
        file === undefined ? null : h('span', { className: 'wd-counts' }, h(Counts, { file, t })),
        h('span', { className: 'wd-tools' },
          h(ToolButton, {
            pressed: split, testId: 'split', icon: split ? 'unified' : 'split',
            label: t(split ? 'unified' : 'split'),
            onClick: () => { setSplit((value) => !value) },
          }),
          h(ToolButton, {
            pressed: wrap, testId: 'wrap', icon: wrap ? 'nowrap' : 'wrap',
            label: t(wrap ? 'nowrap' : 'wrap'),
            onClick: () => { setWrap((value) => !value) },
          }),
          h(ToolButton, {
            pressed: inline, testId: 'inline', icon: 'inline',
            label: t(inline ? 'inlineOff' : 'inline'),
            onClick: () => { setInline((value) => !value) },
          })))

      const failure = (message, onClick) => h('div', { className: 'wd-failure' },
        h(Status, { text: message }),
        h('div', { className: 'wd-retry' },
          h('button', { type: 'button', className: 'wd-retry-button', onClick }, t('retry'))))

      let body
      if (summary === 'loading' || summary === undefined) body = h(Status, { text: t('loading') })
      else if (summary === 'missing') body = h(Status, { text: t('missing') })
      else if (summary === 'error') body = failure(t('error'), () => { setSummaryReload((count) => count + 1) })
      else if (file === undefined) body = h(Status, { text: t('unchanged') })
      else if (diff === 'loading' || diff === undefined) body = h(Status, { text: t('loading') })
      else if (diff === 'missing') body = h(Status, { text: t('missing') })
      else if (diff === 'error') body = failure(t('error'), retry)
      else body = h(DiffView, { diff, split, wrap, inline, t })

      return h('div', { className: 'wd-root', 'data-word-diff': '' },
        h('style', { key: 'css' }, CSS),
        header,
        body)
    }

    // ── plugin ────────────────────────────────────────────────────────────────

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'word-diff: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: '@local/dsh-word-diff',
          kind: KIND,
          patterns: [ADDRESS_PREFIX + '**'],
          priority: 'extension',
          canOpen: (address) => parseAddress(address) !== undefined,
          title: (address) => {
            const coordinates = parseAddress(address)
            return coordinates === undefined ? address : t('title', { turn: String(coordinates.turn) })
          },
        }), 'word-diff: changes-review type')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: '@local/dsh-word-diff',
          locale: NS,
          inject: () => ({}),
        }, WordDiffReview)), 'word-diff: review body')
      },
    }
  },
})
