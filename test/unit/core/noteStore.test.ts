import { describe, expect, it } from 'vitest';

import { createTextAnchor } from '../../../src/core/noteAnchors';
import {
  createEmptyReviewNoteStore,
  isWorkspaceRelativePath,
  NoteStoreValidationError,
  parseReviewNoteStore,
  serializeReviewNoteStore,
  tryParseReviewNoteStore,
  validateStoredReviewNote,
  type StoredReviewNote,
} from '../../../src/core/noteStore';

function note(overrides: Partial<StoredReviewNote> = {}): StoredReviewNote {
  return {
    id: '64f8d415-c742-4a4d-9140-73fda994f3e8',
    relativePath: 'src/example.ts',
    anchorKind: 'range',
    category: 'Code Review',
    status: 'open',
    body: 'Please handle the failure path.',
    createdAt: '2026-08-30T12:00:00.000Z',
    updatedAt: '2026-08-30T12:01:00.000Z',
    anchor: createTextAnchor('const value = risky();\n', {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 11 },
    }),
    resolution: { state: 'attached' },
    ...overrides,
  };
}

describe('note store schema', () => {
  it('round-trips valid notes and optional symbol descriptors', () => {
    const original = note({
      symbol: {
        name: 'value',
        kind: 'Constant',
        containerName: 'Example',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 22 },
        },
      },
    });

    const parsed = parseReviewNoteStore(
      serializeReviewNoteStore({ version: 1, notes: [original] }),
    );

    expect(parsed).toEqual({ version: 1, notes: [original] });
  });

  it('serializes deterministically by path, range, and UUID', () => {
    const later = note({
      id: '397b34ce-3acf-45a8-8d21-05a9ea6267ed',
      relativePath: 'z.ts',
    });
    const earlier = note({
      id: '2596f84e-5d28-43b4-8962-1e3b9f4bf623',
      relativePath: 'a.ts',
    });

    const left = serializeReviewNoteStore({ version: 1, notes: [later, earlier] });
    const right = serializeReviewNoteStore({ version: 1, notes: [earlier, later] });

    expect(left).toBe(right);
    expect(left.indexOf('a.ts')).toBeLessThan(left.indexOf('z.ts'));
    expect(left.endsWith('\n')).toBe(true);
  });

  it('returns a typed empty document', () => {
    expect(createEmptyReviewNoteStore()).toEqual({ version: 1, notes: [] });
  });

  it.each([
    ['absolute POSIX', '/etc/passwd'],
    ['absolute Windows', 'C:/secret.txt'],
    ['parent traversal', '../secret.txt'],
    ['nested traversal', 'src/../../secret.txt'],
    ['dot segment', 'src/./file.ts'],
    ['backslash', 'src\\file.ts'],
    ['empty segment', 'src//file.ts'],
  ])('rejects %s paths', (_label, relativePath) => {
    expect(isWorkspaceRelativePath(relativePath)).toBe(false);
    expect(() => validateStoredReviewNote(note({ relativePath }))).toThrow(
      NoteStoreValidationError,
    );
  });

  it('rejects unknown properties at every validated object boundary', () => {
    const raw = JSON.parse(serializeReviewNoteStore({ version: 1, notes: [note()] })) as {
      notes: Array<Record<string, unknown>>;
    };
    raw.notes[0]!.unexpected = true;

    expect(() => parseReviewNoteStore(JSON.stringify(raw))).toThrow(/unknown property/);
  });

  it.each([
    ['wrong version', { version: 2, notes: [] }],
    ['non-array notes', { version: 1, notes: {} }],
    ['non-UUID ID', { version: 1, notes: [note({ id: 'not-an-id' })] }],
    [
      'backwards timestamps',
      {
        version: 1,
        notes: [
          note({
            createdAt: '2026-08-30T12:00:00.000Z',
            updatedAt: '2026-08-29T12:00:00.000Z',
          }),
        ],
      },
    ],
    [
      'invalid range',
      {
        version: 1,
        notes: [
          note({
            anchor: {
              ...note().anchor,
              range: {
                start: { line: 2, character: 0 },
                end: { line: 1, character: 0 },
              },
            },
          }),
        ],
      },
    ],
  ])('defensively rejects %s', (_label, value) => {
    expect(() => parseReviewNoteStore(JSON.stringify(value))).toThrow(NoteStoreValidationError);
  });

  it('rejects duplicate UUIDs and blank category/status fields', () => {
    expect(() => serializeReviewNoteStore({ version: 1, notes: [note(), note()] })).toThrow(
      /duplicate note UUID/,
    );
    expect(() => validateStoredReviewNote(note({ category: '   ' }))).toThrow(/must not be blank/);
    expect(validateStoredReviewNote(note({ body: '' })).body).toBe('');
  });

  it('requires symbol metadata for symbol anchors', () => {
    expect(() => validateStoredReviewNote(note({ anchorKind: 'symbol' }))).toThrow(
      /required when anchorKind is symbol/,
    );
  });

  it('rejects self-inconsistent quote hashes and truncation metadata', () => {
    const original = note();
    expect(() =>
      validateStoredReviewNote({
        ...original,
        anchor: { ...original.anchor, quoteHash: '0'.repeat(64) },
      }),
    ).toThrow(/does not match the stored quote/);
    expect(() =>
      validateStoredReviewNote({
        ...original,
        anchor: {
          ...original.anchor,
          quoteLength: original.anchor.quote.length + 1,
          quoteTruncated: true,
        },
      }),
    ).toThrow(/bounded quote/);
  });

  it('offers a non-throwing parse result for untrusted files', () => {
    const result = tryParseReviewNoteStore('{bad json');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(NoteStoreValidationError);
      expect(result.error.location).toBe('$');
    }
  });
});
