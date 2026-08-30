import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import {
  findDuplicateReviewIds,
  parseReviewComments,
  type ReviewComment,
  type ReviewDiagnostic,
} from '../core';
import {
  createPathFilter,
  DEFAULT_SCAN_EXCLUDES,
  DEFAULT_SCAN_INCLUDES,
  findContainingWorkspaceRoot,
  inferLanguageIdFromPath,
  isPathInside,
  isProbablyBinary,
  normalizeRelativePath,
  toWorkspaceRelativePath,
} from './pathUtils';

export const DEFAULT_MAX_FILE_SIZE = 1_048_576;
export const DEFAULT_SCAN_DEBOUNCE_MS = 250;

export interface WorkspaceScanConfiguration {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly maxFileSize: number;
}

export interface WorkspaceScannerOptions {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly excludeForFolder?: (folder: vscode.WorkspaceFolder) => readonly string[];
  readonly maxFileSize?: number;
  readonly debounceMs?: number;
}

export interface ScannedReviewComment extends ReviewComment {
  readonly uri: vscode.Uri;
}

export type WorkspaceScanIssueKind =
  'read-error' | 'stat-error' | 'outside-workspace' | 'unsafe-symbolic-link';

export interface WorkspaceScanIssue {
  readonly kind: WorkspaceScanIssueKind;
  readonly uri: vscode.Uri;
  readonly message: string;
}

export interface WorkspaceScanResult {
  readonly comments: ScannedReviewComment[];
  readonly diagnostics: ReviewDiagnostic[];
  readonly issues: WorkspaceScanIssue[];
  readonly scannedFileCount: number;
  readonly skippedFileCount: number;
}

interface MutableScanResult {
  comments: ScannedReviewComment[];
  diagnostics: ReviewDiagnostic[];
  issues: WorkspaceScanIssue[];
  scannedFileCount: number;
  skippedFileCount: number;
}

interface FileScanResult {
  readonly comments: ScannedReviewComment[];
  readonly diagnostics: ReviewDiagnostic[];
  readonly issue?: WorkspaceScanIssue;
  readonly scanned: boolean;
  readonly skipped: boolean;
}

/**
 * Scans every workspace folder and emits a debounced invalidation event when a
 * relevant file changes. The scanner keeps no hidden cache, so each result is a
 * deterministic snapshot of the workspace at scan time.
 */
export class WorkspaceScanner implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly watchDisposables: vscode.Disposable[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private watching = false;
  private disposed = false;

  public readonly onDidChange = this.changeEmitter.event;

  public constructor(private readonly options: WorkspaceScannerOptions = {}) {}

  public async scan(token?: vscode.CancellationToken): Promise<WorkspaceScanResult> {
    const result: MutableScanResult = {
      comments: [],
      diagnostics: [],
      issues: [],
      scannedFileCount: 0,
      skippedFileCount: 0,
    };
    const folders = [...(vscode.workspace.workspaceFolders ?? [])];
    if (folders.length === 0 || token?.isCancellationRequested) {
      return result;
    }

    const configuration = this.getConfiguration();
    const filters = new Map<string, (relativePath: string) => boolean>();
    const uris = await this.findCandidateUris(folders, configuration, token);
    const rootRealPaths = new Map<string, string>();

    await runWithConcurrency(uris, 8, async (uri) => {
      if (token?.isCancellationRequested) {
        return;
      }
      const folder = findContainingWorkspaceFolder(uri, folders);
      if (!folder) {
        result.skippedFileCount += 1;
        result.issues.push({
          kind: 'outside-workspace',
          uri,
          message: 'The file is not inside a current workspace folder.',
        });
        return;
      }
      const relativePath = getWorkspaceRelativePath(uri, folder);
      const folderKey = folder.uri.toString();
      let filter = filters.get(folderKey);
      if (!filter) {
        filter = createPathFilter({
          include: configuration.include,
          exclude: this.getFolderExcludes(folder, configuration.exclude),
        });
        filters.set(folderKey, filter);
      }
      if (relativePath === undefined || !filter(relativePath)) {
        result.skippedFileCount += 1;
        return;
      }

      const fileResult = await this.scanFile(
        uri,
        folder,
        relativePath,
        configuration.maxFileSize,
        rootRealPaths,
      );
      result.comments.push(...fileResult.comments);
      result.diagnostics.push(...fileResult.diagnostics);
      if (fileResult.issue) {
        result.issues.push(fileResult.issue);
      }
      if (fileResult.scanned) {
        result.scannedFileCount += 1;
      }
      if (fileResult.skipped) {
        result.skippedFileCount += 1;
      }
    });

    result.comments.sort(compareScannedComments);
    // Per-file parsing can only see local duplicates. Rebuild duplicate
    // diagnostics after aggregation so IDs are also checked across roots/files.
    result.diagnostics = result.diagnostics.filter(({ kind }) => kind !== 'duplicate-id');
    result.diagnostics.push(...findDuplicateReviewIds(result.comments));
    return result;
  }

  /** Manually invalidate consumers immediately (used by the Refresh command). */
  public refresh(): void {
    if (!this.disposed) {
      this.cancelPendingRefresh();
      this.changeEmitter.fire();
    }
  }

  /** Start file/config/workspace listeners. Calling this more than once is harmless. */
  public startWatching(): vscode.Disposable {
    if (this.watching || this.disposed) {
      return new vscode.Disposable(() => undefined);
    }
    this.watching = true;

    // A broad watcher lets runtime setting changes take effect without tearing
    // down and rebuilding watchers. Event callbacks apply the configured filter.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.watchDisposables.push(
      watcher,
      watcher.onDidCreate((uri) => this.handleFileEvent(uri)),
      watcher.onDidChange((uri) => this.handleFileEvent(uri)),
      watcher.onDidDelete((uri) => this.handleFileEvent(uri)),
    );

    this.watchDisposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => this.handleFileEvent(document.uri)),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length > 0) {
          this.handleFileEvent(event.document.uri);
        }
      }),
      vscode.workspace.onDidOpenTextDocument((document) => this.handleFileEvent(document.uri)),
      vscode.workspace.onDidCloseTextDocument((document) => this.handleFileEvent(document.uri)),
      vscode.workspace.onDidCreateFiles((event) => this.handleFileEvents(event.files)),
      vscode.workspace.onDidDeleteFiles((event) => this.handleFileEvents(event.files)),
      vscode.workspace.onDidRenameFiles((event) => {
        this.handleFileEvents(event.files.flatMap(({ oldUri, newUri }) => [oldUri, newUri]));
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codingNotesForAi.scan')) {
          this.scheduleRefresh();
        }
      }),
    );

    return new vscode.Disposable(() => this.stopWatching());
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelPendingRefresh();
    this.stopWatching();
    this.changeEmitter.dispose();
  }

  private getConfiguration(): WorkspaceScanConfiguration {
    const configuration = vscode.workspace.getConfiguration('codingNotesForAi.scan');
    const include =
      this.options.include ??
      configuration.get<readonly string[]>('include') ??
      DEFAULT_SCAN_INCLUDES;
    const exclude =
      this.options.exclude ??
      configuration.get<readonly string[]>('exclude') ??
      DEFAULT_SCAN_EXCLUDES;
    const configuredMaxSize =
      this.options.maxFileSize ?? configuration.get<number>('maxFileSize') ?? DEFAULT_MAX_FILE_SIZE;

    return {
      include: cleanGlobList(include),
      exclude: cleanGlobList(exclude),
      maxFileSize:
        Number.isFinite(configuredMaxSize) && configuredMaxSize > 0
          ? Math.floor(configuredMaxSize)
          : DEFAULT_MAX_FILE_SIZE,
    };
  }

  private async findCandidateUris(
    folders: readonly vscode.WorkspaceFolder[],
    configuration: WorkspaceScanConfiguration,
    token?: vscode.CancellationToken,
  ): Promise<vscode.Uri[]> {
    const candidates = new Map<string, vscode.Uri>();
    const includeGlobs = configuration.include;
    for (const folder of folders) {
      const excludeGlob = combineGlobs(this.getFolderExcludes(folder, configuration.exclude));
      for (const include of includeGlobs) {
        if (token?.isCancellationRequested) {
          return [...candidates.values()];
        }
        const uris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, include),
          excludeGlob,
        );
        for (const uri of uris) {
          // A child workspace owns files below its root, avoiding duplicates and
          // ensuring the recorded workspaceFolder/relativePath pair is correct.
          if (
            findContainingWorkspaceFolder(uri, folders)?.uri.toString() === folder.uri.toString()
          ) {
            candidates.set(uri.toString(), uri);
          }
        }
      }
    }

    // `findFiles` represents persisted storage. Include open buffers separately
    // so a dirty document is scanned even when its current contents are not on
    // disk yet. The normal path filter and most-specific-root ownership still
    // apply in `scan`.
    for (const document of vscode.workspace.textDocuments) {
      if (findContainingWorkspaceFolder(document.uri, folders)) {
        candidates.set(document.uri.toString(), document.uri);
      }
    }

    return [...candidates.values()];
  }

  private getFolderExcludes(
    folder: vscode.WorkspaceFolder,
    fallback: readonly string[],
  ): readonly string[] {
    return cleanGlobList(this.options.excludeForFolder?.(folder) ?? fallback);
  }

  private async scanFile(
    uri: vscode.Uri,
    folder: vscode.WorkspaceFolder,
    relativePath: string,
    maxFileSize: number,
    rootRealPaths: Map<string, string>,
  ): Promise<FileScanResult> {
    const openDocument = findOpenTextDocument(uri);
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch (error) {
      return failedFile(uri, 'stat-error', `Could not inspect file: ${errorMessage(error)}`);
    }

    if ((stat.type & vscode.FileType.File) === 0) {
      return skippedFile();
    }

    let source: string | undefined;
    if (openDocument) {
      source = openDocument.getText();
      if (Buffer.byteLength(source, 'utf8') > maxFileSize) {
        return skippedFile();
      }
    } else if (stat.size > maxFileSize) {
      return skippedFile();
    }

    if (uri.scheme === 'file') {
      try {
        const rootKey = folder.uri.toString();
        let realRoot = rootRealPaths.get(rootKey);
        if (!realRoot) {
          realRoot = await realpath(folder.uri.fsPath);
          rootRealPaths.set(rootKey, realRoot);
        }
        const realFile = await realpath(uri.fsPath);
        if (!isPathInside(realFile, realRoot)) {
          return failedFile(
            uri,
            'unsafe-symbolic-link',
            'Skipped a symbolic link whose resolved target is outside the workspace folder.',
          );
        }
      } catch (error) {
        return failedFile(uri, 'stat-error', `Could not resolve file path: ${errorMessage(error)}`);
      }
    } else if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
      // Remote providers do not expose a portable realpath API. Skipping is the
      // only way to guarantee that an escaping link is never followed.
      return failedFile(
        uri,
        'unsafe-symbolic-link',
        'Skipped a symbolic link because its remote target could not be verified.',
      );
    }

    if (source === undefined) {
      let bytes: Uint8Array;
      try {
        bytes = await vscode.workspace.fs.readFile(uri);
      } catch (error) {
        return failedFile(uri, 'read-error', `Could not read file: ${errorMessage(error)}`);
      }
      if (isProbablyBinary(bytes)) {
        return skippedFile();
      }
      source = new TextDecoder('utf-8').decode(bytes);
    }

    const languageId = openDocument?.languageId || inferLanguageIdFromPath(uri.path);
    const parsed = parseReviewComments(source, {
      workspaceFolder: folder.name,
      relativePath,
      ...(languageId ? { languageId } : {}),
    });

    return {
      comments: parsed.comments.map((comment) => ({ ...comment, uri })),
      diagnostics: parsed.diagnostics,
      scanned: true,
      skipped: false,
    };
  }

  private handleFileEvents(uris: readonly vscode.Uri[]): void {
    if (uris.some((uri) => this.isRelevantUri(uri))) {
      this.scheduleRefresh();
    }
  }

  private handleFileEvent(uri: vscode.Uri): void {
    if (this.isRelevantUri(uri)) {
      this.scheduleRefresh();
    }
  }

  private isRelevantUri(uri: vscode.Uri): boolean {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = findContainingWorkspaceFolder(uri, folders);
    if (!folder) {
      return false;
    }
    const relativePath = getWorkspaceRelativePath(uri, folder);
    if (relativePath === undefined) {
      return false;
    }
    const configuration = this.getConfiguration();
    return createPathFilter({
      include: configuration.include,
      exclude: this.getFolderExcludes(folder, configuration.exclude),
    })(relativePath);
  }

  private scheduleRefresh(): void {
    if (this.disposed) {
      return;
    }
    this.cancelPendingRefresh();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.changeEmitter.fire();
    }, this.options.debounceMs ?? DEFAULT_SCAN_DEBOUNCE_MS);
  }

  private cancelPendingRefresh(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  private stopWatching(): void {
    for (const disposable of this.watchDisposables.splice(0)) {
      disposable.dispose();
    }
    this.watching = false;
  }
}

/** Return the live editor buffer corresponding to a URI, when one is open. */
export function findOpenTextDocument(
  uri: vscode.Uri,
  documents: readonly vscode.TextDocument[] = vscode.workspace.textDocuments,
): vscode.TextDocument | undefined {
  const key = uri.toString();
  return documents.find((document) => document.uri.toString() === key);
}

/** Find the most-specific matching folder for file and non-file URI schemes. */
export function findContainingWorkspaceFolder(
  uri: vscode.Uri,
  folders: readonly vscode.WorkspaceFolder[],
): vscode.WorkspaceFolder | undefined {
  if (uri.scheme === 'file') {
    const match = findContainingWorkspaceRoot(
      uri.fsPath,
      folders
        .filter((folder) => folder.uri.scheme === 'file')
        .map((folder) => ({ folder, fsPath: folder.uri.fsPath })),
    );
    return match?.folder;
  }

  return folders
    .filter((folder) => folder.uri.scheme === uri.scheme && folder.uri.authority === uri.authority)
    .filter((folder) => isUriPathInside(uri.path, folder.uri.path))
    .sort((left, right) => right.uri.path.length - left.uri.path.length)[0];
}

export function getWorkspaceRelativePath(
  uri: vscode.Uri,
  folder: vscode.WorkspaceFolder,
): string | undefined {
  if (uri.scheme !== folder.uri.scheme || uri.authority !== folder.uri.authority) {
    return undefined;
  }
  if (uri.scheme === 'file') {
    return toWorkspaceRelativePath(uri.fsPath, folder.uri.fsPath);
  }
  if (!isUriPathInside(uri.path, folder.uri.path)) {
    return undefined;
  }
  return normalizeRelativePath(path.posix.relative(folder.uri.path, uri.path));
}

function isUriPathInside(candidatePath: string, rootPath: string): boolean {
  const relative = path.posix.relative(
    path.posix.resolve(rootPath),
    path.posix.resolve(candidatePath),
  );
  return (
    relative === '' ||
    (!relative.startsWith('../') && relative !== '..' && !path.posix.isAbsolute(relative))
  );
}

function combineGlobs(globs: readonly string[]): string | undefined {
  if (globs.length === 0) {
    return undefined;
  }
  return globs.length === 1 ? globs[0] : `{${globs.join(',')}}`;
}

function cleanGlobList(values: readonly string[]): readonly string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function skippedFile(): FileScanResult {
  return { comments: [], diagnostics: [], scanned: false, skipped: true };
}

function failedFile(
  uri: vscode.Uri,
  kind: WorkspaceScanIssueKind,
  message: string,
): FileScanResult {
  return {
    comments: [],
    diagnostics: [],
    issue: { kind, uri, message },
    scanned: false,
    skipped: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareScannedComments(left: ScannedReviewComment, right: ScannedReviewComment): number {
  return (
    left.workspaceFolder.localeCompare(right.workspaceFolder) ||
    left.relativePath.localeCompare(right.relativePath) ||
    left.startLine - right.startLine ||
    left.id.localeCompare(right.id)
  );
}

async function runWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await operation(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
}
