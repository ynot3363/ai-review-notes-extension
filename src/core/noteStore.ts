import { createHash } from 'node:crypto';

/** Current on-disk schema version for Coding Notes for AI sidecar files. */
export const NOTE_STORE_VERSION = 1 as const;

/** Default shared sidecar name within each workspace folder. */
export const NOTE_STORE_FILENAME = 'CODING_NOTES_FOR_AI.json';

export const MAX_NOTE_COUNT = 10_000;
export const MAX_STORE_JSON_LENGTH = 10 * 1024 * 1024;
export const MAX_NOTE_BODY_LENGTH = 262_144;
export const MAX_ANCHOR_QUOTE_LENGTH = 4_096;
export const MAX_ANCHOR_CONTEXT_LENGTH = 256;

const MAX_SHORT_TEXT_LENGTH = 1_024;
const MAX_PATH_LENGTH = 4_096;
const MAX_POSITION_VALUE = 10_000_000;
const SHA_256_PATTERN = /^[\da-f]{64}$/;
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

export interface NotePosition {
  /** Zero-based source line. */
  readonly line: number;
  /** Zero-based UTF-16 character offset within the line. */
  readonly character: number;
}

/** A zero-based, end-exclusive source range compatible with VS Code ranges. */
export interface NoteRange {
  readonly start: NotePosition;
  readonly end: NotePosition;
}

/**
 * A bounded text anchor. The full selected text is hashed, while only a bounded
 * quote is persisted. Long quotes can be validated in place but are not guessed
 * at elsewhere in the file.
 */
export interface NoteTextAnchor {
  readonly range: NoteRange;
  readonly quote: string;
  readonly quoteLength: number;
  readonly quoteTruncated: boolean;
  readonly quoteHash: string;
  readonly prefixLength: number;
  readonly prefixHash: string;
  readonly suffixLength: number;
  readonly suffixHash: string;
}

/** Optional best-effort identity supplied by a language's document-symbol provider. */
export interface NoteSymbolDescriptor {
  readonly name: string;
  readonly kind: string;
  readonly containerName?: string;
  readonly range?: NoteRange;
}

export type NoteOrphanReason =
  'content-not-found' | 'invalid-last-range' | 'quote-too-large-to-relocate' | 'source-unavailable';

export type NoteResolution =
  | { readonly state: 'attached' }
  | { readonly state: 'orphaned'; readonly reason: NoteOrphanReason }
  | { readonly state: 'ambiguous'; readonly candidateCount: number };

export interface StoredReviewNote {
  readonly id: string;
  /** Normalized, slash-separated path relative to this store's workspace root. */
  readonly relativePath: string;
  readonly anchorKind: 'line' | 'range' | 'symbol';
  readonly category: string;
  readonly status: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly anchor: NoteTextAnchor;
  readonly symbol?: NoteSymbolDescriptor;
  readonly resolution: NoteResolution;
}

export interface ReviewNoteStore {
  readonly version: typeof NOTE_STORE_VERSION;
  readonly notes: readonly StoredReviewNote[];
}

export interface ReviewNoteStoreParseSuccess {
  readonly ok: true;
  readonly value: ReviewNoteStore;
}

export interface ReviewNoteStoreParseFailure {
  readonly ok: false;
  readonly error: NoteStoreValidationError;
}

export type ReviewNoteStoreParseResult = ReviewNoteStoreParseSuccess | ReviewNoteStoreParseFailure;

export class NoteStoreValidationError extends Error {
  public constructor(
    message: string,
    public readonly location = '$',
  ) {
    super(`${location}: ${message}`);
    this.name = 'NoteStoreValidationError';
  }
}

export function createEmptyReviewNoteStore(): ReviewNoteStore {
  return { version: NOTE_STORE_VERSION, notes: [] };
}

/** Parse and strictly validate an untrusted sidecar document. */
export function parseReviewNoteStore(json: string): ReviewNoteStore {
  if (json.length > MAX_STORE_JSON_LENGTH) {
    throw new NoteStoreValidationError(
      `document exceeds the ${MAX_STORE_JSON_LENGTH} character safety limit`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown JSON parse error';
    throw new NoteStoreValidationError(`invalid JSON (${detail})`);
  }

  return validateReviewNoteStore(value);
}

export function tryParseReviewNoteStore(json: string): ReviewNoteStoreParseResult {
  try {
    return { ok: true, value: parseReviewNoteStore(json) };
  } catch (error) {
    if (error instanceof NoteStoreValidationError) {
      return { ok: false, error };
    }
    throw error;
  }
}

/** Validate a programmatically-created document and return a defensive copy. */
export function validateReviewNoteStore(value: unknown): ReviewNoteStore {
  const root = requireObject(value, '$');
  requireExactKeys(root, ['version', 'notes'], '$');
  if (root.version !== NOTE_STORE_VERSION) {
    throw new NoteStoreValidationError(
      `unsupported version; expected ${NOTE_STORE_VERSION}`,
      '$.version',
    );
  }
  if (!Array.isArray(root.notes)) {
    throw new NoteStoreValidationError('expected an array', '$.notes');
  }
  if (root.notes.length > MAX_NOTE_COUNT) {
    throw new NoteStoreValidationError(`contains more than ${MAX_NOTE_COUNT} notes`, '$.notes');
  }

  const ids = new Set<string>();
  const notes = root.notes.map((note, index) => {
    const validated = validateStoredReviewNote(note, `$.notes[${index}]`);
    if (ids.has(validated.id)) {
      throw new NoteStoreValidationError('duplicate note UUID', `$.notes[${index}].id`);
    }
    ids.add(validated.id);
    return validated;
  });
  return { version: NOTE_STORE_VERSION, notes };
}

/** Validate one note and return a normalized defensive copy. */
export function validateStoredReviewNote(value: unknown, location = '$'): StoredReviewNote {
  const note = requireObject(value, location);
  requireExactKeys(
    note,
    [
      'id',
      'relativePath',
      'anchorKind',
      'category',
      'status',
      'body',
      'createdAt',
      'updatedAt',
      'anchor',
      'resolution',
    ],
    location,
    ['symbol'],
  );

  const id = requireString(note.id, `${location}.id`, 36);
  if (!UUID_PATTERN.test(id)) {
    throw new NoteStoreValidationError('expected a canonical UUID', `${location}.id`);
  }
  const relativePath = requireWorkspaceRelativePath(note.relativePath, `${location}.relativePath`);
  if (note.anchorKind !== 'line' && note.anchorKind !== 'range' && note.anchorKind !== 'symbol') {
    throw new NoteStoreValidationError('expected line, range, or symbol', `${location}.anchorKind`);
  }
  const category = requireNonBlankString(
    note.category,
    `${location}.category`,
    MAX_SHORT_TEXT_LENGTH,
  );
  const status = requireNonBlankString(note.status, `${location}.status`, MAX_SHORT_TEXT_LENGTH);
  const body = requireString(note.body, `${location}.body`, MAX_NOTE_BODY_LENGTH);
  const createdAt = requireIsoTimestamp(note.createdAt, `${location}.createdAt`);
  const updatedAt = requireIsoTimestamp(note.updatedAt, `${location}.updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new NoteStoreValidationError('must not precede createdAt', `${location}.updatedAt`);
  }

  const validated: StoredReviewNote = {
    id: id.toLowerCase(),
    relativePath,
    anchorKind: note.anchorKind,
    category,
    status,
    body,
    createdAt,
    updatedAt,
    anchor: validateTextAnchor(note.anchor, `${location}.anchor`),
    resolution: validateResolution(note.resolution, `${location}.resolution`),
  };
  if (validated.anchorKind === 'symbol' && note.symbol === undefined) {
    throw new NoteStoreValidationError(
      'is required when anchorKind is symbol',
      `${location}.symbol`,
    );
  }
  if (note.symbol !== undefined) {
    return {
      ...validated,
      symbol: validateSymbolDescriptor(note.symbol, `${location}.symbol`),
    };
  }
  return validated;
}

/**
 * Serialize with a fixed field order and stable note ordering. Equivalent stores
 * therefore produce byte-for-byte identical UTF-8 content.
 */
export function serializeReviewNoteStore(value: unknown): string {
  const store = validateReviewNoteStore(value);
  const notes = [...store.notes].sort(compareNotes).map(toCanonicalNote);
  const serialized = `${JSON.stringify({ version: NOTE_STORE_VERSION, notes }, undefined, 2)}\n`;
  if (serialized.length > MAX_STORE_JSON_LENGTH) {
    throw new NoteStoreValidationError(
      `serialized document exceeds the ${MAX_STORE_JSON_LENGTH} character safety limit`,
    );
  }
  return serialized;
}

/** Reject absolute, backslash-separated, dot-segment, and escaping paths. */
export function assertWorkspaceRelativePath(value: string): void {
  requireWorkspaceRelativePath(value, '$');
}

export function isWorkspaceRelativePath(value: unknown): value is string {
  try {
    requireWorkspaceRelativePath(value, '$');
    return true;
  } catch (error) {
    if (error instanceof NoteStoreValidationError) {
      return false;
    }
    throw error;
  }
}

function validateTextAnchor(value: unknown, location: string): NoteTextAnchor {
  const anchor = requireObject(value, location);
  requireExactKeys(
    anchor,
    [
      'range',
      'quote',
      'quoteLength',
      'quoteTruncated',
      'quoteHash',
      'prefixLength',
      'prefixHash',
      'suffixLength',
      'suffixHash',
    ],
    location,
  );

  const quote = requireString(anchor.quote, `${location}.quote`, MAX_ANCHOR_QUOTE_LENGTH);
  const quoteLength = requireInteger(
    anchor.quoteLength,
    `${location}.quoteLength`,
    0,
    MAX_POSITION_VALUE,
  );
  const quoteTruncated = requireBoolean(anchor.quoteTruncated, `${location}.quoteTruncated`);
  if (
    quoteTruncated &&
    (quote.length !== MAX_ANCHOR_QUOTE_LENGTH || quoteLength <= MAX_ANCHOR_QUOTE_LENGTH)
  ) {
    throw new NoteStoreValidationError(
      `requires a ${MAX_ANCHOR_QUOTE_LENGTH}-character bounded quote and a larger quoteLength`,
      `${location}.quoteTruncated`,
    );
  }
  if (!quoteTruncated && quoteLength !== quote.length) {
    throw new NoteStoreValidationError(
      'must equal the stored quote length when quoteTruncated is false',
      `${location}.quoteLength`,
    );
  }

  const quoteHash = requireHash(anchor.quoteHash, `${location}.quoteHash`);
  if (!quoteTruncated && hashText(quote) !== quoteHash) {
    throw new NoteStoreValidationError('does not match the stored quote', `${location}.quoteHash`);
  }
  const prefixLength = requireInteger(
    anchor.prefixLength,
    `${location}.prefixLength`,
    0,
    MAX_ANCHOR_CONTEXT_LENGTH,
  );
  const prefixHash = requireHash(anchor.prefixHash, `${location}.prefixHash`);
  if (prefixLength === 0 && hashText('') !== prefixHash) {
    throw new NoteStoreValidationError(
      'must hash the empty prefix when prefixLength is zero',
      `${location}.prefixHash`,
    );
  }
  const suffixLength = requireInteger(
    anchor.suffixLength,
    `${location}.suffixLength`,
    0,
    MAX_ANCHOR_CONTEXT_LENGTH,
  );
  const suffixHash = requireHash(anchor.suffixHash, `${location}.suffixHash`);
  if (suffixLength === 0 && hashText('') !== suffixHash) {
    throw new NoteStoreValidationError(
      'must hash the empty suffix when suffixLength is zero',
      `${location}.suffixHash`,
    );
  }

  return {
    range: validateRange(anchor.range, `${location}.range`),
    quote,
    quoteLength,
    quoteTruncated,
    quoteHash,
    prefixLength,
    prefixHash,
    suffixLength,
    suffixHash,
  };
}

function validateSymbolDescriptor(value: unknown, location: string): NoteSymbolDescriptor {
  const symbol = requireObject(value, location);
  requireExactKeys(symbol, ['name', 'kind'], location, ['containerName', 'range']);

  const validated: NoteSymbolDescriptor = {
    name: requireNonBlankString(symbol.name, `${location}.name`, MAX_SHORT_TEXT_LENGTH),
    kind: requireNonBlankString(symbol.kind, `${location}.kind`, MAX_SHORT_TEXT_LENGTH),
  };
  return {
    ...validated,
    ...(symbol.containerName === undefined
      ? {}
      : {
          containerName: requireNonBlankString(
            symbol.containerName,
            `${location}.containerName`,
            MAX_SHORT_TEXT_LENGTH,
          ),
        }),
    ...(symbol.range === undefined
      ? {}
      : { range: validateRange(symbol.range, `${location}.range`) }),
  };
}

function validateResolution(value: unknown, location: string): NoteResolution {
  const resolution = requireObject(value, location);
  if (resolution.state === 'attached') {
    requireExactKeys(resolution, ['state'], location);
    return { state: 'attached' };
  }
  if (resolution.state === 'orphaned') {
    requireExactKeys(resolution, ['state', 'reason'], location);
    if (
      resolution.reason !== 'content-not-found' &&
      resolution.reason !== 'invalid-last-range' &&
      resolution.reason !== 'quote-too-large-to-relocate' &&
      resolution.reason !== 'source-unavailable'
    ) {
      throw new NoteStoreValidationError('unknown orphan reason', `${location}.reason`);
    }
    return { state: 'orphaned', reason: resolution.reason };
  }
  if (resolution.state === 'ambiguous') {
    requireExactKeys(resolution, ['state', 'candidateCount'], location);
    return {
      state: 'ambiguous',
      candidateCount: requireInteger(
        resolution.candidateCount,
        `${location}.candidateCount`,
        2,
        MAX_POSITION_VALUE,
      ),
    };
  }
  throw new NoteStoreValidationError('unknown resolution state', `${location}.state`);
}

function validateRange(value: unknown, location: string): NoteRange {
  const range = requireObject(value, location);
  requireExactKeys(range, ['start', 'end'], location);
  const start = validatePosition(range.start, `${location}.start`);
  const end = validatePosition(range.end, `${location}.end`);
  if (comparePositions(start, end) > 0) {
    throw new NoteStoreValidationError('start must not be after end', location);
  }
  return { start, end };
}

function validatePosition(value: unknown, location: string): NotePosition {
  const position = requireObject(value, location);
  requireExactKeys(position, ['line', 'character'], location);
  return {
    line: requireInteger(position.line, `${location}.line`, 0, MAX_POSITION_VALUE),
    character: requireInteger(position.character, `${location}.character`, 0, MAX_POSITION_VALUE),
  };
}

function requireWorkspaceRelativePath(value: unknown, location: string): string {
  const candidate = requireString(value, location, MAX_PATH_LENGTH);
  if (
    candidate.length === 0 ||
    candidate.includes('\\') ||
    candidate.includes('\0') ||
    candidate.startsWith('/') ||
    candidate.endsWith('/') ||
    /^[A-Za-z]:/.test(candidate)
  ) {
    throw new NoteStoreValidationError(
      'expected a normalized, slash-separated workspace-relative file path',
      location,
    );
  }
  const segments = candidate.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new NoteStoreValidationError('path must not contain empty or dot segments', location);
  }
  return candidate;
}

function requireIsoTimestamp(value: unknown, location: string): string {
  const timestamp = requireString(value, location, 64);
  const date = new Date(timestamp);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) {
    throw new NoteStoreValidationError('expected an ISO-8601 UTC timestamp', location);
  }
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== timestamp) {
    throw new NoteStoreValidationError('expected a valid timestamp', location);
  }
  return timestamp;
}

function requireHash(value: unknown, location: string): string {
  const hash = requireString(value, location, 64);
  if (!SHA_256_PATTERN.test(hash)) {
    throw new NoteStoreValidationError('expected a lowercase SHA-256 hash', location);
  }
  return hash;
}

function requireObject(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NoteStoreValidationError('expected an object', location);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new NoteStoreValidationError('expected a plain object', location);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  location: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new NoteStoreValidationError('unknown property', `${location}.${key}`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new NoteStoreValidationError('missing required property', `${location}.${key}`);
    }
  }
}

function requireString(value: unknown, location: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new NoteStoreValidationError('expected a string', location);
  }
  if (value.length > maxLength) {
    throw new NoteStoreValidationError(`exceeds the ${maxLength} character limit`, location);
  }
  return value;
}

function requireNonBlankString(value: unknown, location: string, maxLength: number): string {
  const text = requireString(value, location, maxLength);
  if (text.trim().length === 0) {
    throw new NoteStoreValidationError('must not be blank', location);
  }
  return text;
}

function requireBoolean(value: unknown, location: string): boolean {
  if (typeof value !== 'boolean') {
    throw new NoteStoreValidationError('expected a boolean', location);
  }
  return value;
}

function requireInteger(
  value: unknown,
  location: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new NoteStoreValidationError(
      `expected an integer from ${minimum} through ${maximum}`,
      location,
    );
  }
  return value as number;
}

function comparePositions(left: NotePosition, right: NotePosition): number {
  return left.line - right.line || left.character - right.character;
}

function compareNotes(left: StoredReviewNote, right: StoredReviewNote): number {
  return (
    compareText(left.relativePath, right.relativePath) ||
    comparePositions(left.anchor.range.start, right.anchor.range.start) ||
    comparePositions(left.anchor.range.end, right.anchor.range.end) ||
    compareText(left.id, right.id)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function toCanonicalNote(note: StoredReviewNote): StoredReviewNote {
  return {
    id: note.id,
    relativePath: note.relativePath,
    anchorKind: note.anchorKind,
    category: note.category,
    status: note.status,
    body: note.body,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    anchor: {
      range: {
        start: {
          line: note.anchor.range.start.line,
          character: note.anchor.range.start.character,
        },
        end: {
          line: note.anchor.range.end.line,
          character: note.anchor.range.end.character,
        },
      },
      quote: note.anchor.quote,
      quoteLength: note.anchor.quoteLength,
      quoteTruncated: note.anchor.quoteTruncated,
      quoteHash: note.anchor.quoteHash,
      prefixLength: note.anchor.prefixLength,
      prefixHash: note.anchor.prefixHash,
      suffixLength: note.anchor.suffixLength,
      suffixHash: note.anchor.suffixHash,
    },
    ...(note.symbol === undefined
      ? {}
      : {
          symbol: {
            name: note.symbol.name,
            kind: note.symbol.kind,
            ...(note.symbol.containerName === undefined
              ? {}
              : { containerName: note.symbol.containerName }),
            ...(note.symbol.range === undefined
              ? {}
              : {
                  range: {
                    start: {
                      line: note.symbol.range.start.line,
                      character: note.symbol.range.start.character,
                    },
                    end: {
                      line: note.symbol.range.end.line,
                      character: note.symbol.range.end.character,
                    },
                  },
                }),
          },
        }),
    resolution: { ...note.resolution },
  };
}
