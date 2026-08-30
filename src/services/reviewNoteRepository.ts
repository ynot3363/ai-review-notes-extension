import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

import {
  assertWorkspaceRelativePath,
  createEmptyReviewNoteStore,
  NOTE_STORE_FILENAME,
  parseReviewNoteStore,
  serializeReviewNoteStore,
  type ReviewNoteStore,
  type StoredReviewNote,
  validateReviewNoteStore,
  validateStoredReviewNote,
} from '../core/noteStore';

export type ReviewNoteStorageMode = 'workspace' | 'private';

export interface ReviewNoteRepositoryOptions {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly mode: ReviewNoteStorageMode;
  /** Workspace-relative path used in workspace mode. */
  readonly sharedFile?: string;
  /** ExtensionContext.storageUri; required in private mode. */
  readonly storageUri?: vscode.Uri;
}

export interface ReviewNoteRepositoryLike {
  readonly storeUri: vscode.Uri;
  load(): Promise<ReviewNoteStore>;
  save(store: ReviewNoteStore): Promise<void>;
  list(): Promise<readonly StoredReviewNote[]>;
  upsert(note: StoredReviewNote): Promise<StoredReviewNote>;
  delete(id: string): Promise<boolean>;
  compareAndSwap(
    expected: StoredReviewNote | undefined,
    replacement: StoredReviewNote | undefined,
  ): Promise<ReviewNoteCompareAndSwapResult>;
  mergeIfUnchanged(
    expectedStore: ReviewNoteStore,
    updates: readonly ConditionalReviewNoteUpdate[],
  ): Promise<ConditionalReviewNoteMergeResult>;
}

export interface ReviewNoteCompareAndSwapResult {
  /** True only when the current UUID state matched expected. */
  readonly applied: boolean;
  readonly wrote: boolean;
  /** Snapshot read immediately before the conditional mutation, with any mutation applied. */
  readonly store: ReviewNoteStore;
  /** Current conflicting value. Omitted when the UUID is absent or the mutation applied. */
  readonly actual?: StoredReviewNote;
}

export interface ConditionalReviewNoteUpdate {
  /** Record observed in expectedStore. */
  readonly before: StoredReviewNote;
  /** Replacement record; its stable UUID must match before.id. */
  readonly after: StoredReviewNote;
}

export interface ConditionalReviewNoteMergeResult {
  /** The current merged snapshot, whether or not a write was needed. */
  readonly store: ReviewNoteStore;
  readonly appliedCount: number;
  readonly skippedCount: number;
  readonly wrote: boolean;
  /** True when the on-disk store changed after expectedStore was read. */
  readonly externalDivergence: boolean;
}

/**
 * Repository for exactly one workspace root. All mutations are serialized, and
 * all filesystem access goes through workspace.fs so remote workspaces work.
 */
export class ReviewNoteRepository implements ReviewNoteRepositoryLike {
  public readonly storeUri: vscode.Uri;
  private readonly storeDirectoryUri: vscode.Uri;
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: ReviewNoteRepositoryOptions) {
    if (options.mode === 'workspace') {
      const sharedFile = options.sharedFile ?? NOTE_STORE_FILENAME;
      this.storeUri = resolveUriWithinRoot(options.workspaceFolder.uri, sharedFile);
      const segments = sharedFile.split('/');
      this.storeDirectoryUri =
        segments.length === 1
          ? options.workspaceFolder.uri
          : resolveUriWithinRoot(options.workspaceFolder.uri, segments.slice(0, -1).join('/'));
    } else {
      if (!options.storageUri) {
        throw new TypeError('storageUri is required for private note storage.');
      }
      const rootKey = createHash('sha256')
        .update(options.workspaceFolder.uri.toString(), 'utf8')
        .digest('hex')
        .slice(0, 24);
      this.storeDirectoryUri = resolveUriWithinRoot(options.storageUri, `roots/${rootKey}`);
      this.storeUri = resolveUriWithinRoot(this.storeDirectoryUri, NOTE_STORE_FILENAME);
    }
  }

  public async load(): Promise<ReviewNoteStore> {
    return this.enqueueMutation(() => this.readDirect());
  }

  public async save(store: ReviewNoteStore): Promise<void> {
    const serialized = serializeReviewNoteStore(store);
    await this.enqueueMutation(() => this.writeDirect(serialized));
  }

  public async list(): Promise<readonly StoredReviewNote[]> {
    const store = await this.load();
    return store.notes;
  }

  public async upsert(note: StoredReviewNote): Promise<StoredReviewNote> {
    const validated = validateStoredReviewNote(note);
    // Validate containment separately from JSON schema validation. This keeps a
    // caller from smuggling an absolute or parent path into future URI use.
    resolveUriWithinRoot(this.options.workspaceFolder.uri, validated.relativePath);

    return this.enqueueMutation(async () => {
      const store = await this.readDirect();
      const notes = store.notes.filter(({ id }) => id !== validated.id);
      const next: ReviewNoteStore = {
        version: store.version,
        notes: [...notes, validated],
      };
      await this.writeDirect(serializeReviewNoteStore(next));
      return validated;
    });
  }

  public async delete(id: string): Promise<boolean> {
    const normalizedId = id.toLowerCase();
    return this.enqueueMutation(async () => {
      const store = await this.readDirect();
      const notes = store.notes.filter((note) => note.id !== normalizedId);
      if (notes.length === store.notes.length) {
        return false;
      }
      await this.writeDirect(serializeReviewNoteStore({ version: store.version, notes }));
      return true;
    });
  }

  /**
   * Atomically compare and mutate one UUID within this repository's serialized
   * operation queue. Undefined expected means "insert only if absent";
   * undefined replacement means "delete only if unchanged". All other notes
   * are taken from the freshly loaded store and therefore remain untouched.
   */
  public async compareAndSwap(
    expected: StoredReviewNote | undefined,
    replacement: StoredReviewNote | undefined,
  ): Promise<ReviewNoteCompareAndSwapResult> {
    if (!expected && !replacement) {
      throw new TypeError('A compare-and-swap mutation requires an expected or replacement note.');
    }
    const validatedExpected = expected ? validateStoredReviewNote(expected, 'expected') : undefined;
    const validatedReplacement = replacement
      ? validateStoredReviewNote(replacement, 'replacement')
      : undefined;
    if (
      validatedExpected &&
      validatedReplacement &&
      validatedExpected.id !== validatedReplacement.id
    ) {
      throw new TypeError('A compare-and-swap mutation cannot change a note UUID.');
    }
    const id = (validatedExpected ?? validatedReplacement)!.id;
    if (validatedReplacement) {
      resolveUriWithinRoot(this.options.workspaceFolder.uri, validatedReplacement.relativePath);
    }

    return this.enqueueMutation(async () => {
      const current = await this.readDirect();
      const index = current.notes.findIndex((note) => note.id === id);
      const actual = index >= 0 ? current.notes[index] : undefined;
      const matchesExpected = validatedExpected
        ? actual !== undefined && notesStructurallyEqual(actual, validatedExpected)
        : actual === undefined;
      if (!matchesExpected) {
        return {
          applied: false,
          wrote: false,
          store: current,
          ...(actual ? { actual } : {}),
        };
      }

      let notes: readonly StoredReviewNote[];
      if (!validatedExpected) {
        notes = [...current.notes, validatedReplacement!];
      } else if (!validatedReplacement) {
        notes = current.notes.filter((_, noteIndex) => noteIndex !== index);
      } else {
        notes = current.notes.map((note, noteIndex) =>
          noteIndex === index ? validatedReplacement : note,
        );
      }
      const wrote =
        !validatedExpected ||
        !validatedReplacement ||
        !notesStructurallyEqual(validatedExpected, validatedReplacement);
      const store: ReviewNoteStore = { version: current.version, notes };
      if (wrote) {
        await this.writeDirect(serializeReviewNoteStore(store));
      }
      return { applied: true, wrote, store };
    });
  }

  /**
   * Conditionally merge a batch derived from an earlier snapshot. The current
   * store is reloaded inside the operation queue immediately before merging, so
   * unrelated external additions/edits survive. A target changed or deleted by
   * an external writer is skipped instead of being resurrected or overwritten.
   */
  public async mergeIfUnchanged(
    expectedStore: ReviewNoteStore,
    updates: readonly ConditionalReviewNoteUpdate[],
  ): Promise<ConditionalReviewNoteMergeResult> {
    const expected = validateReviewNoteStore(expectedStore);
    const expectedById = new Map(expected.notes.map((note) => [note.id, note]));
    const seenIds = new Set<string>();
    const validatedUpdates = updates.map(({ before, after }, index) => {
      const validatedBefore = validateStoredReviewNote(before, `updates[${index}].before`);
      const validatedAfter = validateStoredReviewNote(after, `updates[${index}].after`);
      if (validatedBefore.id !== validatedAfter.id) {
        throw new TypeError(`updates[${index}] cannot change a note UUID.`);
      }
      if (seenIds.has(validatedBefore.id)) {
        throw new TypeError(`updates contains duplicate UUID ${validatedBefore.id}.`);
      }
      seenIds.add(validatedBefore.id);
      const expectedNote = expectedById.get(validatedBefore.id);
      if (!expectedNote || !notesStructurallyEqual(expectedNote, validatedBefore)) {
        throw new TypeError(`updates[${index}].before does not match its record in expectedStore.`);
      }
      resolveUriWithinRoot(this.options.workspaceFolder.uri, validatedAfter.relativePath);
      return { before: validatedBefore, after: validatedAfter };
    });

    return this.enqueueMutation(async () => {
      const current = await this.readDirect();
      const externalDivergence = !storesStructurallyEqual(current, expected);
      const updateById = new Map(validatedUpdates.map((update) => [update.before.id, update]));
      let appliedCount = 0;
      let skippedCount = 0;
      let changed = false;

      const notes = current.notes.map((currentNote) => {
        const update = updateById.get(currentNote.id);
        if (!update) {
          return currentNote;
        }
        updateById.delete(currentNote.id);
        if (!notesStructurallyEqual(currentNote, update.before)) {
          skippedCount += 1;
          return currentNote;
        }
        appliedCount += 1;
        changed ||= !notesStructurallyEqual(currentNote, update.after);
        return update.after;
      });

      // Any remaining targets were deleted after expectedStore was observed.
      skippedCount += updateById.size;
      const store: ReviewNoteStore = { version: current.version, notes };
      if (changed) {
        await this.writeDirect(serializeReviewNoteStore(store));
      }
      return { store, appliedCount, skippedCount, wrote: changed, externalDivergence };
    });
  }

  private async readDirect(): Promise<ReviewNoteStore> {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(this.storeUri);
    } catch (error) {
      if (isFileNotFound(error)) {
        return createEmptyReviewNoteStore();
      }
      throw error;
    }

    let json: string;
    try {
      json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid UTF-8';
      throw new Error(`Unable to decode ${this.storeUri.toString()}: ${message}`);
    }
    return parseReviewNoteStore(json);
  }

  private async writeDirect(serialized: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.storeDirectoryUri);
    const bytes = new TextEncoder().encode(serialized);
    const temporaryUri = resolveUriWithinRoot(
      this.storeDirectoryUri,
      `.${NOTE_STORE_FILENAME}.${randomUUID()}.tmp`,
    );
    try {
      await vscode.workspace.fs.writeFile(temporaryUri, bytes);
    } catch (error) {
      await deleteTemporaryFile(temporaryUri);
      throw error;
    }
    try {
      await vscode.workspace.fs.rename(temporaryUri, this.storeUri, { overwrite: true });
    } catch {
      // Some remote providers do not implement rename. Serialized direct writes
      // are the best provider-neutral fallback; never remove the existing file.
      try {
        await vscode.workspace.fs.writeFile(this.storeUri, bytes);
      } finally {
        await deleteTemporaryFile(temporaryUri);
      }
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Resolve a normalized relative path without permitting absolute paths, dot
 * segments, scheme/authority changes, or traversal outside the URI root.
 */
export function resolveUriWithinRoot(root: vscode.Uri, relativePath: string): vscode.Uri {
  assertWorkspaceRelativePath(relativePath);
  const candidate = vscode.Uri.joinPath(root, ...relativePath.split('/'));
  if (!isUriInside(candidate, root)) {
    throw new RangeError('The resolved path is outside its workspace root.');
  }
  return candidate;
}

function isUriInside(candidate: vscode.Uri, root: vscode.Uri): boolean {
  if (candidate.scheme !== root.scheme || candidate.authority !== root.authority) {
    return false;
  }
  const rootPath =
    root.path.endsWith('/') && root.path !== '/' ? root.path.slice(0, -1) : root.path;
  if (rootPath === '/') {
    return candidate.path.startsWith('/');
  }
  return candidate.path === rootPath || candidate.path.startsWith(`${rootPath}/`);
}

function isFileNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return 'code' in error && error.code === 'FileNotFound';
}

async function deleteTemporaryFile(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
  } catch {
    // Cleanup is best effort. The canonical store has already been written.
  }
}

function notesStructurallyEqual(left: StoredReviewNote, right: StoredReviewNote): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function storesStructurallyEqual(left: ReviewNoteStore, right: ReviewNoteStore): boolean {
  return serializeReviewNoteStore(left) === serializeReviewNoteStore(right);
}
