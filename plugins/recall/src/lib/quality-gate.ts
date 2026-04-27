/**
 * quality-gate — reject corrupted / decayed / stuck-loop session exports.
 *
 * Three corruption classes the gate detects:
 *
 *   1. **stuck-loop** — a single line or N-gram repeats and dominates the doc.
 *      Symptom of a model that fell into a decoder loop ("so back to the vault
 *      reorg!" × 40 verbatim). Two checks:
 *        - 10+ contiguous identical lines (repeated-line)
 *        - any 4/8/16-gram covering >20% of total tokens (ngram-coverage)
 *
 *   2. **decayed-llm** — grammatical decay. Short, choppy sentences with low
 *      stopword density. The model is producing fragments not prose.
 *      Two checks:
 *        - >70% of sentences shorter than 4 words (short-sentences)
 *        - very low stopword-to-token ratio for non-trivial doc length
 *          (stopword-density)
 *
 *   3. **cross-session-concat** — fragments from unrelated sessions joined
 *      mid-sentence. Detected only by indirect symptoms (decay heuristics
 *      tend to fire on the joined boundary). The deeper fix lives in the
 *      export path, not here.
 *
 * Used at index time (accountly recall write path) and at query time
 * (accountly cmdHook backstop). Cheap lexical, no LLM, no I/O.
 *
 * Imports from this module are intentionally narrow so the function can be
 * embedded anywhere a string needs to be vetted before it reaches the model.
 */

export interface QualitySignals {
  totalTokens: number
  totalSentences: number
  /** Fraction of sentences with < 4 words. Range 0..1. */
  shortSentenceRatio: number
  /** stopword count / total tokens. Range 0..1. ~0.3-0.5 is typical English prose. */
  stopwordDensity: number
  /** Punctuation chars / total tokens. Range typically 0..1. */
  punctuationRatio: number
  /** Highest count of contiguous identical (trimmed, non-empty) lines. */
  maxLineRepeat: number
  /** Highest fraction of total tokens covered by a single 4/8/16-gram. Range 0..1. */
  maxNgramCoverage: number
  /** Which N (4/8/16) hit maxNgramCoverage. */
  maxNgramSize: number
}

export interface QualityResult {
  /** Lower = worse. 0..1 informational; the boolean gate is rejectReason. */
  score: number
  /** Set when the doc fails the gate. Format: "<class>:<rule>". */
  rejectReason?: string
  signals: QualitySignals
}

export interface QualityOpts {
  /** Below this token count, exempt the text (insufficient signal). Default 50. */
  minTokens?: number
}

const DEFAULT_OPTS: Required<QualityOpts> = { minTokens: 50 }

// English stopwords + common conversational fillers. Intentionally short — we
// only need a heuristic, not a linguistics library. Coverage tuned against
// the clean-good fixture (must score >= 0.20 stopword density).
const STOPWORDS = new Set<string>([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "here",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "me",
  "my",
  "no",
  "not",
  "now",
  "of",
  "on",
  "or",
  "our",
  "out",
  "over",
  "our",
  "should",
  "so",
  "some",
  "such",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "too",
  "under",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  "we'll",
  "we've",
  "i'll",
  "i've",
  "don't",
  "doesn't",
  "didn't",
  "isn't",
  "aren't",
  "can't",
  "won't",
  "let's",
  "it's",
  "that's",
  "there's",
  "what's",
  "who's",
  "where's",
  "how's",
  "us",
])

const WORD_RE = /[a-zA-Z][a-zA-Z'-]*/g
const SENTENCE_SPLIT_RE = /[.!?]+\s+|\n{2,}/

/** Tokenize to lowercase word tokens (alphabetic). Markdown / YAML noise is dropped. */
function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(WORD_RE)
  return matches ?? []
}

/** Strip common YAML frontmatter and markdown structural lines so we judge prose, not framing. */
function stripFraming(text: string): string {
  // Frontmatter: --- ... ---
  let stripped = text.replace(/^---\n[\s\S]*?\n---\n/, "")
  // Markdown headings
  stripped = stripped.replace(/^#{1,6}\s.*$/gm, "")
  // Blockquote markers (don't drop the content — just the leading >)
  stripped = stripped.replace(/^>+\s?/gm, "")
  return stripped
}

function maxContiguousRepeatedLine(text: string): number {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return 0
  let max = 1
  let run = 1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === lines[i - 1]) {
      run++
      if (run > max) max = run
    } else {
      run = 1
    }
  }
  return max
}

/** Return the maximum fraction of tokens covered by any N-gram, for N in {4, 8, 16}. */
function maxNgramCoverage(tokens: string[]): { coverage: number; n: number } {
  if (tokens.length < 4) return { coverage: 0, n: 0 }
  let best = { coverage: 0, n: 0 }
  for (const n of [4, 8, 16]) {
    if (tokens.length < n * 2) continue
    const counts = new Map<string, number>()
    for (let i = 0; i <= tokens.length - n; i++) {
      const gram = tokens.slice(i, i + n).join(" ")
      counts.set(gram, (counts.get(gram) ?? 0) + 1)
    }
    let topCount = 0
    for (const c of counts.values()) {
      if (c > topCount) topCount = c
    }
    // A repeated 4-gram covers 4*topCount tokens.
    const coverage = (topCount * n) / tokens.length
    if (coverage > best.coverage) best = { coverage, n }
  }
  return best
}

function shortSentenceRatio(prose: string): { ratio: number; total: number } {
  const sentences = prose
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (sentences.length === 0) return { ratio: 0, total: 0 }
  let short = 0
  for (const s of sentences) {
    const wc = (s.match(WORD_RE) ?? []).length
    if (wc < 4) short++
  }
  return { ratio: short / sentences.length, total: sentences.length }
}

function punctuationRatio(prose: string, tokens: number): number {
  if (tokens === 0) return 0
  const puncts = prose.match(/[.,;:!?]/g) ?? []
  return puncts.length / tokens
}

function stopwordDensity(tokens: string[]): number {
  if (tokens.length === 0) return 1
  let hits = 0
  for (const t of tokens) {
    if (STOPWORDS.has(t)) hits++
  }
  return hits / tokens.length
}

export function analyzeQuality(text: string): QualityResult {
  const prose = stripFraming(text)
  const tokens = tokenize(prose)
  const totalTokens = tokens.length

  const repeat = maxContiguousRepeatedLine(prose)
  const ngram = maxNgramCoverage(tokens)
  const sent = shortSentenceRatio(prose)
  const sw = stopwordDensity(tokens)
  const pr = punctuationRatio(prose, totalTokens)

  const signals: QualitySignals = {
    totalTokens,
    totalSentences: sent.total,
    shortSentenceRatio: sent.ratio,
    stopwordDensity: sw,
    punctuationRatio: pr,
    maxLineRepeat: repeat,
    maxNgramCoverage: ngram.coverage,
    maxNgramSize: ngram.n,
  }

  // Order matters: more specific reasons first.
  let rejectReason: string | undefined
  if (repeat >= 10) {
    rejectReason = "stuck-loop:repeated-line"
  } else if (ngram.coverage > 0.2) {
    rejectReason = "stuck-loop:ngram-coverage"
  } else if (totalTokens >= DEFAULT_OPTS.minTokens) {
    if (sent.total >= 5 && sent.ratio > 0.7) {
      rejectReason = "decayed-llm:short-sentences"
    } else if (sw < 0.1) {
      rejectReason = "decayed-llm:stopword-density"
    } else if (pr < 0.02 && sent.total >= 5) {
      rejectReason = "decayed-llm:punctuation"
    }
  }

  // Score: 1 - max(symptom strengths). Informational only.
  const symptomStrength = Math.max(
    Math.min(1, repeat / 10),
    Math.min(1, ngram.coverage / 0.2),
    Math.min(1, sent.ratio / 0.7),
    Math.min(1, (0.1 - sw) / 0.1),
  )
  const score = Math.max(0, 1 - symptomStrength)

  return { score, rejectReason, signals }
}

export function isAcceptable(text: string, opts?: QualityOpts): boolean {
  const minTokens = opts?.minTokens ?? DEFAULT_OPTS.minTokens
  const prose = stripFraming(text)
  const tokens = tokenize(prose)
  // Short text: only run the always-cheap repeated-line + ngram checks. Skip
  // the prose heuristics that need enough data to be meaningful.
  if (tokens.length < minTokens) {
    const repeat = maxContiguousRepeatedLine(prose)
    if (repeat >= 10) return false
    const ng = maxNgramCoverage(tokens)
    if (ng.coverage > 0.2) return false
    return true
  }
  return analyzeQuality(text).rejectReason === undefined
}
