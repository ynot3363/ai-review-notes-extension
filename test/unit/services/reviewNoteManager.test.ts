import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({
  workspaceFolders: [] as Array<{ uri: unknown; name: string; index: number }>,
  documents: new Map<string, unknown>(),
}));

vi.mock('vscode', () => {
  class Disposable {
    public constructor(private readonly callback: () => void = () => undefined) {}

    public dispose(): void {
      this.callback();
    }
  }

  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => unknown>();
    public readonly event = (listener: (value: T) => unknown): Disposable => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };

    public fire(value: T): void {
      for (const listener of this.listeners) {
        listener(value);
      }
    }

    public dispose(): void {
      this.listeners.clear();
    }
  }

  class Uri {
    public constructor(
      public readonly scheme: string,
      public readonly authority: string,
      public readonly path: string,
    ) {}

    public static parse(value: string): Uri {
      const parsed = /^([\w+.-]+):\/\/([^/]*)(\/.*)$/u.exec(value);
      if (!parsed) {
        throw new Error(`Unsupported test URI: ${value}`);
      }
      return new Uri(parsed[1]!, parsed[2]!, parsed[3]!);
    }

    public static joinPath(base: Uri, ...parts: string[]): Uri {
      const segments = base.path.split('/').filter(Boolean);
      for (const part of parts) {
        for (const segment of part.split('/')) {
          if (!segment || segment === '.') {
            continue;
          }
          if (segment === '..') {
            segments.pop();
          } else {
            segments.push(segment);
          }
        }
      }
      return new Uri(base.scheme, base.authority, `/${segments.join('/')}`);
    }

    public get fsPath(): string {
      return this.path;
    }

    public toString(): string {
      return `${this.scheme}://${this.authority}${this.path}`;
    }
  }

  class Position {
    public constructor(
      public readonly line: number,
      public readonly character: number,
    ) {}
  }

  class Range {
    public readonly start: Position;
    public readonly end: Position;

    public constructor(
      startOrLine: Position | number,
      startCharacterOrEnd: Position | number,
      endLine?: number,
      endCharacter?: number,
    ) {
      if (typeof startOrLine === 'number') {
        this.start = new Position(startOrLine, startCharacterOrEnd as number);
        this.end = new Position(endLine!, endCharacter!);
      } else {
        this.start = startOrLine;
        this.end = startCharacterOrEnd as Position;
      }
    }

    public get isEmpty(): boolean {
      return this.start.line === this.end.line && this.start.character === this.end.character;
    }

    public contains(other: Range): boolean {
      return (
        comparePosition(this.start, other.start) <= 0 && comparePosition(this.end, other.end) >= 0
      );
    }
  }

  function comparePosition(left: Position, right: Position): number {
    return left.line - right.line || left.character - right.character;
  }

  function containingFolder(uri: Uri): (typeof vscodeState.workspaceFolders)[number] | undefined {
    return [...vscodeState.workspaceFolders]
      .filter(({ uri: candidate }) => {
        const root = candidate as Uri;
        return (
          root.scheme === uri.scheme &&
          root.authority === uri.authority &&
          (root.path === uri.path || uri.path.startsWith(`${root.path.replace(/\/$/u, '')}/`))
        );
      })
      .sort((left, right) => (right.uri as Uri).path.length - (left.uri as Uri).path.length)[0];
  }

  return {
    Disposable,
    EventEmitter,
    Position,
    Range,
    Uri,
    SymbolKind: {},
    commands: {
      executeCommand: vi.fn(async () => undefined),
    },
    workspace: {
      get workspaceFolders() {
        return vscodeState.workspaceFolders;
      },
      getConfiguration: vi.fn(() => ({
        get: vi.fn((_key: string, fallback: unknown) => fallback),
      })),
      getWorkspaceFolder: vi.fn((uri: Uri) => containingFolder(uri)),
      openTextDocument: vi.fn(async (uri: Uri) => {
        const document = vscodeState.documents.get(uri.toString());
        if (!document) {
          throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
        }
        return document;
      }),
    },
  };
});

import * as vscode from 'vscode';

import { createTextAnchor, type ReviewNoteStore, type StoredReviewNote } from '../../../src/core';
import {
  ReviewNoteConflictError,
  ReviewNoteManager,
  type ReviewNoteRepositoryFactory,
} from '../../../src/services/reviewNoteManager';
import type {
  ConditionalReviewNoteMergeResult,
  ConditionalReviewNoteUpdate,
  ReviewNoteCompareAndSwapResult,
  ReviewNoteRepositoryLike,
  ReviewNoteRepositoryOptions,
} from '../../../src/services/reviewNoteRepository';

const originalSource = 'const value = risky();\n';
const originalId = '64f8d415-c742-4a4d-9140-73fda994f3e8';

class MemoryReviewNoteRepository implements ReviewNoteRepositoryLike {
  public readonly compareAndSwapCalls: Array<{
    readonly expected: StoredReviewNote | undefined;
    readonly replacement: StoredReviewNote | undefined;
  }> = [];
  public readonly upsert = vi.fn(async (note: StoredReviewNote): Promise<StoredReviewNote> => {
    this.store = {
      version: this.store.version,
      notes: [...this.store.notes.filter(({ id }) => id !== note.id), note],
    };
    return note;
  });

  public constructor(
    public readonly storeUri: vscode.Uri,
    public store: ReviewNoteStore,
  ) {}

  public async load(): Promise<ReviewNoteStore> {
    return cloneStore(this.store);
  }

  public async save(store: ReviewNoteStore): Promise<void> {
    this.store = cloneStore(store);
  }

  public async list(): Promise<readonly StoredReviewNote[]> {
    return (await this.load()).notes;
  }

  public async delete(id: string): Promise<boolean> {
    const notes = this.store.notes.filter((note) => note.id !== id.toLowerCase());
    const deleted = notes.length !== this.store.notes.length;
    this.store = { version: this.store.version, notes };
    return deleted;
  }

  public async compareAndSwap(
    expected: StoredReviewNote | undefined,
    replacement: StoredReviewNote | undefined,
  ): Promise<ReviewNoteCompareAndSwapResult> {
    this.compareAndSwapCalls.push({ expected, replacement });
    const id = (expected ?? replacement)!.id;
    const index = this.store.notes.findIndex((note) => note.id === id);
    const actual = index >= 0 ? this.store.notes[index] : undefined;
    const matches = expected ? actual !== undefined && noteEquals(actual, expected) : !actual;
    if (!matches) {
      return {
        applied: false,
        wrote: false,
        store: cloneStore(this.store),
        ...(actual ? { actual: structuredClone(actual) } : {}),
      };
    }

    const notes = expected
      ? replacement
        ? this.store.notes.map((note, noteIndex) =>
            noteIndex === index ? structuredClone(replacement) : note,
          )
        : this.store.notes.filter((_, noteIndex) => noteIndex !== index)
      : [...this.store.notes, structuredClone(replacement!)];
    const wrote = !expected || !replacement || !noteEquals(expected, replacement);
    this.store = { version: this.store.version, notes };
    return { applied: true, wrote, store: cloneStore(this.store) };
  }

  public async mergeIfUnchanged(
    _expectedStore: ReviewNoteStore,
    updates: readonly ConditionalReviewNoteUpdate[],
  ): Promise<ConditionalReviewNoteMergeResult> {
    let appliedCount = 0;
    let skippedCount = 0;
    let wrote = false;
    for (const update of updates) {
      const result = await this.compareAndSwap(update.before, update.after);
      if (result.applied) {
        appliedCount += 1;
        wrote ||= result.wrote;
      } else {
        skippedCount += 1;
      }
    }
    return {
      store: cloneStore(this.store),
      appliedCount,
      skippedCount,
      wrote,
      externalDivergence: skippedCount > 0,
    };
  }
}

interface ManagerFixture {
  readonly manager: ReviewNoteManager;
  readonly output: { appendLine: ReturnType<typeof vi.fn> };
  readonly repositories: ReadonlyMap<string, MemoryReviewNoteRepository>;
}

describe('ReviewNoteManager conditional mutations', () => {
  beforeEach(() => {
    vscodeState.workspaceFolders.splice(0);
    vscodeState.documents.clear();
  });

  it('does not overwrite an externally inserted UUID during creation', async () => {
    const root = workspace('one');
    const fixture = await createManagerFixture([root]);
    const repository = repositoryFor(fixture, 'one');
    const external = storedNote('2596f84e-5d28-43b4-8962-1e3b9f4bf623', 'src/external.ts');
    documentAt(root, external.relativePath);
    repository.store = { version: 1, notes: [...repository.store.notes, external] };

    await expect(
      fixture.manager.createNote({
        document: documentAt(root, 'src/new.ts'),
        range: new vscode.Range(0, 6, 0, 11),
        body: 'Do not replace the external record.',
        category: 'Code Review',
        status: 'open',
        id: external.id,
      }),
    ).rejects.toBeInstanceOf(ReviewNoteConflictError);

    expect(repository.store.notes).toContainEqual(external);
    expect(fixture.manager.getEntry(external.id)?.note).toEqual(external);
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it('reloads and rejects updateBody when the same stored note changed externally', async () => {
    const root = workspace('one');
    const fixture = await createManagerFixture([root]);
    const repository = repositoryFor(fixture, 'one');
    const externalEdit = externallyEditBody(repository.store.notes[0]!);
    const addition = storedNote('2596f84e-5d28-43b4-8962-1e3b9f4bf623', 'src/added.ts');
    documentAt(root, addition.relativePath);
    repository.store = { version: 1, notes: [externalEdit, addition] };

    await expect(fixture.manager.updateBody(originalId, 'My stale edit.')).rejects.toBeInstanceOf(
      ReviewNoteConflictError,
    );

    expect(repository.store.notes).toEqual([externalEdit, addition]);
    expect(fixture.manager.getEntry(originalId)?.note.body).toBe(externalEdit.body);
    expect(repository.upsert).not.toHaveBeenCalled();
  });

  it('trims and persists an ad-hoc category without changing the note ID', async () => {
    const fixture = await createManagerFixture([workspace('one')]);
    const repository = repositoryFor(fixture, 'one');

    const updated = await fixture.manager.updateCategory(originalId, '  Architecture  ');

    expect(updated).toMatchObject({ id: originalId, category: 'Architecture' });
    expect(repository.store.notes).toContainEqual(
      expect.objectContaining({ id: originalId, category: 'Architecture' }),
    );
    expect(repository.compareAndSwapCalls[repository.compareAndSwapCalls.length - 1]).toMatchObject(
      {
        expected: { id: originalId, category: 'Code Review' },
        replacement: { id: originalId, category: 'Architecture' },
      },
    );
  });

  it('rejects invalid categories before writing the note store', async () => {
    const fixture = await createManagerFixture([workspace('one')]);
    const repository = repositoryFor(fixture, 'one');
    const callsBefore = repository.compareAndSwapCalls.length;

    await expect(fixture.manager.updateCategory(originalId, '   ')).rejects.toThrow(
      /must contain text/u,
    );
    await expect(fixture.manager.updateCategory(originalId, 'x'.repeat(1_025))).rejects.toThrow(
      /cannot exceed 1024/u,
    );

    expect(repository.compareAndSwapCalls).toHaveLength(callsBefore);
    expect(repository.store.notes[0]?.category).toBe('Code Review');
  });

  it('reloads and rejects a category change when the same note changed externally', async () => {
    const fixture = await createManagerFixture([workspace('one')]);
    const repository = repositoryFor(fixture, 'one');
    const externalEdit = externallyEditBody(repository.store.notes[0]!);
    repository.store = { version: 1, notes: [externalEdit] };

    await expect(
      fixture.manager.updateCategory(originalId, 'Documentation'),
    ).rejects.toBeInstanceOf(ReviewNoteConflictError);

    expect(repository.store.notes).toEqual([externalEdit]);
    expect(fixture.manager.getEntry(originalId)?.note).toEqual(externalEdit);
  });

  it('reloads and rejects resolve when the same stored note changed externally', async () => {
    const fixture = await createManagerFixture([workspace('one')]);
    const repository = repositoryFor(fixture, 'one');
    const externalEdit = externallyEditBody(repository.store.notes[0]!);
    repository.store = { version: 1, notes: [externalEdit] };

    await expect(fixture.manager.resolveNote(originalId)).rejects.toThrow(
      /latest version was reloaded/u,
    );

    expect(repository.store.notes).toEqual([externalEdit]);
    expect(fixture.manager.getEntry(originalId)?.note).toEqual(externalEdit);
  });

  it('reopens a resolved note and updates only its status timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T13:00:00.000Z'));
    try {
      const root = workspace('one');
      const resolved = { ...storedNote(originalId, 'src/example.ts'), status: 'resolved' };
      const fixture = await createManagerFixture([root], { one: [resolved] });
      const repository = repositoryFor(fixture, 'one');

      const reopened = await fixture.manager.reopenNote(originalId);

      expect(reopened).toMatchObject({ id: originalId, status: 'open' });
      expect(repository.store.notes).toContainEqual({
        ...resolved,
        status: 'open',
        updatedAt: '2026-08-30T13:00:00.000Z',
      });
      expect(repository.compareAndSwapCalls.at(-1)).toEqual({
        expected: resolved,
        replacement: {
          ...resolved,
          status: 'open',
          updatedAt: '2026-08-30T13:00:00.000Z',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reloads and rejects reopen when the same stored note changed externally', async () => {
    const root = workspace('one');
    const resolved = { ...storedNote(originalId, 'src/example.ts'), status: 'resolved' };
    const fixture = await createManagerFixture([root], { one: [resolved] });
    const repository = repositoryFor(fixture, 'one');
    const externalEdit = externallyEditBody(resolved);
    repository.store = { version: 1, notes: [externalEdit] };

    await expect(fixture.manager.reopenNote(originalId)).rejects.toBeInstanceOf(
      ReviewNoteConflictError,
    );

    expect(repository.store.notes).toEqual([externalEdit]);
    expect(fixture.manager.getEntry(originalId)?.note).toEqual(externalEdit);
  });

  it('does not delete a same-UUID record that changed externally', async () => {
    const fixture = await createManagerFixture([workspace('one')]);
    const repository = repositoryFor(fixture, 'one');
    const externalEdit = externallyEditBody(repository.store.notes[0]!);
    repository.store = { version: 1, notes: [externalEdit] };

    await expect(fixture.manager.deleteNote(originalId)).rejects.toBeInstanceOf(
      ReviewNoteConflictError,
    );

    expect(repository.store.notes).toEqual([externalEdit]);
    expect(fixture.manager.getEntry(originalId)?.note).toEqual(externalEdit);
  });

  it('moves an attached note to a new file and range without changing its content', async () => {
    const root = workspace('one');
    const fixture = await createManagerFixture([root]);
    const repository = repositoryFor(fixture, 'one');
    const targetDocument = documentAt(root, 'src/new-target.ts');

    const moved = await fixture.manager.moveNote(
      originalId,
      targetDocument,
      new vscode.Range(0, 14, 0, 19),
    );

    expect(moved).toMatchObject({
      id: originalId,
      relativePath: 'src/new-target.ts',
      startLine: 1,
      endLine: 1,
      comment: 'Please handle the failure path.',
      category: 'Code Review',
      status: 'open',
      anchorState: 'attached',
    });
    expect(repository.store.notes).toContainEqual(
      expect.objectContaining({
        id: originalId,
        relativePath: 'src/new-target.ts',
        anchorKind: 'range',
        body: 'Please handle the failure path.',
        category: 'Code Review',
        status: 'open',
        resolution: { state: 'attached' },
        anchor: expect.objectContaining({
          range: {
            start: { line: 0, character: 14 },
            end: { line: 0, character: 19 },
          },
        }),
      }),
    );
  });

  it('does not reattach a same-UUID record that changed externally', async () => {
    const root = workspace('one');
    const fixture = await createManagerFixture([root]);
    const repository = repositoryFor(fixture, 'one');
    const externalEdit = externallyEditBody(repository.store.notes[0]!);
    repository.store = { version: 1, notes: [externalEdit] };
    const document = documentAt(root, 'src/example.ts');

    await expect(
      fixture.manager.moveNote(originalId, document, new vscode.Range(0, 6, 0, 11)),
    ).rejects.toBeInstanceOf(ReviewNoteConflictError);

    expect(repository.store.notes).toEqual([externalEdit]);
    expect(fixture.manager.getEntry(originalId)?.note).toEqual(externalEdit);
  });

  it('rolls back a cross-root reattach when the source changed externally', async () => {
    const sourceRoot = workspace('source', 0);
    const targetRoot = workspace('target', 1);
    const targetAddition = storedNote('2596f84e-5d28-43b4-8962-1e3b9f4bf623', 'src/target-only.ts');
    const fixture = await createManagerFixture([sourceRoot, targetRoot], {
      target: [targetAddition],
    });
    const sourceRepository = repositoryFor(fixture, 'source');
    const targetRepository = repositoryFor(fixture, 'target');
    const externalEdit = externallyEditBody(sourceRepository.store.notes[0]!);
    sourceRepository.store = { version: 1, notes: [externalEdit] };
    const targetDocument = documentAt(targetRoot, 'src/new-target.ts');

    await expect(
      fixture.manager.moveNote(originalId, targetDocument, new vscode.Range(0, 6, 0, 11)),
    ).rejects.toBeInstanceOf(ReviewNoteConflictError);

    expect(sourceRepository.store.notes).toEqual([externalEdit]);
    expect(targetRepository.store.notes).toEqual([targetAddition]);
    expect(targetRepository.compareAndSwapCalls).toHaveLength(2);
    expect(targetRepository.compareAndSwapCalls[0]?.expected).toBeUndefined();
    expect(targetRepository.compareAndSwapCalls[1]?.replacement).toBeUndefined();
  });

  it('continues a rename batch after one same-note conflict', async () => {
    const root = workspace('one');
    const first = storedNote(originalId, 'src/one.ts');
    const second = storedNote('2596f84e-5d28-43b4-8962-1e3b9f4bf623', 'src/two.ts');
    const fixture = await createManagerFixture([root], { one: [first, second] });
    const repository = repositoryFor(fixture, 'one');
    const externalFirst = externallyEditBody(first);
    repository.store = { version: 1, notes: [externalFirst, second] };
    documentAt(root, 'lib/two.ts');

    await invokeRename(
      fixture.manager,
      vscode.Uri.joinPath(root.uri, 'src'),
      vscode.Uri.joinPath(root.uri, 'lib'),
    );

    expect(repository.store.notes).toEqual([
      externalFirst,
      expect.objectContaining({ id: second.id, relativePath: 'lib/two.ts' }),
    ]);
    expect(fixture.manager.getEntry(first.id)?.note).toEqual(externalFirst);
    expect(fixture.manager.getEntry(second.id)?.note.relativePath).toBe('lib/two.ts');
    expect(fixture.output.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('1 note rename update skipped'),
    );
  });
});

async function createManagerFixture(
  roots: readonly vscode.WorkspaceFolder[],
  initialByName: Readonly<Record<string, readonly StoredReviewNote[]>> = {},
): Promise<ManagerFixture> {
  vscodeState.workspaceFolders.push(...roots);
  const repositories = new Map<string, MemoryReviewNoteRepository>();
  for (const root of roots) {
    const notes =
      initialByName[root.name] ??
      (root === roots[0] ? [storedNote(originalId, 'src/example.ts')] : []);
    const repository = new MemoryReviewNoteRepository(
      vscode.Uri.joinPath(root.uri, 'CODING_NOTES_FOR_AI.json'),
      { version: 1, notes: structuredClone(notes) },
    );
    repositories.set(root.uri.toString(), repository);
    for (const note of notes) {
      documentAt(root, note.relativePath);
    }
  }
  const factory: ReviewNoteRepositoryFactory = (options: ReviewNoteRepositoryOptions) => {
    const repository = repositories.get(options.workspaceFolder.uri.toString());
    if (!repository) {
      throw new Error(`Missing repository for ${options.workspaceFolder.uri.toString()}`);
    }
    return repository;
  };
  const output = { appendLine: vi.fn() };
  const manager = new ReviewNoteManager(
    {} as vscode.ExtensionContext,
    output as unknown as vscode.OutputChannel,
    factory,
  );
  await manager.refresh();
  return { manager, output, repositories };
}

function workspace(name: string, index = 0): vscode.WorkspaceFolder {
  return {
    uri: vscode.Uri.parse(`vscode-remote://test/${name}`),
    name,
    index,
  };
}

function documentAt(root: vscode.WorkspaceFolder, relativePath: string): vscode.TextDocument {
  const uri = vscode.Uri.joinPath(root.uri, ...relativePath.split('/'));
  const lines = originalSource.split('\n');
  const document = {
    uri,
    isClosed: false,
    isUntitled: false,
    isDirty: false,
    lineCount: lines.length,
    getText: () => originalSource,
    validateRange: (range: vscode.Range) => range,
    lineAt: (line: number) => ({
      text: lines[line] ?? '',
      range: new vscode.Range(line, 0, line, (lines[line] ?? '').length),
    }),
  } as unknown as vscode.TextDocument;
  vscodeState.documents.set(uri.toString(), document);
  return document;
}

function storedNote(id: string, relativePath: string): StoredReviewNote {
  return {
    id,
    relativePath,
    anchorKind: 'range',
    category: 'Code Review',
    status: 'open',
    body: 'Please handle the failure path.',
    createdAt: '2026-08-30T12:00:00.000Z',
    updatedAt: '2026-08-30T12:01:00.000Z',
    anchor: createTextAnchor(originalSource, {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 11 },
    }),
    resolution: { state: 'attached' },
  };
}

function externallyEditBody(note: StoredReviewNote): StoredReviewNote {
  return {
    ...note,
    body: 'Body changed outside this extension.',
    updatedAt: '2026-08-30T12:02:00.000Z',
  };
}

function repositoryFor(fixture: ManagerFixture, rootName: string): MemoryReviewNoteRepository {
  const root = vscodeState.workspaceFolders.find(({ name }) => name === rootName)!;
  return fixture.repositories.get((root.uri as vscode.Uri).toString())!;
}

function cloneStore(store: ReviewNoteStore): ReviewNoteStore {
  return structuredClone(store);
}

function noteEquals(left: StoredReviewNote, right: StoredReviewNote): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function invokeRename(
  manager: ReviewNoteManager,
  oldUri: vscode.Uri,
  newUri: vscode.Uri,
): Promise<void> {
  const internal = manager as unknown as {
    handleRenames(
      renames: readonly { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }[],
    ): Promise<void>;
  };
  await internal.handleRenames([{ oldUri, newUri }]);
}
