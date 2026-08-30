import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockUri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly fsPath: string;
  toString(): string;
}

interface MockThread {
  readonly uri: MockUri;
  range: unknown;
  comments: readonly unknown[];
  collapsibleState: number;
  canReply: boolean;
  contextValue?: string;
  label?: string;
  readonly dispose: ReturnType<typeof vi.fn>;
}

const vscodeState = vi.hoisted(() => ({
  workspaceFolders: [] as Array<{ uri: MockUri; name: string; index: number }>,
  textDocuments: [] as unknown[],
  threads: [] as MockThread[],
  controllerDisposals: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock('vscode', () => {
  class Position {
    public constructor(
      public readonly line: number,
      public readonly character: number,
    ) {}

    public isEqual(other: Position): boolean {
      return this.line === other.line && this.character === other.character;
    }
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
      if (startOrLine instanceof Position && startCharacterOrEnd instanceof Position) {
        this.start = startOrLine;
        this.end = startCharacterOrEnd;
      } else {
        this.start = new Position(startOrLine as number, startCharacterOrEnd as number);
        this.end = new Position(endLine ?? 0, endCharacter ?? 0);
      }
    }
  }

  class Uri {
    public constructor(
      public readonly scheme: string,
      public readonly authority: string,
      public readonly path: string,
      public readonly fsPath: string,
    ) {}

    public static file(fsPath: string): Uri {
      return new Uri('file', '', fsPath, fsPath);
    }

    public static parse(value: string): Uri {
      const separator = value.indexOf(':');
      const scheme = separator >= 0 ? value.slice(0, separator) : 'file';
      const uriPath = separator >= 0 ? value.slice(separator + 1) : value;
      return new Uri(scheme, '', uriPath, uriPath);
    }

    public toString(): string {
      return `${this.scheme}://${this.authority}${this.path}`;
    }
  }

  class MarkdownString {
    public constructor(public value = '') {}
  }

  return {
    Position,
    Range,
    Uri,
    MarkdownString,
    CommentMode: { Editing: 0, Preview: 1 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    workspace: {
      get workspaceFolders(): unknown[] {
        return vscodeState.workspaceFolders;
      },
      get textDocuments(): unknown[] {
        return vscodeState.textDocuments;
      },
      getWorkspaceFolder: (uri: MockUri) =>
        vscodeState.workspaceFolders.find(({ uri: root }) => {
          if (root.scheme !== uri.scheme || root.authority !== uri.authority) {
            return false;
          }
          const rootPath = root.scheme === 'file' ? root.fsPath : root.path;
          const candidate = uri.scheme === 'file' ? uri.fsPath : uri.path;
          return candidate === rootPath || candidate.startsWith(`${rootPath}/`);
        }),
    },
    comments: {
      createCommentController: (id: string, label: string) => {
        const dispose = vi.fn();
        vscodeState.controllerDisposals.push(dispose);
        return {
          id,
          label,
          options: undefined,
          commentingRangeProvider: undefined,
          createCommentThread: (uri: MockUri, range: unknown, comments: readonly unknown[]) => {
            const thread: MockThread = {
              uri,
              range,
              comments,
              collapsibleState: 0,
              canReply: true,
              dispose: vi.fn(),
            };
            vscodeState.threads.push(thread);
            return thread;
          },
          dispose,
        };
      },
    },
  };
});

import * as vscode from 'vscode';

import {
  REVIEW_DRAFT_THREAD_CONTEXT,
  REVIEW_NOTE_COMMENT_CONTEXT,
  REVIEW_NOTE_THREAD_CONTEXT,
  ReviewCommentController,
  type NewReviewThreadInput,
  type ReviewCommentControllerCallbacks,
  type ReviewThreadNote,
  type UpdateReviewThreadInput,
} from '../../../src/comments/reviewCommentController';

const rootUri = vscode.Uri.file('/workspace');

function createDocument(
  uri: vscode.Uri,
  text: string,
  options: { readonly isClosed?: boolean } = {},
): vscode.TextDocument {
  const lines = text.split('\n');
  const offsetAt = (position: vscode.Position): number => {
    let offset = 0;
    for (let line = 0; line < position.line; line += 1) {
      offset += (lines[line]?.length ?? 0) + 1;
    }
    return offset + position.character;
  };
  const positionAt = (rawOffset: number): vscode.Position => {
    let offset = Math.max(0, Math.min(rawOffset, text.length));
    for (let line = 0; line < lines.length; line += 1) {
      const length = lines[line]?.length ?? 0;
      if (offset <= length || line === lines.length - 1) {
        return new vscode.Position(line, Math.min(offset, length));
      }
      offset -= length + 1;
    }
    return new vscode.Position(0, 0);
  };
  const validatePosition = (position: vscode.Position): vscode.Position => {
    const line = Math.max(0, Math.min(position.line, lines.length - 1));
    return new vscode.Position(
      line,
      Math.max(0, Math.min(position.character, lines[line]!.length)),
    );
  };

  return {
    uri,
    fileName: uri.fsPath,
    isUntitled: uri.scheme === 'untitled',
    languageId: 'plaintext',
    version: 1,
    isDirty: false,
    isClosed: options.isClosed ?? false,
    lineCount: lines.length,
    save: vi.fn(async () => true),
    lineAt: (line: number) => ({
      lineNumber: line,
      text: lines[line]!,
      range: new vscode.Range(line, 0, line, lines[line]!.length),
      rangeIncludingLineBreak: new vscode.Range(line, 0, line, lines[line]!.length),
      firstNonWhitespaceCharacterIndex: 0,
      isEmptyOrWhitespace: lines[line]!.trim().length === 0,
    }),
    offsetAt,
    positionAt,
    getText: (range?: vscode.Range) =>
      range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
    getWordRangeAtPosition: () => undefined,
    validateRange: (range: vscode.Range) =>
      new vscode.Range(validatePosition(range.start), validatePosition(range.end)),
    validatePosition,
  } as unknown as vscode.TextDocument;
}

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return new vscode.Range(startLine, startCharacter, endLine, endCharacter);
}

function reviewNote(overrides: Partial<ReviewThreadNote> = {}): ReviewThreadNote {
  return {
    id: 'note-1',
    uri: vscode.Uri.file('/workspace/src/example.ts'),
    range: range(1, 2, 2, 4),
    body: 'Check this behavior.',
    category: 'Code Review',
    status: 'open',
    ...overrides,
  };
}

function callbacks(
  overrides: Partial<ReviewCommentControllerCallbacks> = {},
): ReviewCommentControllerCallbacks {
  return {
    createNote: vi.fn(() => undefined),
    updateNote: vi.fn(() => undefined),
    deleteNote: vi.fn(),
    ...overrides,
  };
}

describe('ReviewCommentController', () => {
  beforeEach(() => {
    vscodeState.workspaceFolders = [
      { uri: rootUri as unknown as MockUri, name: 'workspace', index: 0 },
    ];
    vscodeState.textDocuments = [];
    vscodeState.threads = [];
    vscodeState.controllerDisposals = [];
  });

  it('offers a full-document commenting range only for safe workspace text documents', () => {
    const controller = new ReviewCommentController(callbacks());
    const eligible = createDocument(
      vscode.Uri.file('/workspace/src/example.unknown'),
      ['alpha', 'beta', 'gamma'].join('\n'),
    );
    const [provided] = controller.provideCommentingRanges(eligible);

    expect(provided?.start).toMatchObject({ line: 0, character: 0 });
    expect(provided?.end).toMatchObject({ line: 2, character: 5 });
    expect(
      controller.provideCommentingRanges(
        createDocument(vscode.Uri.file('/workspace/CODING_NOTES_FOR_AI.json'), '{}'),
      ),
    ).toEqual([]);
    expect(
      controller.provideCommentingRanges(
        createDocument(vscode.Uri.file('/workspace/dist/generated.js'), 'generated'),
      ),
    ).toEqual([]);
    expect(
      controller.provideCommentingRanges(
        createDocument(vscode.Uri.file('/outside/example.ts'), 'outside'),
      ),
    ).toEqual([]);
    expect(
      controller.provideCommentingRanges(
        createDocument(vscode.Uri.file('/workspace/src/binary.data'), `valid\0binary`),
      ),
    ).toEqual([]);
    expect(
      controller.provideCommentingRanges(createDocument(vscode.Uri.parse('untitled:draft'), 'x')),
    ).toEqual([]);
    expect(
      controller.provideCommentingRanges(eligible, { isCancellationRequested: true } as never),
    ).toEqual([]);
  });

  it('restores, updates, maps, and disposes threads by stable note ID', () => {
    const controller = new ReviewCommentController(callbacks());
    const displayRange = range(0, 6, 0, 13);
    const initial = reviewNote({
      displayRange,
      symbolLabel: 'doWork',
      updatedAt: '2026-08-30T12:00:00.000Z',
    });
    controller.replaceNotes([initial]);

    const thread = controller.getThread(initial.id)!;
    const comment = thread.comments[0]!;
    expect(thread.range).toBe(displayRange);
    expect(thread.canReply).toBe(false);
    expect(thread.collapsibleState).toBe(vscode.CommentThreadCollapsibleState.Collapsed);
    expect(thread.contextValue).toBe(REVIEW_NOTE_THREAD_CONTEXT);
    expect(thread.label).toBe('doWork — Code Review • open');
    expect(comment).toMatchObject({
      body: 'Check this behavior.',
      label: 'Code Review • open',
      contextValue: REVIEW_NOTE_COMMENT_CONTEXT,
      mode: vscode.CommentMode.Preview,
    });
    expect(controller.getNoteId(thread)).toBe(initial.id);
    expect(controller.getNoteId(comment)).toBe(initial.id);
    expect(controller.getNoteId({ thread, text: '' })).toBe(initial.id);
    expect(controller.expandNote(initial.id)).toBe(true);
    expect(thread.collapsibleState).toBe(vscode.CommentThreadCollapsibleState.Expanded);
    expect(controller.expandNote('missing-note')).toBe(false);

    const updatedRange = range(3, 1, 3, 8);
    controller.upsertNote(
      reviewNote({
        range: updatedRange,
        body: 'Updated body',
        category: 'Accessibility',
        status: 'follow-up',
      }),
    );

    expect(controller.getThread(initial.id)).toBe(thread);
    expect(thread.range).toBe(updatedRange);
    expect(thread.comments[0]).toBe(comment);
    expect(comment).toMatchObject({
      body: 'Updated body',
      label: 'Accessibility • follow-up',
    });

    controller.replaceNotes([]);
    expect(thread.dispose).toHaveBeenCalledOnce();
    expect(controller.getThread(initial.id)).toBeUndefined();
    expect(controller.getNoteId(thread)).toBeUndefined();
  });

  it('keeps existing notes visible when creation later becomes ineligible', () => {
    const document = createDocument(
      vscode.Uri.file('/workspace/src/excluded-after-creation.ts'),
      'const value = 1;',
    );
    vscodeState.textDocuments = [document];
    const controller = new ReviewCommentController(callbacks(), {
      include: ['**/*'],
      exclude: [],
      isDocumentEligible: () => false,
    });

    expect(controller.provideCommentingRanges(document)).toEqual([]);
    expect(() =>
      controller.upsertNote(reviewNote({ uri: document.uri, range: range(0, 0, 0, 5) })),
    ).not.toThrow();
  });

  it('hides only the gutter creation range when the gutter setting is disabled', () => {
    const document = createDocument(
      vscode.Uri.file('/workspace/src/symbol-buttons-only.ts'),
      'const value = 1;',
    );
    vscodeState.textDocuments = [document];
    const controller = new ReviewCommentController(callbacks(), {
      isGutterEnabled: () => false,
    });

    expect(controller.provideCommentingRanges(document)).toEqual([]);
    expect(() =>
      controller.upsertNote(reviewNote({ uri: document.uri, range: range(0, 0, 0, 5) })),
    ).not.toThrow();
  });

  it('preserves the exact selection while displaying a symbol-anchored expanded draft', async () => {
    const document = createDocument(
      vscode.Uri.file('/workspace/src/example.ts'),
      ['const doWork = () => {', '  return calculate(value);', '};'].join('\n'),
    );
    vscodeState.textDocuments = [document];
    const selectedRange = range(1, 9, 1, 25);
    const symbolRange = range(0, 6, 0, 12);
    const createNote = vi.fn((input: NewReviewThreadInput) =>
      reviewNote({
        uri: input.uri,
        range: input.range,
        body: input.body,
        ...(input.displayRange ? { displayRange: input.displayRange } : {}),
        ...(input.symbolLabel ? { symbolLabel: input.symbolLabel } : {}),
      }),
    );
    const controller = new ReviewCommentController(callbacks({ createNote }));
    const draft = controller.createDraft(document, selectedRange, {
      category: 'API Contract',
      status: 'question',
      anchorKind: 'symbol',
      displayRange: symbolRange,
      symbolLabel: 'doWork',
    })!;

    expect(draft.range).toBe(symbolRange);
    expect(draft.comments).toEqual([]);
    expect(draft.canReply).toBe(true);
    expect(draft.collapsibleState).toBe(vscode.CommentThreadCollapsibleState.Expanded);
    expect(draft.contextValue).toBe(REVIEW_DRAFT_THREAD_CONTEXT);
    expect(draft.label).toBe('doWork — API Contract');
    expect(controller.getDraftState(draft)).toEqual({
      uri: document.uri,
      range: selectedRange,
      category: 'API Contract',
    });
    expect(controller.setDraftCategory({ thread: draft }, '  Security  ')).toBe(true);
    expect(draft.label).toBe('doWork — Security');
    expect(controller.getDraftState({ thread: draft, text: '' })?.category).toBe('Security');

    const saved = await controller.acceptCommentReply({
      thread: draft,
      text: '  Explain this call.  ',
    });

    expect(createNote).toHaveBeenCalledWith({
      uri: document.uri,
      range: selectedRange,
      category: 'Security',
      status: 'question',
      anchorKind: 'symbol',
      displayRange: symbolRange,
      symbolLabel: 'doWork',
      body: 'Explain this call.',
    });
    expect(saved?.id).toBe('note-1');
    expect(controller.getThread('note-1')).toBe(draft);
    expect(controller.getNoteId(draft.comments[0])).toBe('note-1');
    expect(draft.canReply).toBe(false);
    expect(draft.collapsibleState).toBe(vscode.CommentThreadCollapsibleState.Expanded);
  });

  it('sets and persists a category on a native empty gutter draft', async () => {
    const document = createDocument(
      vscode.Uri.file('/workspace/src/native.ts'),
      ['const first = 1;', 'const second = 2;'].join('\n'),
    );
    const nativeRange = range(1, 0, 1, 17);
    const createNote = vi.fn((input: NewReviewThreadInput) =>
      reviewNote({
        uri: input.uri,
        range: input.range,
        body: input.body,
        ...(input.category ? { category: input.category } : {}),
      }),
    );
    const controller = new ReviewCommentController(callbacks({ createNote }));
    const nativeDraft = controller.controller.createCommentThread(document.uri, nativeRange, []);

    expect(controller.getDraftState(nativeDraft)).toEqual({
      uri: document.uri,
      range: nativeRange,
    });
    expect(controller.setDraftCategory(nativeDraft, '  Documentation  ')).toBe(true);
    expect(nativeDraft).toMatchObject({
      contextValue: REVIEW_DRAFT_THREAD_CONTEXT,
      label: 'Documentation',
    });
    expect(controller.getDraftState(nativeDraft)).toEqual({
      uri: document.uri,
      range: nativeRange,
      category: 'Documentation',
    });

    await controller.acceptCommentReply({ thread: nativeDraft, text: 'Explain this value.' });

    expect(createNote).toHaveBeenCalledWith({
      uri: document.uri,
      range: nativeRange,
      body: 'Explain this value.',
      category: 'Documentation',
    });
    expect(controller.getDraftState(nativeDraft)).toBeUndefined();
    expect(controller.setDraftCategory(nativeDraft, 'Security')).toBe(false);
  });

  it('persists multiline native edits, cancels drafts, and deletes only after callbacks succeed', async () => {
    const updateNote = vi.fn((input: UpdateReviewThreadInput) =>
      reviewNote({ id: input.id, body: input.body, status: 'follow-up' }),
    );
    const deleteNote = vi.fn(async () => undefined);
    const controller = new ReviewCommentController(callbacks({ updateNote, deleteNote }));
    controller.upsertNote(reviewNote());
    const thread = controller.getThread('note-1')!;
    const comment = thread.comments[0]!;

    expect(controller.startEditing(comment)).toBe(true);
    expect(comment.mode).toBe(vscode.CommentMode.Editing);
    comment.body = 'Persisted change\nwith another line';
    await controller.saveEdit(comment);
    expect(updateNote).toHaveBeenCalledWith({
      id: 'note-1',
      body: 'Persisted change\nwith another line',
    });
    expect(comment).toMatchObject({
      body: 'Persisted change\nwith another line',
      label: 'Code Review • follow-up',
      mode: vscode.CommentMode.Preview,
    });

    controller.startEditing(comment);
    comment.body = 'Discard this';
    expect(controller.cancelEdit(comment)).toBe(true);
    expect(comment).toMatchObject({
      body: 'Persisted change\nwith another line',
      mode: vscode.CommentMode.Preview,
    });

    await controller.deleteNote(comment);
    expect(deleteNote).toHaveBeenCalledWith('note-1');
    expect(thread.dispose).toHaveBeenCalledOnce();
  });

  it('rejects invalid ranges and disposes only unpersisted draft threads', () => {
    const document = createDocument(vscode.Uri.file('/workspace/src/example.ts'), 'one line');
    const controller = new ReviewCommentController(callbacks());

    expect(() => controller.createDraft(document, range(4, 0, 4, 1))).toThrow(RangeError);
    const draft = controller.createDraft(document, range(0, 0, 0, 3))!;
    expect(controller.discardDraft({ thread: draft, text: '' })).toBe(true);
    expect(draft.dispose).toHaveBeenCalledOnce();

    controller.upsertNote(reviewNote({ range: range(0, 0, 0, 3) }));
    const persisted = controller.getThread('note-1')!;
    expect(controller.discardDraft(persisted)).toBe(false);
    expect(controller.getDraftState(persisted)).toBeUndefined();
    expect(controller.setDraftCategory(persisted, 'Security')).toBe(false);
  });
});
