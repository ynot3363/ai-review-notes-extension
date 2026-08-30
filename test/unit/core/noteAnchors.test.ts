import { describe, expect, it } from 'vitest';

import { createTextAnchor, reconcileTextAnchor } from '../../../src/core/noteAnchors';
import { MAX_ANCHOR_QUOTE_LENGTH } from '../../../src/core/noteStore';

describe('text anchor creation and reconciliation', () => {
  it('creates a bounded, hashed anchor and validates its last-known range', () => {
    const source = 'const answer = 42;\n';
    const range = {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 12 },
    };
    const anchor = createTextAnchor(source, range);

    expect(anchor).toMatchObject({
      range,
      quote: 'answer',
      quoteLength: 6,
      quoteTruncated: false,
    });
    expect(anchor.quoteHash).toMatch(/^[\da-f]{64}$/);
    expect(reconcileTextAnchor(source, anchor)).toEqual({
      state: 'attached',
      range,
      relocated: false,
    });
  });

  it('relocates a uniquely occurring quote after lines are inserted', () => {
    const original = 'const answer = calculate();\n';
    const anchor = createTextAnchor(original, {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 12 },
    });

    expect(reconcileTextAnchor(`// generated\n${original}`, anchor)).toEqual({
      state: 'attached',
      range: {
        start: { line: 1, character: 6 },
        end: { line: 1, character: 12 },
      },
      relocated: true,
    });
  });

  it('uses exact bounded context to disambiguate duplicate quotes', () => {
    const longPrefix = 'x'.repeat(300);
    const original = `${longPrefix}TARGET-first\nTARGET-second\n`;
    const anchor = createTextAnchor(original, {
      start: { line: 0, character: 300 },
      end: { line: 0, character: 306 },
    });
    const changed = `new text beyond context\n${original}`;

    expect(reconcileTextAnchor(changed, anchor)).toEqual({
      state: 'attached',
      range: {
        start: { line: 1, character: 300 },
        end: { line: 1, character: 306 },
      },
      relocated: true,
    });
  });

  it('returns ambiguous rather than selecting one of identical candidates', () => {
    const anchor = createTextAnchor('TARGET', {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 6 },
    });
    const result = reconcileTextAnchor('prefix TARGET and TARGET suffix', anchor);

    expect(result.state).toBe('ambiguous');
    if (result.state === 'ambiguous') {
      expect(result.candidateCount).toBe(2);
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('bounds ambiguous candidate previews while retaining the full count', () => {
    const anchor = createTextAnchor('\nx', {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 1 },
    });
    const result = reconcileTextAnchor('x'.repeat(200), anchor);

    expect(result.state).toBe('ambiguous');
    if (result.state === 'ambiguous') {
      expect(result.candidateCount).toBe(200);
      expect(result.candidates).toHaveLength(100);
    }
  });

  it('returns orphaned when selected content was deleted', () => {
    const anchor = createTextAnchor('keep remove keep', {
      start: { line: 0, character: 5 },
      end: { line: 0, character: 11 },
    });

    expect(reconcileTextAnchor('keep keep', anchor)).toEqual({
      state: 'orphaned',
      reason: 'content-not-found',
    });
  });

  it('does not relocate a short selection into the only unrelated larger token', () => {
    const anchor = createTextAnchor('const foo = value;\n', {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 9 },
    });

    expect(reconcileTextAnchor('const foobar = value;\n', anchor)).toEqual({
      state: 'orphaned',
      reason: 'content-not-found',
    });
  });

  it('does not guess a relocation for a truncated quote', () => {
    const quote = 'q'.repeat(MAX_ANCHOR_QUOTE_LENGTH + 1);
    const anchor = createTextAnchor(quote, {
      start: { line: 0, character: 0 },
      end: { line: 0, character: quote.length },
    });

    expect(anchor.quote).toHaveLength(MAX_ANCHOR_QUOTE_LENGTH);
    expect(anchor.quoteTruncated).toBe(true);
    expect(reconcileTextAnchor(`prefix${quote}`, anchor)).toEqual({
      state: 'orphaned',
      reason: 'quote-too-large-to-relocate',
    });
  });

  it('validates empty point anchors using both surrounding contexts', () => {
    const source = 'left right';
    const range = {
      start: { line: 0, character: 5 },
      end: { line: 0, character: 5 },
    };
    const anchor = createTextAnchor(source, range);

    expect(reconcileTextAnchor(source, anchor)).toEqual({
      state: 'attached',
      range,
      relocated: false,
    });
    expect(reconcileTextAnchor('left changed right', anchor).state).toBe('orphaned');
  });

  it('rejects impossible ranges instead of clamping them', () => {
    expect(() =>
      createTextAnchor('short', {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 99 },
      }),
    ).toThrow(RangeError);
  });

  it('orphanes a self-inconsistent anchor instead of trusting it', () => {
    const anchor = createTextAnchor('target', {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 6 },
    });

    expect(reconcileTextAnchor('target', { ...anchor, quoteHash: '0'.repeat(64) })).toEqual({
      state: 'orphaned',
      reason: 'invalid-last-range',
    });
  });

  it('honors zero-based UTF-16 ranges and CRLF line endings', () => {
    const source = 'first\r\nconst emoji = "😀";\r\n';
    const anchor = createTextAnchor(source, {
      start: { line: 1, character: 6 },
      end: { line: 1, character: 11 },
    });

    expect(anchor.quote).toBe('emoji');
    expect(reconcileTextAnchor(source, anchor).state).toBe('attached');
  });
});
