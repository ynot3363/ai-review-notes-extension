import { randomUUID } from 'node:crypto';

import * as vscode from 'vscode';

import {
  BUILT_IN_STATUSES,
  createTextAnchor,
  reconcileTextAnchor,
  type NoteRange,
  type ReviewNoteStore,
  type StoredReviewNote,
} from '../core';
import { createPathFilter, DEFAULT_SCAN_EXCLUDES } from './pathUtils';
import {
  ReviewNoteRepository,
  resolveUriWithinRoot,
  type ConditionalReviewNoteUpdate,
  type ReviewNoteRepositoryLike,
  type ReviewNoteRepositoryOptions,
  type ReviewNoteStorageMode,
} from './reviewNoteRepository';
import type { ReviewNoteView } from './reviewNoteView';
import { reconcileDocumentSymbol, type ResolvedDocumentSymbol } from './symbolResolver';
import { getWorkspaceRelativePath } from './workspaceScanner';

export interface ReviewNoteManagerIssue {
  readonly message: string;
  readonly uri?: vscode.Uri;
}

export interface ReviewNoteManagerResult {
  readonly notes: readonly ReviewNoteView[];
  readonly issues: readonly ReviewNoteManagerIssue[];
}

export interface ClearAllReviewNotesResult {
  readonly deletedCount: number;
  readonly skippedCount: number;
}

export interface CreateStoredReviewNoteInput {
  readonly document: vscode.TextDocument;
  readonly range: vscode.Range;
  readonly body: string;
  readonly category: string;
  readonly status: string;
  readonly anchorKind?: 'line' | 'range' | 'symbol';
  readonly symbol?: ResolvedDocumentSymbol;
  readonly id?: string;
  readonly createdAt?: string;
}

interface RepositoryBinding {
  readonly folder: vscode.WorkspaceFolder;
  readonly mode: ReviewNoteStorageMode;
  readonly sharedFile: string;
  readonly repository: ReviewNoteRepositoryLike;
}

export type ReviewNoteRepositoryFactory = (
  options: ReviewNoteRepositoryOptions,
) => ReviewNoteRepositoryLike;

export class ReviewNoteConflictError extends Error {
  public constructor(id: string) {
    super(
      `Note ${id} changed or was deleted outside Coding Notes for AI. The latest version was reloaded; retry the action.`,
    );
    this.name = 'ReviewNoteConflictError';
  }
}

export interface ManagedReviewNote {
  readonly note: StoredReviewNote;
  readonly binding: RepositoryBinding;
  readonly view: ReviewNoteView;
}

interface ResolvedStoredNote {
  readonly note: StoredReviewNote;
  readonly viewRange: NoteRange;
  readonly persist: boolean;
}

const DEFAULT_SHARED_FILE = 'CODING_NOTES_FOR_AI.json';

/** Coordinates per-root stores and turns durable records into editor views. */
export class ReviewNoteManager implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly entries = new Map<string, ManagedReviewNote>();
  private repositories = new Map<string, RepositoryBinding>();
  private notes: readonly ReviewNoteView[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private operationTail: Promise<void> = Promise.resolve();

  public readonly onDidChange = this.changeEmitter.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly repositoryFactory: ReviewNoteRepositoryFactory = (options) =>
      new ReviewNoteRepository(options),
  ) {}

  public getNotes(): readonly ReviewNoteView[] {
    return this.notes;
  }

  /** Shared JSON stores currently configured for the open workspace roots. */
  public getSharedStoreUris(): readonly vscode.Uri[] {
    return [...this.repositories.values()]
      .filter(({ mode }) => mode === 'workspace')
      .map(({ repository }) => repository.storeUri);
  }

  public getEntry(id: string): ManagedReviewNote | undefined {
    return this.entries.get(id.toLowerCase());
  }

  public refresh(): Promise<ReviewNoteManagerResult> {
    return this.enqueueOperation(() => this.refreshDirect());
  }

  private async refreshDirect(): Promise<ReviewNoteManagerResult> {
    const issues: ReviewNoteManagerIssue[] = [];
    const entries = new Map<string, ManagedReviewNote>();
    const notes: ReviewNoteView[] = [];
    const seenIds = new Set<string>();
    const documentCache = new Map<string, Promise<vscode.TextDocument | undefined>>();
    this.repositories = this.createRepositoryBindings(issues);

    for (const binding of this.repositories.values()) {
      let store: ReviewNoteStore;
      try {
        store = await binding.repository.load();
      } catch (error) {
        issues.push({
          uri: binding.repository.storeUri,
          message: `Could not load notes: ${errorMessage(error)}`,
        });
        continue;
      }

      const resolutionUpdates: ConditionalReviewNoteUpdate[] = [];
      for (const original of store.notes) {
        if (seenIds.has(original.id)) {
          issues.push({
            uri: binding.repository.storeUri,
            message: `Duplicate note ID ${original.id} was ignored outside its first workspace store.`,
          });
          continue;
        }
        seenIds.add(original.id);

        let resolved: ResolvedStoredNote;
        try {
          resolved = await this.resolveStoredNote(binding, original, documentCache);
        } catch (error) {
          issues.push({
            uri: binding.repository.storeUri,
            message: `Could not resolve note ${original.id}: ${errorMessage(error)}`,
          });
          resolved = {
            note: {
              ...original,
              resolution: { state: 'orphaned', reason: 'source-unavailable' },
            },
            viewRange: original.anchor.range,
            persist: true,
          };
        }

        const storedNote = resolved.persist ? resolved.note : original;
        if (resolved.persist && !notesEqual(original, storedNote)) {
          resolutionUpdates.push({ before: original, after: storedNote });
        }
        const view = toReviewNoteView(binding, resolved.note, resolved.viewRange);
        const entry = { note: storedNote, binding, view };
        entries.set(original.id, entry);
        notes.push(view);
      }

      if (resolutionUpdates.length > 0) {
        try {
          const merge = await binding.repository.mergeIfUnchanged(store, resolutionUpdates);
          if (merge.skippedCount > 0) {
            issues.push({
              uri: binding.repository.storeUri,
              message: `${merge.skippedCount} automatic anchor update${merge.skippedCount === 1 ? '' : 's'} skipped because the store changed externally.`,
            });
          }
          if (merge.externalDivergence) {
            this.scheduleRefresh();
          }
        } catch (error) {
          issues.push({
            uri: binding.repository.storeUri,
            message: `Resolved note locations could not be persisted: ${errorMessage(error)}`,
          });
        }
      }
    }

    notes.sort(compareViews);
    this.entries.clear();
    for (const [id, entry] of entries) {
      this.entries.set(id, entry);
    }
    this.notes = notes;
    this.writeIssues(issues);
    return { notes, issues };
  }

  public createNote(input: CreateStoredReviewNoteInput): Promise<ReviewNoteView> {
    return this.enqueueOperation(() => this.createNoteDirect(input));
  }

  private async createNoteDirect(input: CreateStoredReviewNoteInput): Promise<ReviewNoteView> {
    const body = input.body;
    if (!body.trim()) {
      throw new TypeError('A note must contain text.');
    }
    if (!this.isEligibleDocument(input.document)) {
      throw new Error('Notes can only be attached to eligible workspace text files.');
    }

    const folder = vscode.workspace.getWorkspaceFolder(input.document.uri);
    if (!folder) {
      throw new Error('Save this file inside a workspace before adding a note.');
    }
    const binding = this.getOrCreateBinding(folder);
    const relativePath = getWorkspaceRelativePath(input.document.uri, folder);
    if (relativePath === undefined || relativePath.length === 0) {
      throw new Error('Could not determine a safe workspace-relative path for this file.');
    }

    const requestedRange = input.document.validateRange(input.range);
    const range = normalizeCreationRange(input.document, requestedRange);
    const anchorKind = input.anchorKind ?? (requestedRange.isEmpty ? 'line' : 'range');
    if (anchorKind === 'symbol' && !input.symbol) {
      throw new Error('The active language service did not provide a symbol at this location.');
    }
    const timestamp = normalizeTimestamp(input.createdAt);
    const id = input.id ?? randomUUID();
    if (this.entries.has(id.toLowerCase())) {
      throw new Error(`A note with ID ${id} already exists.`);
    }
    const note: StoredReviewNote = {
      id,
      relativePath,
      anchorKind,
      category: input.category,
      status: normalizeStatus(input.status),
      body,
      createdAt: timestamp,
      updatedAt: timestamp,
      anchor: createTextAnchor(
        input.document.getText(),
        toNoteRange(anchorKind === 'symbol' ? input.symbol!.selectionRange : range),
      ),
      ...(input.symbol ? { symbol: input.symbol.descriptor } : {}),
      resolution: { state: 'attached' },
    };

    const inserted = await binding.repository.compareAndSwap(undefined, note);
    if (!inserted.applied) {
      await this.refreshDirect();
      throw new ReviewNoteConflictError(note.id);
    }
    await this.refreshDirect();
    const created = this.entries.get(note.id.toLowerCase())?.view;
    if (!created) {
      throw new Error('The note was saved but could not be reloaded.');
    }
    return created;
  }

  public updateBody(id: string, body: string, expectedBody?: string): Promise<ReviewNoteView> {
    return this.enqueueOperation(() => {
      if (!body.trim()) {
        throw new TypeError('A note must contain text.');
      }
      if (expectedBody !== undefined && this.requireEntry(id).note.body !== expectedBody) {
        throw new ReviewNoteConflictError(id);
      }
      return this.updateNoteDirect(id, (note) => ({
        ...note,
        body,
        updatedAt: nextTimestamp(note),
      }));
    });
  }

  public updateCategory(id: string, category: string): Promise<ReviewNoteView> {
    return this.enqueueOperation(() => {
      const normalizedCategory = category.trim();
      if (!normalizedCategory) {
        throw new TypeError('A note category must contain text.');
      }
      if (normalizedCategory.length > 1_024) {
        throw new TypeError('A note category cannot exceed 1024 characters.');
      }
      const entry = this.requireEntry(id);
      if (entry.note.category === normalizedCategory) {
        return Promise.resolve(entry.view);
      }
      return this.updateNoteDirect(id, (note) => ({
        ...note,
        category: normalizedCategory,
        updatedAt: nextTimestamp(note),
      }));
    });
  }

  public resolveNote(id: string): Promise<ReviewNoteView> {
    return this.enqueueOperation(() =>
      this.updateNoteDirect(id, (note) => ({
        ...note,
        status: 'resolved',
        updatedAt: nextTimestamp(note),
      })),
    );
  }

  public reopenNote(id: string): Promise<ReviewNoteView> {
    return this.enqueueOperation(() =>
      this.updateNoteDirect(id, (note) => ({
        ...note,
        status: 'open',
        updatedAt: nextTimestamp(note),
      })),
    );
  }

  public deleteNote(id: string): Promise<boolean> {
    return this.enqueueOperation(() => this.deleteNoteDirect(id));
  }

  /** Capture both record values and their original repositories before confirmation. */
  public captureClearAllSnapshot(): readonly ManagedReviewNote[] {
    return [...this.entries.values()];
  }

  /** Delete only the confirmed snapshot, preserving additions and changed records. */
  public clearAllNotes(
    snapshot: readonly ManagedReviewNote[] = this.captureClearAllSnapshot(),
  ): Promise<ClearAllReviewNotesResult> {
    const confirmed = [...snapshot];
    return this.enqueueOperation(async () => {
      let deletedCount = 0;
      let skippedCount = 0;
      for (const entry of confirmed) {
        const result = await entry.binding.repository.compareAndSwap(entry.note, undefined);
        if (result.applied) {
          deletedCount += 1;
        } else {
          skippedCount += 1;
        }
      }
      await this.refreshDirect();
      return { deletedCount, skippedCount };
    });
  }

  private async deleteNoteDirect(id: string): Promise<boolean> {
    const entry = this.requireEntry(id);
    const result = await entry.binding.repository.compareAndSwap(entry.note, undefined);
    if (!result.applied) {
      await this.refreshDirect();
      throw new ReviewNoteConflictError(entry.note.id);
    }
    await this.refreshDirect();
    return true;
  }

  public moveNote(
    id: string,
    document: vscode.TextDocument,
    range: vscode.Range,
    symbol?: ResolvedDocumentSymbol,
  ): Promise<ReviewNoteView> {
    return this.enqueueOperation(() => this.moveNoteDirect(id, document, range, symbol));
  }

  private async moveNoteDirect(
    id: string,
    document: vscode.TextDocument,
    range: vscode.Range,
    symbol?: ResolvedDocumentSymbol,
  ): Promise<ReviewNoteView> {
    if (!this.isEligibleDocument(document)) {
      throw new Error('Select an eligible workspace text file before moving this note.');
    }
    const entry = this.requireEntry(id);
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
      throw new Error('The selected document is not inside a workspace folder.');
    }
    const targetBinding = this.getOrCreateBinding(folder);
    const relativePath = getWorkspaceRelativePath(document.uri, folder);
    if (!relativePath) {
      throw new Error('Could not determine the selected document path.');
    }
    const requestedRange = document.validateRange(range);
    const normalizedRange = normalizeCreationRange(document, requestedRange);
    const { symbol: _previousSymbol, ...noteWithoutSymbol } = entry.note;
    const updated: StoredReviewNote = {
      ...noteWithoutSymbol,
      relativePath,
      anchorKind: symbol ? 'symbol' : requestedRange.isEmpty ? 'line' : 'range',
      anchor: createTextAnchor(
        document.getText(),
        toNoteRange(symbol?.selectionRange ?? normalizedRange),
      ),
      ...(symbol ? { symbol: symbol.descriptor } : {}),
      resolution: { state: 'attached' },
      updatedAt: nextTimestamp(entry.note),
    };

    if (!(await this.moveNoteIfUnchanged(entry, targetBinding, updated))) {
      await this.refreshDirect();
      throw new ReviewNoteConflictError(entry.note.id);
    }
    await this.refreshDirect();
    return this.requireEntry(updated.id).view;
  }

  public isEligibleDocument(document: vscode.TextDocument): boolean {
    if (document.isClosed || document.isUntitled) {
      return false;
    }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
      return false;
    }
    const relativePath = getWorkspaceRelativePath(document.uri, folder);
    if (!relativePath) {
      return false;
    }
    let binding: RepositoryBinding;
    try {
      binding = this.getOrCreateBinding(folder);
    } catch {
      return false;
    }
    if (document.uri.toString() === binding.repository.storeUri.toString()) {
      return false;
    }
    const exclude = cleanGlobList(
      vscode.workspace
        .getConfiguration('codingNotesForAi.files', document.uri)
        .get<readonly string[]>('exclude', DEFAULT_SCAN_EXCLUDES),
    );
    return createPathFilter({ include: ['**/*'], exclude })(relativePath);
  }

  public startWatching(): vscode.Disposable {
    if (this.disposables.length > 0) {
      return new vscode.Disposable(() => undefined);
    }
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => this.scheduleRefreshForUri(uri)),
      watcher.onDidChange((uri) => this.scheduleRefreshForUri(uri)),
      watcher.onDidDelete((uri) => this.scheduleRefreshForUri(uri)),
      vscode.workspace.onDidSaveTextDocument((document) =>
        this.scheduleRefreshForUri(document.uri),
      ),
      vscode.workspace.onDidRenameFiles((event) => {
        void this.enqueueOperation(() => this.handleRenames(event.files)).catch(
          (error: unknown) => {
            this.output.appendLine(`Rename handling failed: ${errorMessage(error)}`);
            this.scheduleRefresh();
          },
        );
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('codingNotesForAi.storage') ||
          event.affectsConfiguration('codingNotesForAi.files')
        ) {
          this.scheduleRefresh();
        }
      }),
    );
    return new vscode.Disposable(() => this.stopWatching());
  }

  public dispose(): void {
    this.stopWatching();
    this.changeEmitter.dispose();
  }

  private async updateNoteDirect(
    id: string,
    update: (note: StoredReviewNote) => StoredReviewNote,
  ): Promise<ReviewNoteView> {
    const entry = this.requireEntry(id);
    const updated = update(entry.note);
    if (!(await this.moveNoteIfUnchanged(entry, entry.binding, updated))) {
      await this.refreshDirect();
      throw new ReviewNoteConflictError(entry.note.id);
    }
    await this.refreshDirect();
    return this.requireEntry(updated.id).view;
  }

  /**
   * Replace a note in place, or move it between per-root stores, without
   * overwriting a same-UUID record that changed after the manager's snapshot.
   * A cross-store insertion is rolled back when the source compare fails.
   */
  private async moveNoteIfUnchanged(
    entry: ManagedReviewNote,
    targetBinding: RepositoryBinding,
    updated: StoredReviewNote,
  ): Promise<boolean> {
    const sourceRepository = entry.binding.repository;
    const targetRepository = targetBinding.repository;
    if (sourceRepository.storeUri.toString() === targetRepository.storeUri.toString()) {
      const result = await sourceRepository.compareAndSwap(entry.note, updated);
      return result.applied;
    }

    const inserted = await targetRepository.compareAndSwap(undefined, updated);
    if (!inserted.applied) {
      return false;
    }
    const removed = await sourceRepository.compareAndSwap(entry.note, undefined);
    if (removed.applied) {
      return true;
    }

    const rollback = await targetRepository.compareAndSwap(updated, undefined);
    if (!rollback.applied) {
      this.output.appendLine(
        `[warning] ${targetRepository.storeUri.toString()}: Could not roll back conflicted move of note ${entry.note.id}; both stores were left unchanged by further automatic writes.`,
      );
    }
    return false;
  }

  private requireEntry(id: string): ManagedReviewNote {
    const entry = this.entries.get(id.toLowerCase());
    if (!entry) {
      throw new Error(`Note ${id} is no longer available.`);
    }
    return entry;
  }

  private createRepositoryBindings(
    issues: ReviewNoteManagerIssue[],
  ): Map<string, RepositoryBinding> {
    const bindings = new Map<string, RepositoryBinding>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const binding = this.createBinding(folder);
        bindings.set(folder.uri.toString(), binding);
      } catch (error) {
        issues.push({
          uri: folder.uri,
          message: `Note storage is unavailable: ${errorMessage(error)}`,
        });
      }
    }
    return bindings;
  }

  private createBinding(folder: vscode.WorkspaceFolder): RepositoryBinding {
    const configuration = vscode.workspace.getConfiguration('codingNotesForAi.storage', folder.uri);
    const configuredMode = configuration.get<string>('mode', 'shared');
    const mode: ReviewNoteStorageMode = configuredMode === 'private' ? 'private' : 'workspace';
    const sharedFile = configuration.get<string>('sharedFile', DEFAULT_SHARED_FILE).trim();
    const repository =
      mode === 'workspace'
        ? this.repositoryFactory({
            workspaceFolder: folder,
            mode,
            sharedFile: sharedFile || DEFAULT_SHARED_FILE,
          })
        : this.repositoryFactory({
            workspaceFolder: folder,
            mode,
            storageUri:
              this.context.storageUri ??
              (() => {
                throw new Error('VS Code did not provide private workspace storage.');
              })(),
          });
    return { folder, mode, sharedFile: sharedFile || DEFAULT_SHARED_FILE, repository };
  }

  private getOrCreateBinding(folder: vscode.WorkspaceFolder): RepositoryBinding {
    const key = folder.uri.toString();
    const existing = this.repositories.get(key);
    if (existing) {
      return existing;
    }
    const binding = this.createBinding(folder);
    this.repositories.set(key, binding);
    return binding;
  }

  private async resolveStoredNote(
    binding: RepositoryBinding,
    original: StoredReviewNote,
    documentCache: Map<string, Promise<vscode.TextDocument | undefined>>,
  ): Promise<ResolvedStoredNote> {
    const uri = resolveUriWithinRoot(binding.folder.uri, original.relativePath);
    const document = await getDocument(uri, documentCache);
    if (!document) {
      return {
        note: {
          ...original,
          resolution: { state: 'orphaned', reason: 'source-unavailable' },
        },
        viewRange: original.anchor.range,
        persist: true,
      };
    }

    const source = document.getText();
    const reconciliation = reconcileTextAnchor(source, original.anchor);
    if (reconciliation.state === 'attached') {
      const anchor = reconciliation.relocated
        ? createTextAnchor(source, reconciliation.range)
        : original.anchor;
      return {
        note: { ...original, anchor, resolution: { state: 'attached' } },
        viewRange: reconciliation.range,
        persist: !document.isDirty,
      };
    }

    if (original.anchorKind === 'symbol' && original.symbol) {
      const symbol = await reconcileDocumentSymbol(document, original.symbol);
      if (symbol.state === 'matched') {
        const range = toNoteRange(symbol.symbol.selectionRange);
        return {
          note: {
            ...original,
            anchor: createTextAnchor(source, range),
            symbol: symbol.symbol.descriptor,
            resolution: { state: 'attached' },
          },
          viewRange: range,
          persist: !document.isDirty,
        };
      }
      if (symbol.state === 'ambiguous') {
        return {
          note: {
            ...original,
            resolution: { state: 'ambiguous', candidateCount: symbol.candidateCount },
          },
          viewRange: original.anchor.range,
          persist: !document.isDirty,
        };
      }
    }

    const resolution =
      reconciliation.state === 'ambiguous'
        ? { state: 'ambiguous' as const, candidateCount: reconciliation.candidateCount }
        : { state: 'orphaned' as const, reason: reconciliation.reason };
    return {
      note: { ...original, resolution },
      viewRange: original.anchor.range,
      persist: !document.isDirty,
    };
  }

  private async handleRenames(
    renames: readonly { readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }[],
  ): Promise<void> {
    let conflicts = 0;
    for (const { oldUri, newUri } of renames) {
      const affected = [...this.entries.values()].filter(({ view }) =>
        isUriEqualOrDescendant(view.uri, oldUri),
      );
      for (const entry of affected) {
        const suffix = uriDescendantSuffix(entry.view.uri, oldUri);
        const targetUri = suffix ? vscode.Uri.joinPath(newUri, ...suffix.split('/')) : newUri;
        const targetFolder = vscode.workspace.getWorkspaceFolder(targetUri);
        if (!targetFolder) {
          continue;
        }
        const relativePath = getWorkspaceRelativePath(targetUri, targetFolder);
        if (!relativePath) {
          continue;
        }
        const targetBinding = this.getOrCreateBinding(targetFolder);
        const updated = {
          ...entry.note,
          relativePath,
          updatedAt: nextTimestamp(entry.note),
        };
        if (!(await this.moveNoteIfUnchanged(entry, targetBinding, updated))) {
          conflicts += 1;
        }
      }
    }
    await this.refreshDirect();
    if (conflicts > 0) {
      this.output.appendLine(
        `[warning] ${conflicts} note rename update${conflicts === 1 ? '' : 's'} skipped because the stored note changed externally; the latest version was reloaded.`,
      );
    }
    this.changeEmitter.fire();
  }

  private scheduleRefreshForUri(uri: vscode.Uri): void {
    if (this.isStoreUri(uri) || this.hasNoteForUri(uri)) {
      this.scheduleRefresh();
    }
  }

  private isStoreUri(uri: vscode.Uri): boolean {
    const value = uri.toString();
    return [...this.repositories.values()].some(
      ({ repository }) => repository.storeUri.toString() === value,
    );
  }

  private hasNoteForUri(uri: vscode.Uri): boolean {
    const value = uri.toString();
    return [...this.entries.values()].some(({ view }) => view.uri.toString() === value);
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.changeEmitter.fire();
    }, 250);
  }

  private stopWatching(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private writeIssues(issues: readonly ReviewNoteManagerIssue[]): void {
    for (const issue of issues) {
      this.output.appendLine(
        `[warning]${issue.uri ? ` ${issue.uri.toString()}` : ''}: ${issue.message}`,
      );
    }
  }
}

function toReviewNoteView(
  binding: RepositoryBinding,
  note: StoredReviewNote,
  range: NoteRange,
): ReviewNoteView {
  const uri = resolveUriWithinRoot(binding.folder.uri, note.relativePath);
  const vscodeRange = toVscodeRange(range);
  return {
    workspaceFolder: binding.folder.name,
    relativePath: note.relativePath,
    startLine: vscodeRange.start.line + 1,
    endLine: inclusiveEndLine(vscodeRange),
    id: note.id,
    category: note.category,
    status: note.status,
    comment: note.body,
    uri,
    workspaceFolderUri: binding.folder.uri,
    storeUri: binding.repository.storeUri,
    range: vscodeRange,
    anchorState: note.resolution.state,
    anchorKind: note.anchorKind,
    ...(note.symbol ? { symbolLabel: note.symbol.name } : {}),
    storageMode: binding.mode === 'private' ? 'private' : 'shared',
    updatedAt: note.updatedAt,
  };
}

function normalizeCreationRange(
  document: vscode.TextDocument,
  requested: vscode.Range,
): vscode.Range {
  const range = document.validateRange(requested);
  return range.isEmpty ? document.lineAt(range.start.line).range : range;
}

function toNoteRange(range: vscode.Range): NoteRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function toVscodeRange(range: NoteRange): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

function inclusiveEndLine(range: vscode.Range): number {
  if (range.end.line > range.start.line && range.end.character === 0) {
    return range.end.line;
  }
  return range.end.line + 1;
}

function normalizeStatus(value: string): string {
  return (BUILT_IN_STATUSES as readonly string[]).includes(value) ? value : 'open';
}

function normalizeTimestamp(value: string | undefined): string {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date().toISOString();
}

function nextTimestamp(note: StoredReviewNote): string {
  const now = new Date().toISOString();
  return now < note.createdAt ? note.createdAt : now;
}

function notesEqual(left: StoredReviewNote, right: StoredReviewNote): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function getDocument(
  uri: vscode.Uri,
  cache: Map<string, Promise<vscode.TextDocument | undefined>>,
): Promise<vscode.TextDocument | undefined> {
  const key = uri.toString();
  let result = cache.get(key);
  if (!result) {
    result = Promise.resolve(vscode.workspace.openTextDocument(uri)).then(
      (document) => document,
      () => undefined,
    );
    cache.set(key, result);
  }
  return result;
}

function cleanGlobList(values: readonly unknown[]): string[] {
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
}

function compareViews(left: ReviewNoteView, right: ReviewNoteView): number {
  return (
    left.workspaceFolder.localeCompare(right.workspaceFolder) ||
    left.relativePath.localeCompare(right.relativePath) ||
    left.startLine - right.startLine ||
    left.id.localeCompare(right.id)
  );
}

function isUriEqualOrDescendant(candidate: vscode.Uri, root: vscode.Uri): boolean {
  return (
    candidate.scheme === root.scheme &&
    candidate.authority === root.authority &&
    (candidate.path === root.path || candidate.path.startsWith(`${root.path.replace(/\/$/, '')}/`))
  );
}

function uriDescendantSuffix(candidate: vscode.Uri, root: vscode.Uri): string {
  if (candidate.path === root.path) {
    return '';
  }
  return candidate.path.slice(root.path.replace(/\/$/, '').length + 1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
