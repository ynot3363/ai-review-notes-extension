import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({
  workspaceFolders: [] as unknown[],
  textDocuments: [] as unknown[],
  findFiles: vi.fn<() => Promise<unknown[]>>(),
  stat: vi.fn<() => Promise<{ type: number; size: number }>>(),
  readFile: vi.fn<() => Promise<Uint8Array>>(),
  changeTextDocumentListener: undefined as ((event: unknown) => void) | undefined,
}));

vi.mock('vscode', () => {
  class Disposable {
    public constructor(private readonly callback: () => void = () => undefined) {}

    public dispose(): void {
      this.callback();
    }
  }

  class EventEmitter<T> {
    private readonly listeners = new Set<(event: T) => void>();

    public readonly event = (listener: (event: T) => void): Disposable => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };

    public fire(event: T): void {
      for (const listener of this.listeners) {
        listener(event);
      }
    }

    public dispose(): void {
      this.listeners.clear();
    }
  }

  const inertEvent = (): Disposable => new Disposable();
  const watcher = {
    onDidCreate: inertEvent,
    onDidChange: inertEvent,
    onDidDelete: inertEvent,
    dispose: vi.fn(),
  };

  return {
    Disposable,
    EventEmitter,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    RelativePattern: class RelativePattern {
      public constructor(
        public readonly base: unknown,
        public readonly pattern: string,
      ) {}
    },
    workspace: {
      get workspaceFolders(): unknown[] {
        return vscodeState.workspaceFolders;
      },
      get textDocuments(): unknown[] {
        return vscodeState.textDocuments;
      },
      findFiles: vscodeState.findFiles,
      fs: {
        stat: vscodeState.stat,
        readFile: vscodeState.readFile,
      },
      getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined) })),
      createFileSystemWatcher: vi.fn(() => watcher),
      onDidSaveTextDocument: vi.fn(inertEvent),
      onDidChangeTextDocument: vi.fn((listener: (event: unknown) => void) => {
        vscodeState.changeTextDocumentListener = listener;
        return new Disposable();
      }),
      onDidOpenTextDocument: vi.fn(inertEvent),
      onDidCloseTextDocument: vi.fn(inertEvent),
      onDidCreateFiles: vi.fn(inertEvent),
      onDidDeleteFiles: vi.fn(inertEvent),
      onDidRenameFiles: vi.fn(inertEvent),
      onDidChangeWorkspaceFolders: vi.fn(inertEvent),
      onDidChangeConfiguration: vi.fn(inertEvent),
    },
  };
});

import { WorkspaceScanner } from '../../../src/services/workspaceScanner';

interface FakeUri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly fsPath: string;
  toString(): string;
}

function uri(path: string): FakeUri {
  return {
    scheme: 'mem',
    authority: 'workspace',
    path,
    fsPath: path,
    toString: () => `mem://workspace${path}`,
  };
}

const folderUri = uri('/project');
const fileUri = uri('/project/settings.json');
const workspaceFolder = { name: 'project', index: 0, uri: folderUri };
const liveReview = [
  '/*',
  ' * CODING-NOTE-START',
  ' * id: live-buffer',
  ' * category: Code Review',
  ' * status: open',
  ' * comment:',
  ' * Unsaved finding',
  ' * CODING-NOTE-END',
  ' */',
].join('\n');

describe('WorkspaceScanner open-document behavior', () => {
  beforeEach(() => {
    vscodeState.workspaceFolders = [workspaceFolder];
    vscodeState.textDocuments = [];
    vscodeState.findFiles.mockReset().mockResolvedValue([]);
    vscodeState.stat.mockReset().mockResolvedValue({ type: 1, size: 2 });
    vscodeState.readFile.mockReset().mockResolvedValue(new TextEncoder().encode('{}'));
    vscodeState.changeTextDocumentListener = undefined;
  });

  it('scans dirty buffer text and its actual jsonc language instead of strict-JSON disk data', async () => {
    vscodeState.textDocuments = [
      {
        uri: fileUri,
        languageId: 'jsonc',
        isDirty: true,
        getText: () => liveReview,
      },
    ];
    const scanner = new WorkspaceScanner({ include: ['**/*'], exclude: [] });

    const result = await scanner.scan();

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({
      id: 'live-buffer',
      comment: 'Unsaved finding',
      relativePath: 'settings.json',
    });
    expect(vscodeState.readFile).not.toHaveBeenCalled();
    scanner.dispose();
  });

  it('debounces live text-document changes into scanner invalidations', () => {
    vi.useFakeTimers();
    const scanner = new WorkspaceScanner({
      include: ['**/*'],
      exclude: [],
      debounceMs: 10,
    });
    const listener = vi.fn();
    scanner.onDidChange(listener);
    scanner.startWatching();

    vscodeState.changeTextDocumentListener?.({
      document: { uri: fileUri },
      contentChanges: [{ text: 'changed' }],
    });
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);

    expect(listener).toHaveBeenCalledOnce();
    scanner.dispose();
    vi.useRealTimers();
  });

  it('applies workspace-folder-specific exclusions', async () => {
    vscodeState.textDocuments = [
      {
        uri: fileUri,
        languageId: 'jsonc',
        isDirty: true,
        getText: () => liveReview,
      },
    ];
    const scanner = new WorkspaceScanner({
      include: ['**/*'],
      exclude: [],
      excludeForFolder: () => ['**/*.json'],
    });

    const result = await scanner.scan();

    expect(result.comments).toEqual([]);
    expect(result.skippedFileCount).toBe(1);
    scanner.dispose();
  });
});
