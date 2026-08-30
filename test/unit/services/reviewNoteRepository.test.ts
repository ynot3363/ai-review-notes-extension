import { beforeEach, describe, expect, it, vi } from 'vitest';

const fileSystemState = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  renameUnsupported: false,
  directories: [] as string[],
  writes: [] as string[],
  deletes: [] as string[],
}));

vi.mock('vscode', () => {
  class Uri {
    public constructor(
      public readonly scheme: string,
      public readonly authority: string,
      public readonly path: string,
    ) {}

    public static parse(value: string): Uri {
      const parsed = /^([\w+.-]+):\/\/([^/]*)(\/.*)$/.exec(value);
      if (!parsed) {
        throw new Error(`Unsupported test URI: ${value}`);
      }
      return new Uri(parsed[1]!, parsed[2]!, parsed[3]!);
    }

    public static joinPath(base: Uri, ...parts: string[]): Uri {
      const segments = base.path.split('/').filter(Boolean);
      for (const part of parts) {
        for (const segment of part.split('/')) {
          if (segment === '' || segment === '.') {
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

    public toString(): string {
      return `${this.scheme}://${this.authority}${this.path}`;
    }
  }

  const key = (uri: Uri): string => uri.toString();
  return {
    Uri,
    workspace: {
      fs: {
        readFile: vi.fn(async (uri: Uri): Promise<Uint8Array> => {
          const bytes = fileSystemState.files.get(key(uri));
          if (!bytes) {
            throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
          }
          return bytes;
        }),
        createDirectory: vi.fn(async (uri: Uri): Promise<void> => {
          fileSystemState.directories.push(key(uri));
        }),
        writeFile: vi.fn(async (uri: Uri, bytes: Uint8Array): Promise<void> => {
          fileSystemState.writes.push(key(uri));
          fileSystemState.files.set(key(uri), Uint8Array.from(bytes));
        }),
        rename: vi.fn(
          async (oldUri: Uri, newUri: Uri, _options: { overwrite: boolean }): Promise<void> => {
            if (fileSystemState.renameUnsupported) {
              throw Object.assign(new Error('rename unsupported'), { code: 'Unavailable' });
            }
            const bytes = fileSystemState.files.get(key(oldUri));
            if (!bytes) {
              throw Object.assign(new Error('missing source'), { code: 'FileNotFound' });
            }
            fileSystemState.files.set(key(newUri), bytes);
            fileSystemState.files.delete(key(oldUri));
          },
        ),
        delete: vi.fn(async (uri: Uri): Promise<void> => {
          fileSystemState.deletes.push(key(uri));
          fileSystemState.files.delete(key(uri));
        }),
      },
    },
  };
});

import * as vscode from 'vscode';

import { createTextAnchor } from '../../../src/core/noteAnchors';
import { serializeReviewNoteStore, type StoredReviewNote } from '../../../src/core/noteStore';
import {
  resolveUriWithinRoot,
  ReviewNoteRepository,
} from '../../../src/services/reviewNoteRepository';

const workspaceUri = vscode.Uri.parse('vscode-remote://ssh-remote+host/project');
const storageUri = vscode.Uri.parse('vscode-userdata://local/extension-storage');
const workspaceFolder: vscode.WorkspaceFolder = {
  uri: workspaceUri,
  name: 'project',
  index: 0,
};

function note(
  id = '64f8d415-c742-4a4d-9140-73fda994f3e8',
  relativePath = 'src/example.ts',
): StoredReviewNote {
  return {
    id,
    relativePath,
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
  };
}

function fileText(uri: vscode.Uri): string | undefined {
  const bytes = fileSystemState.files.get(uri.toString());
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

describe('ReviewNoteRepository', () => {
  beforeEach(() => {
    fileSystemState.files.clear();
    fileSystemState.renameUnsupported = false;
    fileSystemState.directories = [];
    fileSystemState.writes = [];
    fileSystemState.deletes = [];
  });

  it('uses one default shared sidecar at the remote workspace root', () => {
    const repository = new ReviewNoteRepository({
      workspaceFolder,
      mode: 'workspace',
    });

    expect(repository.storeUri.toString()).toBe(
      'vscode-remote://ssh-remote+host/project/CODING_NOTES_FOR_AI.json',
    );
  });

  it('resolves a custom shared file and creates only its containing directory', async () => {
    const repository = new ReviewNoteRepository({
      workspaceFolder,
      mode: 'workspace',
      sharedFile: '.reviews/team/notes.json',
    });

    expect(repository.storeUri.toString()).toBe(
      'vscode-remote://ssh-remote+host/project/.reviews/team/notes.json',
    );
    await repository.save({ version: 1, notes: [] });
    expect(fileSystemState.directories).toContain(
      'vscode-remote://ssh-remote+host/project/.reviews/team',
    );
  });

  it.each(['/absolute.json', '../escape.json', 'folder/../../escape.json', 'C:/escape.json'])(
    'rejects unsafe configured paths: %s',
    (sharedFile) => {
      expect(
        () => new ReviewNoteRepository({ workspaceFolder, mode: 'workspace', sharedFile }),
      ).toThrow();
    },
  );

  it('keeps private stores inside storageUri and separates workspace roots', () => {
    const first = new ReviewNoteRepository({
      workspaceFolder,
      mode: 'private',
      storageUri,
    });
    const second = new ReviewNoteRepository({
      workspaceFolder: {
        uri: vscode.Uri.parse('vscode-remote://ssh-remote+host/other'),
        name: 'other',
        index: 1,
      },
      mode: 'private',
      storageUri,
    });

    expect(first.storeUri.toString()).toMatch(
      /^vscode-userdata:\/\/local\/extension-storage\/roots\/[\da-f]{24}\/CODING_NOTES_FOR_AI\.json$/,
    );
    expect(second.storeUri.toString()).not.toBe(first.storeUri.toString());
    expect(() => new ReviewNoteRepository({ workspaceFolder, mode: 'private' })).toThrow(
      /storageUri is required/,
    );
  });

  it('loads an empty store when the sidecar does not exist', async () => {
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });

    await expect(repository.load()).resolves.toEqual({ version: 1, notes: [] });
  });

  it('writes through a unique sibling and atomically renames it', async () => {
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });
    await repository.save({ version: 1, notes: [note()] });

    expect(fileText(repository.storeUri)).toBe(
      serializeReviewNoteStore({ version: 1, notes: [note()] }),
    );
    expect(fileSystemState.writes).toHaveLength(1);
    expect(fileSystemState.writes[0]).toMatch(/\.CODING_NOTES_FOR_AI\.json\..+\.tmp$/);
    expect([...fileSystemState.files.keys()].some((key) => key.endsWith('.tmp'))).toBe(false);
  });

  it('falls back to a serialized direct write when rename is unsupported', async () => {
    fileSystemState.renameUnsupported = true;
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });
    await repository.save({ version: 1, notes: [note()] });

    expect(fileText(repository.storeUri)).toContain('Please handle the failure path.');
    expect(fileSystemState.writes).toHaveLength(2);
    expect(fileSystemState.deletes).toHaveLength(1);
  });

  it('serializes concurrent upserts so neither update is lost', async () => {
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });
    const second = note('2596f84e-5d28-43b4-8962-1e3b9f4bf623', 'src/other.ts');

    await Promise.all([repository.upsert(note()), repository.upsert(second)]);

    await expect(repository.list()).resolves.toEqual([note(), second]);
  });

  it('conditionally merges a target update while preserving an external addition', async () => {
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });
    const original = note();
    await repository.save({ version: 1, notes: [original] });
    const expected = await repository.load();
    const externalAddition = note(
      '2596f84e-5d28-43b4-8962-1e3b9f4bf623',
      'src/externally-added.ts',
    );
    fileSystemState.files.set(
      repository.storeUri.toString(),
      new TextEncoder().encode(
        serializeReviewNoteStore({ version: 1, notes: [original, externalAddition] }),
      ),
    );
    const after: StoredReviewNote = {
      ...original,
      resolution: { state: 'orphaned', reason: 'content-not-found' },
    };

    const result = await repository.mergeIfUnchanged(expected, [{ before: original, after }]);

    expect(result).toMatchObject({
      appliedCount: 1,
      skippedCount: 0,
      wrote: true,
      externalDivergence: true,
    });
    expect(result.store.notes).toEqual([after, externalAddition]);
    await expect(repository.list()).resolves.toEqual([after, externalAddition]);
  });

  it('skips a target that an external writer edited instead of overwriting its body', async () => {
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });
    const original = note();
    await repository.save({ version: 1, notes: [original] });
    const expected = await repository.load();
    const externalEdit: StoredReviewNote = {
      ...original,
      body: 'Body changed outside this extension.',
      updatedAt: '2026-08-30T12:02:00.000Z',
    };
    fileSystemState.files.set(
      repository.storeUri.toString(),
      new TextEncoder().encode(serializeReviewNoteStore({ version: 1, notes: [externalEdit] })),
    );
    const writesBeforeMerge = fileSystemState.writes.length;
    const after: StoredReviewNote = {
      ...original,
      resolution: { state: 'orphaned', reason: 'content-not-found' },
    };

    const result = await repository.mergeIfUnchanged(expected, [{ before: original, after }]);

    expect(result).toMatchObject({
      appliedCount: 0,
      skippedCount: 1,
      wrote: false,
      externalDivergence: true,
    });
    expect(result.store.notes).toEqual([externalEdit]);
    expect(fileSystemState.writes).toHaveLength(writesBeforeMerge);
    await expect(repository.list()).resolves.toEqual([externalEdit]);
  });

  it('compare-and-swaps one target while preserving unrelated external changes', async () => {
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });
    const original = note();
    const other = note('2596f84e-5d28-43b4-8962-1e3b9f4bf623', 'src/other.ts');
    await repository.save({ version: 1, notes: [original, other] });
    const externallyEditedOther: StoredReviewNote = {
      ...other,
      body: 'Unrelated body changed outside this extension.',
      updatedAt: '2026-08-30T12:02:00.000Z',
    };
    const externalAddition = note(
      '397b34ce-3acf-45a8-8d21-05a9ea6267ed',
      'src/externally-added.ts',
    );
    fileSystemState.files.set(
      repository.storeUri.toString(),
      new TextEncoder().encode(
        serializeReviewNoteStore({
          version: 1,
          notes: [original, externallyEditedOther, externalAddition],
        }),
      ),
    );
    const replacement: StoredReviewNote = {
      ...original,
      status: 'resolved',
      updatedAt: '2026-08-30T12:03:00.000Z',
    };

    const result = await repository.compareAndSwap(original, replacement);

    expect(result).toMatchObject({ applied: true, wrote: true });
    expect(result.store.notes).toEqual([replacement, externalAddition, externallyEditedOther]);
    await expect(repository.list()).resolves.toEqual([
      replacement,
      externalAddition,
      externallyEditedOther,
    ]);
  });

  it('compare-and-swap rejects an externally edited target without writing', async () => {
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });
    const original = note();
    await repository.save({ version: 1, notes: [original] });
    const externalEdit: StoredReviewNote = {
      ...original,
      body: 'Body changed outside this extension.',
      updatedAt: '2026-08-30T12:02:00.000Z',
    };
    fileSystemState.files.set(
      repository.storeUri.toString(),
      new TextEncoder().encode(serializeReviewNoteStore({ version: 1, notes: [externalEdit] })),
    );
    const writesBeforeSwap = fileSystemState.writes.length;

    const result = await repository.compareAndSwap(original, {
      ...original,
      status: 'resolved',
    });

    expect(result).toMatchObject({
      applied: false,
      wrote: false,
      actual: externalEdit,
      store: { version: 1, notes: [externalEdit] },
    });
    expect(fileSystemState.writes).toHaveLength(writesBeforeSwap);
    await expect(repository.list()).resolves.toEqual([externalEdit]);
  });

  it('compare-and-swap does not resurrect a target deleted externally', async () => {
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });
    const original = note();
    await repository.save({ version: 1, notes: [original] });
    fileSystemState.files.set(
      repository.storeUri.toString(),
      new TextEncoder().encode(serializeReviewNoteStore({ version: 1, notes: [] })),
    );
    const writesBeforeSwap = fileSystemState.writes.length;

    const result = await repository.compareAndSwap(original, {
      ...original,
      status: 'resolved',
    });

    expect(result).toMatchObject({ applied: false, wrote: false, store: { notes: [] } });
    expect(result).not.toHaveProperty('actual');
    expect(fileSystemState.writes).toHaveLength(writesBeforeSwap);
    await expect(repository.list()).resolves.toEqual([]);
  });

  it('supports insert-if-absent and delete-if-unchanged for cross-store moves', async () => {
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });
    const original = note();
    await repository.save({ version: 1, notes: [original] });

    const collision = await repository.compareAndSwap(undefined, {
      ...original,
      relativePath: 'src/collision.ts',
    });
    expect(collision).toMatchObject({ applied: false, wrote: false, actual: original });

    const removed = await repository.compareAndSwap(original, undefined);
    expect(removed).toMatchObject({ applied: true, wrote: true });
    expect(removed.store.notes).toEqual([]);

    const inserted = await repository.compareAndSwap(undefined, original);
    expect(inserted).toMatchObject({ applied: true, wrote: true });
    expect(inserted.store.notes).toEqual([original]);
  });

  it('allows only one concurrent compare-and-swap from the same snapshot', async () => {
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });
    const original = note();
    await repository.save({ version: 1, notes: [original] });

    const results = await Promise.all([
      repository.compareAndSwap(original, { ...original, status: 'resolved' }),
      repository.compareAndSwap(original, { ...original, status: 'question' }),
    ]);

    expect(results.filter(({ applied }) => applied)).toHaveLength(1);
    expect(results.filter(({ applied }) => !applied)).toHaveLength(1);
    await expect(repository.list()).resolves.toHaveLength(1);
  });

  it('rejects invalid compare-and-swap replacements before writing', async () => {
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });
    const original = note();
    await repository.save({ version: 1, notes: [original] });
    const writesBeforeSwap = fileSystemState.writes.length;

    await expect(
      repository.compareAndSwap(original, {
        ...original,
        id: '2596f84e-5d28-43b4-8962-1e3b9f4bf623',
      }),
    ).rejects.toThrow(/cannot change/u);
    await expect(
      repository.compareAndSwap(original, {
        ...original,
        relativePath: '../secret.ts',
      }),
    ).rejects.toThrow();
    expect(fileSystemState.writes).toHaveLength(writesBeforeSwap);
  });

  it('does not resurrect a target deleted after the expected snapshot', async () => {
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });
    const original = note();
    await repository.save({ version: 1, notes: [original] });
    const expected = await repository.load();
    fileSystemState.files.set(
      repository.storeUri.toString(),
      new TextEncoder().encode(serializeReviewNoteStore({ version: 1, notes: [] })),
    );

    const result = await repository.mergeIfUnchanged(expected, [
      {
        before: original,
        after: {
          ...original,
          resolution: { state: 'orphaned', reason: 'source-unavailable' },
        },
      },
    ]);

    expect(result).toMatchObject({
      appliedCount: 0,
      skippedCount: 1,
      wrote: false,
      externalDivergence: true,
    });
    expect(result.store.notes).toEqual([]);
  });

  it('upserts by UUID and deletes without rewriting for a missing UUID', async () => {
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });
    await repository.upsert(note());
    await repository.upsert(note(undefined, 'src/renamed.ts'));

    await expect(repository.list()).resolves.toMatchObject([{ relativePath: 'src/renamed.ts' }]);
    const writesBeforeMissingDelete = fileSystemState.writes.length;
    await expect(repository.delete('397b34ce-3acf-45a8-8d21-05a9ea6267ed')).resolves.toBe(false);
    expect(fileSystemState.writes).toHaveLength(writesBeforeMissingDelete);
    await expect(repository.delete('64F8D415-C742-4A4D-9140-73FDA994F3E8')).resolves.toBe(true);
    await expect(repository.list()).resolves.toEqual([]);
  });

  it('rejects unsafe note paths before a mutation', async () => {
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });

    await expect(repository.upsert(note(undefined, '../secret.ts'))).rejects.toThrow();
    expect(fileSystemState.writes).toHaveLength(0);
  });

  it('surfaces malformed sidecars instead of silently discarding data', async () => {
    const repository = new ReviewNoteRepository({ workspaceFolder, mode: 'workspace' });
    fileSystemState.files.set(
      repository.storeUri.toString(),
      new TextEncoder().encode('{"version":1,"notes":"wrong"}'),
    );

    await expect(repository.load()).rejects.toThrow(/expected an array/);
  });
});

describe('resolveUriWithinRoot', () => {
  it('preserves scheme and authority for contained remote paths', () => {
    expect(resolveUriWithinRoot(workspaceUri, 'src/file.ts').toString()).toBe(
      'vscode-remote://ssh-remote+host/project/src/file.ts',
    );
  });

  it('rejects traversal and absolute input before URI joining', () => {
    expect(() => resolveUriWithinRoot(workspaceUri, '../../secret')).toThrow();
    expect(() => resolveUriWithinRoot(workspaceUri, '/secret')).toThrow();
  });
});
