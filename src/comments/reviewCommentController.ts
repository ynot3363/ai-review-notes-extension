import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  createPathFilter,
  DEFAULT_SCAN_EXCLUDES,
  DEFAULT_SCAN_INCLUDES,
  isProbablyBinary,
  normalizeRelativePath,
} from '../services/pathUtils';

export const REVIEW_COMMENT_CONTROLLER_ID = 'codingNotesForAi';
export const REVIEW_DRAFT_THREAD_CONTEXT = 'codingNotesForAi.draft';
export const REVIEW_NOTE_THREAD_CONTEXT = 'open';
export const REVIEW_RESOLVED_THREAD_CONTEXT = 'resolved';
export const REVIEW_NOTE_COMMENT_CONTEXT = 'codingNotesForAi.note';
export const DEFAULT_REVIEW_SIDECAR_FILES = Object.freeze(['CODING_NOTES_FOR_AI.json']);

const BLOCKED_DOCUMENT_SCHEMES = new Set([
  'chat-editing-snapshot-text-model',
  'comment',
  'debug',
  'git',
  'output',
  'search-editor',
  'untitled',
  'vscode-notebook-cell',
  'vscode-userdata',
  'walkthrough',
  'walkthroughsnippet',
]);

/** A storage-independent projection of one persisted note into the Comments UI. */
export interface ReviewThreadNote {
  readonly id: string;
  readonly uri: vscode.Uri;
  /** The exact source selection to persist and send to report/AI consumers. */
  readonly range: vscode.Range;
  readonly body: string;
  readonly category: string;
  readonly status: string;
  /**
   * Optional editor location used for the gutter glyph. This is useful when a
   * symbol anchor should display on its declaration while `range` remains the
   * exact user selection.
   */
  readonly displayRange?: vscode.Range;
  readonly symbolLabel?: string;
  readonly authorName?: string;
  readonly updatedAt?: Date | string;
}

export interface NewReviewThreadInput {
  readonly uri: vscode.Uri;
  /** Exact range selected by the user, not a line-expanded range. */
  readonly range: vscode.Range;
  readonly body: string;
  readonly category?: string;
  readonly status?: string;
  readonly anchorKind?: 'line' | 'range' | 'symbol';
  readonly displayRange?: vscode.Range;
  readonly symbolLabel?: string;
}

export interface UpdateReviewThreadInput {
  readonly id: string;
  readonly body: string;
}

/** Persistence hooks. The adapter mutates editor UI only after a hook succeeds. */
export interface ReviewCommentControllerCallbacks {
  readonly createNote: (
    input: NewReviewThreadInput,
  ) => ReviewThreadNote | undefined | PromiseLike<ReviewThreadNote | undefined>;
  readonly updateNote: (
    input: UpdateReviewThreadInput,
  ) => ReviewThreadNote | undefined | PromiseLike<ReviewThreadNote | undefined>;
  readonly deleteNote: (noteId: string) => void | PromiseLike<void>;
}

export interface ReviewDocumentEligibilityOptions {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly sidecarFileNames?: readonly string[];
  /** Additional product-specific guard, evaluated after the built-in safety checks. */
  readonly isDocumentEligible?: (document: vscode.TextDocument) => boolean;
}

export interface ReviewCommentControllerOptions extends ReviewDocumentEligibilityOptions {
  readonly controllerId?: string;
  readonly label?: string;
  readonly authorName?: string;
  /** Controls only the native add-comment gutter; persisted threads remain visible. */
  readonly isGutterEnabled?: (document: vscode.TextDocument) => boolean;
}

export interface CreateDraftOptions {
  readonly category?: string;
  readonly status?: string;
  readonly anchorKind?: 'line' | 'range' | 'symbol';
  readonly displayRange?: vscode.Range;
  readonly symbolLabel?: string;
}

/** Public state needed to choose or change a category before a draft is submitted. */
export interface ReviewDraftState {
  readonly uri: vscode.Uri;
  /** The exact source selection that will be persisted when the draft is submitted. */
  readonly range: vscode.Range;
  readonly category?: string;
}

interface ManagedThread {
  note: ReviewThreadNote;
  readonly thread: vscode.CommentThread;
  readonly comment: ManagedReviewComment;
}

interface DraftMetadata {
  readonly range: vscode.Range;
  readonly category?: string;
  readonly status?: string;
  readonly anchorKind?: 'line' | 'range' | 'symbol';
  readonly displayRange?: vscode.Range;
  readonly symbolLabel?: string;
}

class ManagedReviewComment implements vscode.Comment {
  public body: string | vscode.MarkdownString;
  public mode = vscode.CommentMode.Preview;
  public author: vscode.CommentAuthorInformation;
  public contextValue = REVIEW_NOTE_COMMENT_CONTEXT;
  public label: string;
  public timestamp?: Date;

  public constructor(note: ReviewThreadNote, fallbackAuthor: string) {
    this.body = note.body;
    this.author = { name: cleanLabel(note.authorName, fallbackAuthor) };
    this.label = formatReviewNoteLabel(note.category, note.status);
    const timestamp = parseTimestamp(note.updatedAt);
    if (timestamp) {
      this.timestamp = timestamp;
    }
  }
}

/**
 * Adapts persisted notes to VS Code's stable Comments API. It deliberately has
 * no knowledge of a sidecar schema: callers translate storage records to and
 * from `ReviewThreadNote` in the supplied callbacks.
 */
export class ReviewCommentController implements vscode.Disposable {
  public readonly controller: vscode.CommentController;

  private readonly entries = new Map<string, ManagedThread>();
  private readonly noteIdByThread = new WeakMap<vscode.CommentThread, string>();
  private readonly noteIdByComment = new WeakMap<vscode.Comment, string>();
  private readonly draftMetadata = new WeakMap<vscode.CommentThread, DraftMetadata>();
  private readonly pendingDrafts = new WeakSet<vscode.CommentThread>();
  private readonly eligibility: ReviewDocumentEligibilityOptions;
  private readonly fallbackAuthor: string;
  private readonly isGutterEnabled: (document: vscode.TextDocument) => boolean;
  private disposed = false;

  public constructor(
    private readonly callbacks: ReviewCommentControllerCallbacks,
    options: ReviewCommentControllerOptions = {},
  ) {
    this.eligibility = {
      include: options.include ?? DEFAULT_SCAN_INCLUDES,
      exclude: options.exclude ?? DEFAULT_SCAN_EXCLUDES,
      sidecarFileNames: options.sidecarFileNames ?? DEFAULT_REVIEW_SIDECAR_FILES,
      ...(options.isDocumentEligible ? { isDocumentEligible: options.isDocumentEligible } : {}),
    };
    this.fallbackAuthor = cleanLabel(options.authorName, 'Coding Notes for AI');
    this.isGutterEnabled = options.isGutterEnabled ?? (() => true);
    this.controller = vscode.comments.createCommentController(
      cleanLabel(options.controllerId, REVIEW_COMMENT_CONTROLLER_ID),
      cleanLabel(options.label, 'Coding Notes for AI'),
    );
    this.controller.options = {
      prompt: 'Add a coding note',
      placeHolder: 'Describe what should be examined or changed…',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document, token) => this.provideCommentingRanges(document, token),
    };
  }

  /** Return the full document as one native commenting range when it is safe. */
  public provideCommentingRanges(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken,
  ): vscode.Range[] {
    if (
      this.disposed ||
      token?.isCancellationRequested ||
      !this.isGutterEnabled(document) ||
      !isEligibleReviewDocument(document, this.eligibility)
    ) {
      return [];
    }

    const lastLine = Math.max(0, document.lineCount - 1);
    return [new vscode.Range(new vscode.Position(0, 0), document.lineAt(lastLine).range.end)];
  }

  /** Reconcile every displayed persisted thread by stable note ID. */
  public replaceNotes(notes: readonly ReviewThreadNote[]): void {
    this.ensureActive();
    const incoming = new Set<string>();
    for (const note of notes) {
      const id = validateNoteId(note.id);
      if (incoming.has(id)) {
        throw new Error(`Duplicate note ID: ${id}`);
      }
      incoming.add(id);
    }

    for (const note of notes) {
      this.upsertNote(note);
    }

    for (const id of [...this.entries.keys()]) {
      if (!incoming.has(id)) {
        this.removeNote(id);
      }
    }
  }

  /** Create or update one displayed persisted thread. */
  public upsertNote(note: ReviewThreadNote): vscode.CommentThread {
    this.ensureActive();
    const id = validateNoteId(note.id);
    this.ensureEligibleNote(note);
    const current = this.entries.get(id);

    if (current && current.thread.uri.toString() === note.uri.toString()) {
      this.applyNote(current, note);
      return current.thread;
    }

    if (current) {
      this.disposeEntry(id, current);
    }

    const comment = new ManagedReviewComment(note, this.fallbackAuthor);
    const thread = this.controller.createCommentThread(note.uri, displayRangeOf(note), [comment]);
    const entry: ManagedThread = { note, thread, comment };
    this.entries.set(id, entry);
    this.bindStableId(entry, id);
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    thread.contextValue = threadContextOf(note);
    thread.label = formatThreadLabel(note);
    return thread;
  }

  /**
   * Open an expanded empty thread. `range` remains the persisted selection;
   * `displayRange` may independently locate a symbol declaration in the UI.
   */
  public createDraft(
    document: vscode.TextDocument,
    range: vscode.Range,
    options: CreateDraftOptions = {},
  ): vscode.CommentThread | undefined {
    this.ensureActive();
    if (!isEligibleReviewDocument(document, this.eligibility)) {
      return undefined;
    }
    if (!isExactDocumentRange(document, range)) {
      throw new RangeError('The note range is outside the document.');
    }
    if (options.displayRange && !isExactDocumentRange(document, options.displayRange)) {
      throw new RangeError('The note display range is outside the document.');
    }

    const displayRange = options.displayRange ?? range;
    const thread = this.controller.createCommentThread(document.uri, displayRange, []);
    const metadata: DraftMetadata = {
      range,
      ...(options.category ? { category: options.category } : {}),
      ...(options.status ? { status: options.status } : {}),
      ...(options.anchorKind ? { anchorKind: options.anchorKind } : {}),
      ...(options.displayRange ? { displayRange: options.displayRange } : {}),
      ...(options.symbolLabel ? { symbolLabel: options.symbolLabel } : {}),
    };
    this.draftMetadata.set(thread, metadata);
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.contextValue = REVIEW_DRAFT_THREAD_CONTEXT;
    const label = formatDraftThreadLabel(metadata);
    if (label) {
      thread.label = label;
    }
    return thread;
  }

  /** Inspect an unpersisted native or programmatic draft thread. */
  public getDraftState(argument: unknown): ReviewDraftState | undefined {
    if (this.disposed) {
      return undefined;
    }
    const thread = this.resolveThread(argument);
    if (!thread || this.getNoteId(thread)) {
      return undefined;
    }

    const metadata = this.draftMetadata.get(thread);
    return {
      uri: thread.uri,
      range: metadata?.range ?? thread.range,
      ...(metadata?.category ? { category: metadata.category } : {}),
    };
  }

  /** Set the category displayed on, and later persisted from, an unpersisted draft. */
  public setDraftCategory(argument: unknown, category: string): boolean {
    if (this.disposed) {
      return false;
    }
    const thread = this.resolveThread(argument);
    const cleanedCategory = category.trim();
    if (!thread || !cleanedCategory || this.getNoteId(thread) || this.pendingDrafts.has(thread)) {
      return false;
    }

    const current = this.draftMetadata.get(thread);
    const metadata: DraftMetadata = {
      ...(current ?? { range: thread.range }),
      category: cleanedCategory,
    };
    this.draftMetadata.set(thread, metadata);
    thread.contextValue = REVIEW_DRAFT_THREAD_CONTEXT;
    const label = formatDraftThreadLabel(metadata);
    if (label) {
      thread.label = label;
    } else {
      delete thread.label;
    }
    return true;
  }

  /**
   * Menu handler for the empty-thread submit action. Native gutter-created
   * threads and programmatic drafts both arrive as a `CommentReply`.
   */
  public async acceptCommentReply(
    reply: vscode.CommentReply,
  ): Promise<ReviewThreadNote | undefined> {
    this.ensureActive();
    if (this.getNoteId(reply.thread) || this.pendingDrafts.has(reply.thread)) {
      return undefined;
    }

    const body = reply.text.trim();
    if (!body) {
      return undefined;
    }

    const metadata = this.draftMetadata.get(reply.thread);
    const input: NewReviewThreadInput = {
      uri: reply.thread.uri,
      range: metadata?.range ?? reply.thread.range,
      body,
      ...(metadata?.category ? { category: metadata.category } : {}),
      ...(metadata?.status ? { status: metadata.status } : {}),
      ...(metadata?.anchorKind ? { anchorKind: metadata.anchorKind } : {}),
      ...(metadata?.displayRange ? { displayRange: metadata.displayRange } : {}),
      ...(metadata?.symbolLabel ? { symbolLabel: metadata.symbolLabel } : {}),
    };
    this.pendingDrafts.add(reply.thread);
    try {
      const note = await this.callbacks.createNote(input);
      if (!note) {
        return undefined;
      }
      this.bindCommentReply(reply, note);
      return note;
    } finally {
      this.pendingDrafts.delete(reply.thread);
    }
  }

  /** Bind an already-persisted note to the native ephemeral reply thread. */
  public bindCommentReply(
    reply: vscode.CommentReply,
    note: ReviewThreadNote,
  ): vscode.CommentThread {
    this.ensureActive();
    const id = validateNoteId(note.id);
    this.ensureEligibleNote(note);
    const thread = reply.thread;

    if (thread.uri.toString() !== note.uri.toString()) {
      thread.dispose();
      this.draftMetadata.delete(thread);
      return this.upsertNote(note);
    }

    const current = this.entries.get(id);
    if (current && current.thread !== thread) {
      this.disposeEntry(id, current);
    } else if (current) {
      this.noteIdByComment.delete(current.comment);
    }

    const comment = new ManagedReviewComment(note, this.fallbackAuthor);
    const entry: ManagedThread = { note, thread, comment };
    this.entries.set(id, entry);
    this.bindStableId(entry, id);
    this.draftMetadata.delete(thread);
    this.applyNote(entry, note);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return thread;
  }

  /** Persist a body supplied by the extension's edit input box and rerender. */
  public async updateNoteBody(
    argument: unknown,
    body: string,
  ): Promise<ReviewThreadNote | undefined> {
    this.ensureActive();
    const entry = this.resolveEntry(argument);
    if (!entry) {
      return undefined;
    }
    const note = await this.callbacks.updateNote({ id: entry.note.id, body });
    if (!note) {
      return undefined;
    }
    if (note.id !== entry.note.id) {
      throw new Error('Updating a note cannot change its stable ID.');
    }
    this.upsertNote(note);
    return note;
  }

  /** Switch a persisted comment into VS Code's multiline native editor. */
  public startEditing(argument: unknown): boolean {
    this.ensureActive();
    const entry = this.resolveEntry(argument);
    if (!entry) {
      return false;
    }
    entry.comment.body = entry.note.body;
    entry.comment.mode = vscode.CommentMode.Editing;
    entry.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.refreshComment(entry);
    return true;
  }

  /** Persist the body currently held by VS Code's native comment editor. */
  public async saveEdit(argument: unknown): Promise<ReviewThreadNote | undefined> {
    this.ensureActive();
    const entry = this.resolveEntry(argument);
    if (!entry) {
      return undefined;
    }
    return this.updateNoteBody(entry.comment, commentBodyText(entry.comment.body));
  }

  /** Restore the last persisted body and leave native edit mode. */
  public cancelEdit(argument: unknown): boolean {
    this.ensureActive();
    const entry = this.resolveEntry(argument);
    if (!entry) {
      return false;
    }
    entry.comment.body = entry.note.body;
    entry.comment.mode = vscode.CommentMode.Preview;
    this.refreshComment(entry);
    return true;
  }

  /** Persist deletion and dispose the matching thread only after it succeeds. */
  public async deleteNote(argument: unknown): Promise<boolean> {
    this.ensureActive();
    const id = this.getNoteId(argument);
    if (!id || !this.entries.has(id)) {
      return false;
    }
    await this.callbacks.deleteNote(id);
    return this.removeNote(id);
  }

  /** Dispose an unpersisted empty thread, for a menu-provided cancel action. */
  public discardDraft(argument: unknown): boolean {
    if (this.disposed) {
      return false;
    }
    const thread = this.resolveThread(argument);
    if (!thread || this.getNoteId(thread)) {
      return false;
    }
    this.draftMetadata.delete(thread);
    thread.dispose();
    return true;
  }

  /** Dispose one visible persisted thread without invoking persistence. */
  public removeNote(noteId: string): boolean {
    const entry = this.entries.get(noteId);
    if (!entry) {
      return false;
    }
    this.disposeEntry(noteId, entry);
    return true;
  }

  /** Resolve native thread/comment/reply command arguments to a stable note ID. */
  public getNoteId(argument: unknown): string | undefined {
    if (typeof argument === 'string') {
      return this.entries.has(argument) ? argument : undefined;
    }
    if (!isObject(argument)) {
      return undefined;
    }

    const directThreadId = this.noteIdByThread.get(argument as unknown as vscode.CommentThread);
    if (directThreadId) {
      return directThreadId;
    }
    const directCommentId = this.noteIdByComment.get(argument as unknown as vscode.Comment);
    if (directCommentId) {
      return directCommentId;
    }
    if ('thread' in argument && isObject(argument.thread)) {
      return this.noteIdByThread.get(argument.thread as unknown as vscode.CommentThread);
    }
    return undefined;
  }

  public getThread(noteId: string): vscode.CommentThread | undefined {
    return this.entries.get(noteId)?.thread;
  }

  /** Expand the native comment thread for a persisted note. */
  public expandNote(noteId: string): boolean {
    if (this.disposed) {
      return false;
    }
    const thread = this.entries.get(noteId)?.thread;
    if (!thread) {
      return false;
    }
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    return true;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const entry of this.entries.values()) {
      this.noteIdByThread.delete(entry.thread);
      this.noteIdByComment.delete(entry.comment);
      this.draftMetadata.delete(entry.thread);
      this.pendingDrafts.delete(entry.thread);
    }
    this.entries.clear();
    this.controller.dispose();
  }

  private applyNote(entry: ManagedThread, note: ReviewThreadNote): void {
    this.noteIdByComment.delete(entry.comment);
    entry.note = note;
    entry.thread.range = displayRangeOf(note);
    entry.thread.canReply = false;
    entry.thread.contextValue = threadContextOf(note);
    entry.thread.label = formatThreadLabel(note);
    entry.comment.body = note.body;
    entry.comment.mode = vscode.CommentMode.Preview;
    entry.comment.author = { name: cleanLabel(note.authorName, this.fallbackAuthor) };
    entry.comment.contextValue = REVIEW_NOTE_COMMENT_CONTEXT;
    entry.comment.label = formatReviewNoteLabel(note.category, note.status);
    const timestamp = parseTimestamp(note.updatedAt);
    if (timestamp) {
      entry.comment.timestamp = timestamp;
    } else {
      delete entry.comment.timestamp;
    }
    this.bindStableId(entry, note.id);
    this.refreshComment(entry);
  }

  private bindStableId(entry: ManagedThread, noteId: string): void {
    this.noteIdByThread.set(entry.thread, noteId);
    this.noteIdByComment.set(entry.comment, noteId);
  }

  private refreshComment(entry: ManagedThread): void {
    entry.thread.comments = [entry.comment];
  }

  private disposeEntry(noteId: string, entry: ManagedThread): void {
    this.entries.delete(noteId);
    this.noteIdByThread.delete(entry.thread);
    this.noteIdByComment.delete(entry.comment);
    this.draftMetadata.delete(entry.thread);
    entry.thread.dispose();
  }

  private resolveEntry(argument: unknown): ManagedThread | undefined {
    const id = this.getNoteId(argument);
    return id ? this.entries.get(id) : undefined;
  }

  private resolveThread(argument: unknown): vscode.CommentThread | undefined {
    if (!isObject(argument)) {
      return undefined;
    }
    if ('thread' in argument && isObject(argument.thread)) {
      return argument.thread as unknown as vscode.CommentThread;
    }
    if ('uri' in argument && 'range' in argument && 'comments' in argument) {
      return argument as unknown as vscode.CommentThread;
    }
    return undefined;
  }

  private ensureEligibleNote(note: ReviewThreadNote): void {
    if (!isEligibleReviewUri(note.uri, this.eligibility)) {
      throw new Error(`Notes cannot be displayed for ${note.uri.toString()}.`);
    }
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === note.uri.toString(),
    );
    if (
      openDocument &&
      (!isExactDocumentRange(openDocument, note.range) ||
        (note.displayRange !== undefined && !isExactDocumentRange(openDocument, note.displayRange)))
    ) {
      throw new RangeError(`Note ${note.id} has a range outside its document.`);
    }
  }

  private ensureActive(): void {
    if (this.disposed) {
      throw new Error('The Coding Notes for AI comment controller has been disposed.');
    }
  }
}

/** Conservative eligibility shared by the range provider and callers/tests. */
export function isEligibleReviewDocument(
  document: vscode.TextDocument,
  options: ReviewDocumentEligibilityOptions = {},
): boolean {
  if (document.isClosed || !isEligibleReviewUri(document.uri, options)) {
    return false;
  }

  const sampleEnd = document.positionAt(8_192);
  const sample = document.getText(new vscode.Range(new vscode.Position(0, 0), sampleEnd));
  if (isProbablyBinary(new TextEncoder().encode(sample))) {
    return false;
  }
  return options.isDocumentEligible?.(document) ?? true;
}

/** URI-only guard used when restoring a note for a document that is not open. */
export function isEligibleReviewUri(
  uri: vscode.Uri,
  options: ReviewDocumentEligibilityOptions = {},
): boolean {
  if (BLOCKED_DOCUMENT_SCHEMES.has(uri.scheme.toLowerCase())) {
    return false;
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder || folder.uri.scheme !== uri.scheme || folder.uri.authority !== uri.authority) {
    return false;
  }
  const relativePath = workspaceRelativeUriPath(uri, folder.uri);
  if (relativePath === undefined || relativePath.length === 0) {
    return false;
  }
  const sidecars = options.sidecarFileNames ?? DEFAULT_REVIEW_SIDECAR_FILES;
  const basename = path.posix.basename(relativePath).toLowerCase();
  if (
    sidecars.some(
      (name) => path.posix.basename(normalizeRelativePath(name.trim())).toLowerCase() === basename,
    )
  ) {
    return false;
  }
  const filter = createPathFilter({
    include: options.include ?? DEFAULT_SCAN_INCLUDES,
    exclude: options.exclude ?? DEFAULT_SCAN_EXCLUDES,
  });
  return filter(relativePath);
}

export function formatReviewNoteLabel(category: string, status: string): string {
  return `${cleanLabel(category, 'Uncategorized')} • ${cleanLabel(status, 'open')}`;
}

function formatThreadLabel(note: ReviewThreadNote): string {
  const metadata = formatReviewNoteLabel(note.category, note.status);
  const symbol = note.symbolLabel?.trim();
  return symbol ? `${symbol} — ${metadata}` : metadata;
}

function formatDraftThreadLabel(metadata: DraftMetadata): string | undefined {
  const category = metadata.category?.trim();
  const symbol = metadata.symbolLabel?.trim();
  if (symbol && category) {
    return `${symbol} — ${category}`;
  }
  return symbol || category || undefined;
}

function displayRangeOf(note: ReviewThreadNote): vscode.Range {
  return note.displayRange ?? note.range;
}

function threadContextOf(note: ReviewThreadNote): string {
  return note.status.trim().toLowerCase() === 'resolved'
    ? REVIEW_RESOLVED_THREAD_CONTEXT
    : REVIEW_NOTE_THREAD_CONTEXT;
}

function validateNoteId(value: string): string {
  const id = value.trim();
  if (!id) {
    throw new Error('Notes require a non-empty stable ID.');
  }
  if (id !== value) {
    throw new Error('Note IDs cannot start or end with whitespace.');
  }
  return id;
}

function cleanLabel(value: string | undefined, fallback: string): string {
  const cleaned = value?.trim();
  return cleaned || fallback;
}

function parseTimestamp(value: Date | string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const timestamp = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp;
}

function commentBodyText(body: string | vscode.MarkdownString): string {
  return typeof body === 'string' ? body : body.value;
}

function isExactDocumentRange(document: vscode.TextDocument, range: vscode.Range): boolean {
  const validated = document.validateRange(range);
  return validated.start.isEqual(range.start) && validated.end.isEqual(range.end);
}

function workspaceRelativeUriPath(uri: vscode.Uri, root: vscode.Uri): string | undefined {
  if (uri.scheme === 'file') {
    const relative = path.relative(root.fsPath, uri.fsPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return undefined;
    }
    return normalizeRelativePath(relative);
  }

  const relative = path.posix.relative(root.path, uri.path);
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    return undefined;
  }
  return normalizeRelativePath(relative);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
