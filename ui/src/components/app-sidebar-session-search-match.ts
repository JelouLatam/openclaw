export type PreparedSearchText = {
  readonly chars: readonly string[];
  readonly normalized: readonly string[];
};

export type TokenMatch = { score: number; positions: number[] };

export type FieldsMatch = { score: number; positions: number[][] };

const WORD_SEPARATORS = new Set([" ", "-", "_", ":", "/", ".", "(", "[", "`", '"', "'"]);
const COMBINING_DIACRITICS = /[\u0300-\u036f]/gu;

const BONUS_PREFIX = 8;
const BONUS_WORD_START = 6;
const BONUS_CONSECUTIVE = 7;
const GAP_PENALTY = 1;
const GAP_PENALTY_MAX = 5;
const NO_SCORE = Number.NEGATIVE_INFINITY;

function normalizeSearchChar(char: string): string {
  return char.normalize("NFD").replace(COMBINING_DIACRITICS, "").toLowerCase();
}

export function normalizeSearchText(text: string): string {
  return Array.from(text).map(normalizeSearchChar).join("");
}

// Normalized per original character so match positions index `chars` directly.
export function prepareSearchText(text: string): PreparedSearchText {
  const chars = Array.from(text);
  return { chars, normalized: chars.map(normalizeSearchChar) };
}

export function tokenizeSearchQuery(query: string): string[] {
  return normalizeSearchText(query)
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

function isWordStart(prepared: PreparedSearchText, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const previous = prepared.chars[index - 1] ?? "";
  if (WORD_SEPARATORS.has(previous)) {
    return true;
  }
  const current = prepared.chars[index] ?? "";
  return previous !== previous.toUpperCase() && current !== current.toLowerCase();
}

function charBonus(prepared: PreparedSearchText, index: number): number {
  if (index === 0) {
    return 1 + BONUS_PREFIX;
  }
  return isWordStart(prepared, index) ? 1 + BONUS_WORD_START : 1;
}

function charMatches(normalized: string | undefined, queryChar: string | undefined): boolean {
  if (!normalized || !queryChar) {
    return false;
  }
  return normalized.length === 1 ? normalized === queryChar : normalized[0] === queryChar;
}

// Best-scoring subsequence: score[q][p] is the best score with query[q] at
// haystack position p. The gap penalty is capped, so positions further back
// than the cap feed one running maximum and only the last GAP_PENALTY_MAX
// positions are visited explicitly.
export function matchSearchToken(token: string, prepared: PreparedSearchText): TokenMatch | null {
  const query = Array.from(token);
  const width = prepared.normalized.length;
  if (query.length === 0 || query.length > width) {
    return null;
  }
  const score = new Float64Array(query.length * width).fill(NO_SCORE);
  const previous = new Int32Array(query.length * width).fill(-1);
  const scoreAt = (index: number) => score[index] ?? NO_SCORE;
  for (let p = 0; p < width; p += 1) {
    if (charMatches(prepared.normalized[p], query[0])) {
      score[p] = charBonus(prepared, p);
    }
  }
  for (let q = 1; q < query.length; q += 1) {
    const row = q * width;
    const previousRow = (q - 1) * width;
    let farBest = NO_SCORE;
    let farBestAt = -1;
    for (let p = q; p < width; p += 1) {
      const entering = p - GAP_PENALTY_MAX - 1;
      if (entering >= 0 && scoreAt(previousRow + entering) > farBest) {
        farBest = scoreAt(previousRow + entering);
        farBestAt = entering;
      }
      if (!charMatches(prepared.normalized[p], query[q])) {
        continue;
      }
      let best = farBest === NO_SCORE ? NO_SCORE : farBest - GAP_PENALTY_MAX;
      let bestPrevious = farBestAt;
      for (let earlier = Math.max(q - 1, p - GAP_PENALTY_MAX); earlier < p; earlier += 1) {
        const base = scoreAt(previousRow + earlier);
        if (base === NO_SCORE) {
          continue;
        }
        const gap = p - earlier - 1;
        const candidate = base + (gap === 0 ? BONUS_CONSECUTIVE : -gap * GAP_PENALTY);
        if (candidate > best) {
          best = candidate;
          bestPrevious = earlier;
        }
      }
      if (bestPrevious === -1) {
        continue;
      }
      score[row + p] = best + charBonus(prepared, p);
      previous[row + p] = bestPrevious;
    }
  }
  const lastRow = (query.length - 1) * width;
  let bestEnd = -1;
  let bestScore = NO_SCORE;
  for (let p = 0; p < width; p += 1) {
    if (scoreAt(lastRow + p) > bestScore) {
      bestScore = scoreAt(lastRow + p);
      bestEnd = p;
    }
  }
  if (bestEnd === -1) {
    return null;
  }
  const positions: number[] = [];
  for (let q = query.length - 1, p = bestEnd; q >= 0; q -= 1) {
    positions.unshift(p);
    p = previous[q * width + p] ?? -1;
  }
  return { score: bestScore, positions };
}

/** Every token must match some field; a token scores as its best field. */
export function scoreSearchFields(
  tokens: readonly string[],
  fields: readonly PreparedSearchText[],
): FieldsMatch | null {
  const matched = fields.map(() => new Set<number>());
  let total = 0;
  for (const token of tokens) {
    let best: { match: TokenMatch; positions: Set<number> } | null = null;
    for (const [index, field] of fields.entries()) {
      const match = matchSearchToken(token, field);
      const positions = matched[index];
      if (match && positions && (!best || match.score > best.match.score)) {
        best = { match, positions };
      }
    }
    if (!best) {
      return null;
    }
    const { match, positions } = best;
    total += match.score;
    for (const position of match.positions) {
      positions.add(position);
    }
  }
  // Only fields that carried a match weigh in, so shorter matches win ties
  // while rows that matched purely through a shared field stay tied.
  const matchedLength = fields.reduce(
    (sum, field, index) => sum + ((matched[index]?.size ?? 0) > 0 ? field.chars.length : 0),
    0,
  );
  return {
    score: total - matchedLength * 0.01,
    positions: matched.map((set) => [...set].toSorted((a, b) => a - b)),
  };
}
