import { createHash } from 'node:crypto';

import {
  MAX_ANCHOR_CONTEXT_LENGTH,
  MAX_ANCHOR_QUOTE_LENGTH,
  type NotePosition,
  type NoteRange,
  type NoteTextAnchor,
} from './noteStore';

const MAX_REPORTED_CANDIDATE_RANGES = 100;

export type AnchorReconciliation =
  | {
      readonly state: 'attached';
      readonly range: NoteRange;
      readonly relocated: boolean;
    }
  | {
      readonly state: 'orphaned';
      readonly reason: 'content-not-found' | 'invalid-last-range' | 'quote-too-large-to-relocate';
    }
  | {
      readonly state: 'ambiguous';
      readonly candidateCount: number;
      /** Bounded preview; candidateCount can be greater than this array's length. */
      readonly candidates: readonly NoteRange[];
    };

/** Create a defensive content anchor for a valid, zero-based, end-exclusive range. */
export function createTextAnchor(source: string, range: NoteRange): NoteTextAnchor {
  const offsets = rangeToOffsets(source, range);
  if (!offsets) {
    throw new RangeError('The note range is outside the supplied source text.');
  }

  const selected = source.slice(offsets.start, offsets.end);
  const prefix = source.slice(
    Math.max(0, offsets.start - MAX_ANCHOR_CONTEXT_LENGTH),
    offsets.start,
  );
  const suffix = source.slice(offsets.end, offsets.end + MAX_ANCHOR_CONTEXT_LENGTH);
  const quote = selected.slice(0, MAX_ANCHOR_QUOTE_LENGTH);

  return {
    range: cloneRange(range),
    quote,
    quoteLength: selected.length,
    quoteTruncated: selected.length > quote.length,
    quoteHash: hashText(selected),
    prefixLength: prefix.length,
    prefixHash: hashText(prefix),
    suffixLength: suffix.length,
    suffixHash: hashText(suffix),
  };
}

/**
 * Reconcile an anchor without guessing. The prior range wins only after content
 * validation; relocation always requires an exact context match. This avoids
 * silently treating a short selection as a substring of unrelated content.
 */
export function reconcileTextAnchor(source: string, anchor: NoteTextAnchor): AnchorReconciliation {
  if (!isSelfConsistentAnchor(anchor)) {
    return { state: 'orphaned', reason: 'invalid-last-range' };
  }
  const lastOffsets = rangeToOffsets(source, anchor.range);
  if (
    lastOffsets &&
    matchesQuoteAt(source, anchor, lastOffsets.start, lastOffsets.end) &&
    matchesContextAt(source, anchor, lastOffsets.start, lastOffsets.end)
  ) {
    return { state: 'attached', range: cloneRange(anchor.range), relocated: false };
  }

  if (anchor.quoteTruncated) {
    return { state: 'orphaned', reason: 'quote-too-large-to-relocate' };
  }
  if (anchor.quote.length === 0) {
    return {
      state: 'orphaned',
      reason: lastOffsets ? 'content-not-found' : 'invalid-last-range',
    };
  }

  const occurrences = summarizeOccurrences(source, anchor);
  if (occurrences.total === 0) {
    return { state: 'orphaned', reason: 'content-not-found' };
  }

  if (occurrences.total === 1) {
    const start = occurrences.starts[0]!;
    if (occurrences.contextTotal === 1) {
      return {
        state: 'attached',
        range: offsetsToRange(source, start, start + anchor.quote.length),
        relocated: true,
      };
    }
    return { state: 'orphaned', reason: 'content-not-found' };
  }

  if (occurrences.contextTotal === 1) {
    const start = occurrences.contextStarts[0]!;
    return {
      state: 'attached',
      range: offsetsToRange(source, start, start + anchor.quote.length),
      relocated: true,
    };
  }

  const hasContextCandidates = occurrences.contextTotal > 1;
  const candidateStarts = hasContextCandidates ? occurrences.contextStarts : occurrences.starts;
  return {
    state: 'ambiguous',
    candidateCount: hasContextCandidates ? occurrences.contextTotal : occurrences.total,
    candidates: candidateStarts.map((start) =>
      offsetsToRange(source, start, start + anchor.quote.length),
    ),
  };
}

/** Stable SHA-256 hash used by the persisted anchor schema. */
export function hashAnchorText(value: string): string {
  return hashText(value);
}

function matchesQuoteAt(
  source: string,
  anchor: NoteTextAnchor,
  start: number,
  end: number,
): boolean {
  const selected = source.slice(start, end);
  return (
    selected.length === anchor.quoteLength &&
    hashText(selected) === anchor.quoteHash &&
    (anchor.quoteTruncated || selected === anchor.quote)
  );
}

function matchesContextAt(
  source: string,
  anchor: NoteTextAnchor,
  start: number,
  end: number,
): boolean {
  const prefix = source.slice(Math.max(0, start - anchor.prefixLength), start);
  const suffix = source.slice(end, end + anchor.suffixLength);
  return (
    prefix.length === anchor.prefixLength &&
    suffix.length === anchor.suffixLength &&
    hashText(prefix) === anchor.prefixHash &&
    hashText(suffix) === anchor.suffixHash
  );
}

interface OccurrenceSummary {
  readonly total: number;
  readonly starts: readonly number[];
  readonly contextTotal: number;
  readonly contextStarts: readonly number[];
}

function summarizeOccurrences(source: string, anchor: NoteTextAnchor): OccurrenceSummary {
  let total = 0;
  let contextTotal = 0;
  const starts: number[] = [];
  const contextStarts: number[] = [];
  let fromIndex = 0;
  while (fromIndex <= source.length - anchor.quote.length) {
    const index = source.indexOf(anchor.quote, fromIndex);
    if (index < 0) {
      break;
    }
    total += 1;
    if (starts.length < MAX_REPORTED_CANDIDATE_RANGES) {
      starts.push(index);
    }
    if (matchesContextAt(source, anchor, index, index + anchor.quote.length)) {
      contextTotal += 1;
      if (contextStarts.length < MAX_REPORTED_CANDIDATE_RANGES) {
        contextStarts.push(index);
      }
    }
    fromIndex = index + 1;
  }
  return { total, starts, contextTotal, contextStarts };
}

function isSelfConsistentAnchor(anchor: NoteTextAnchor): boolean {
  const validHash = (value: string): boolean => /^[\da-f]{64}$/.test(value);
  const boundedContextLength = (value: number): boolean =>
    Number.isSafeInteger(value) && value >= 0 && value <= MAX_ANCHOR_CONTEXT_LENGTH;
  if (
    anchor.quote.length > MAX_ANCHOR_QUOTE_LENGTH ||
    !Number.isSafeInteger(anchor.quoteLength) ||
    anchor.quoteLength < 0 ||
    !boundedContextLength(anchor.prefixLength) ||
    !boundedContextLength(anchor.suffixLength) ||
    !validHash(anchor.quoteHash) ||
    !validHash(anchor.prefixHash) ||
    !validHash(anchor.suffixHash)
  ) {
    return false;
  }
  if (anchor.quoteTruncated) {
    return (
      anchor.quote.length === MAX_ANCHOR_QUOTE_LENGTH &&
      anchor.quoteLength > MAX_ANCHOR_QUOTE_LENGTH
    );
  }
  return anchor.quoteLength === anchor.quote.length && hashText(anchor.quote) === anchor.quoteHash;
}

function rangeToOffsets(
  source: string,
  range: NoteRange,
): { readonly start: number; readonly end: number } | undefined {
  if (comparePositions(range.start, range.end) > 0) {
    return undefined;
  }
  const lineStarts = getLineStarts(source);
  const start = positionToOffset(source, lineStarts, range.start);
  const end = positionToOffset(source, lineStarts, range.end);
  if (start === undefined || end === undefined || start > end) {
    return undefined;
  }
  return { start, end };
}

function positionToOffset(
  source: string,
  lineStarts: readonly number[],
  position: NotePosition,
): number | undefined {
  if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character)) {
    return undefined;
  }
  if (position.line < 0 || position.character < 0 || position.line >= lineStarts.length) {
    return undefined;
  }
  const lineStart = lineStarts[position.line]!;
  const contentEnd = getLineContentEnd(source, lineStarts, position.line);
  if (position.character > contentEnd - lineStart) {
    return undefined;
  }
  return lineStart + position.character;
}

function offsetsToRange(source: string, start: number, end: number): NoteRange {
  const lineStarts = getLineStarts(source);
  return {
    start: offsetToPosition(lineStarts, start),
    end: offsetToPosition(lineStarts, end),
  };
}

function offsetToPosition(lineStarts: readonly number[], offset: number): NotePosition {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle]! <= offset) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const line = Math.max(0, high);
  return { line, character: offset - lineStarts[line]! };
}

function getLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function getLineContentEnd(source: string, lineStarts: readonly number[], line: number): number {
  const nextLineStart = lineStarts[line + 1];
  if (nextLineStart === undefined) {
    return source.length;
  }
  let end = nextLineStart - 1;
  if (end > lineStarts[line]! && source.charCodeAt(end - 1) === 13) {
    end -= 1;
  }
  return end;
}

function comparePositions(left: NotePosition, right: NotePosition): number {
  return left.line - right.line || left.character - right.character;
}

function cloneRange(range: NoteRange): NoteRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
