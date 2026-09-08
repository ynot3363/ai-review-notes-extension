import * as vscode from 'vscode';

import { copyReviewPrompt } from './commands/copyReviewPrompt';
import { generateCommentsOutline } from './commands/generateOutline';
import { revealReviewComment } from './commands/reviewSelection';
import {
  ReviewCommentController,
  type NewReviewThreadInput,
  type ReviewThreadNote,
} from './comments/reviewCommentController';
import { BUILT_IN_STATUSES } from './core';
import { addCustomCategory, getSelectableCategories } from './services/categoryOptions';
import { ReviewNoteManager, type ReviewNoteManagerResult } from './services/reviewNoteManager';
import type { ReviewNoteView } from './services/reviewNoteView';
import {
  findEnclosingDocumentSymbol,
  listDocumentSymbols,
  reconcileDocumentSymbol,
  sortDocumentSymbolsByProximity,
  type ResolvedDocumentSymbol,
} from './services/symbolResolver';
import {
  ReviewCommentsTreeProvider,
  unwrapReviewComment,
  type ReviewGroupBy,
  type ReviewTreeElement,
} from './views/reviewCommentsTreeProvider';
import {
  isSymbolCodeLensTarget,
  ReviewSymbolCodeLensProvider,
} from './views/reviewSymbolCodeLensProvider';
import {
  CREATE_SYMBOL_NOTE_COMMAND,
  isSymbolHoverTarget,
  ReviewSymbolHoverProvider,
} from './views/reviewSymbolHoverProvider';
import { ReviewSymbolNoteCodeLensProvider } from './views/reviewSymbolNoteCodeLensProvider';

interface AnchorTarget {
  readonly range: vscode.Range;
  readonly anchorKind: 'line' | 'range' | 'symbol';
  readonly symbol?: ResolvedDocumentSymbol;
}

interface AnchorQuickPickItem extends vscode.QuickPickItem {
  readonly target: AnchorTarget;
}

interface CategoryPickerOptions {
  readonly currentCategory?: string;
  readonly title?: string;
}

interface CategoryQuickPickItem extends vscode.QuickPickItem {
  readonly category?: string;
  readonly custom?: true;
}

interface ReportScopeQuickPickItem extends vscode.QuickPickItem {
  readonly scope: 'open' | 'all';
}

type CreationUiControl = 'lineGutter' | 'symbolCodeLens' | 'symbolHover';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new ReviewCommentsTreeProvider();
  const output = vscode.window.createOutputChannel('Coding Notes for AI');
  const manager = new ReviewNoteManager(context, output);
  const treeView = vscode.window.createTreeView('codingNotesForAi.commentsView', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  const workspaceRef: { current?: ReviewWorkspace } = {};
  const commentUi = new ReviewCommentController(
    {
      createNote: async (input) => {
        const document = await vscode.workspace.openTextDocument(input.uri);
        const symbol = await resolveDraftSymbol(document, input);
        const created = await manager.createNote({
          document,
          range: input.range,
          body: input.body,
          category: input.category ?? readDefaultCategory(input.uri),
          status: input.status ?? readDefaultStatus(input.uri),
          anchorKind: input.anchorKind ?? inferNativeAnchorKind(document, input.range),
          ...(symbol ? { symbol } : {}),
        });
        workspaceRef.current?.synchronize(false);
        return toThreadNote(created);
      },
      updateNote: async ({ id, body, expectedBody }) => {
        const updated = await manager.updateBody(id, body, expectedBody);
        workspaceRef.current?.synchronize(false);
        return toThreadNote(updated);
      },
      deleteNote: async (id) => {
        await manager.deleteNote(id);
        workspaceRef.current?.synchronize(false);
      },
    },
    {
      // Runtime eligibility is configuration-aware and handles shared sidecars.
      include: ['**/*'],
      exclude: [],
      isDocumentEligible: (document) => manager.isEligibleDocument(document),
      isGutterEnabled: (document) => readCreationUiControls(document.uri).has('lineGutter'),
      newNoteDisplay: (uri) => readNewNoteDisplay(uri),
    },
  );

  const symbolNoteCodeLenses = new ReviewSymbolNoteCodeLensProvider();
  const workspace = new ReviewWorkspace(
    manager,
    provider,
    commentUi,
    symbolNoteCodeLenses,
    treeView,
    output,
  );
  const symbolHoverProvider = new ReviewSymbolHoverProvider(
    (document) =>
      manager.isEligibleDocument(document) &&
      readCreationUiControls(document.uri).has('symbolHover'),
    (document, error) => {
      output.appendLine(
        `Could not load symbols for ${document.uri.toString()}: ${errorMessage(error)}`,
      );
    },
  );
  const symbolCodeLenses = new ReviewSymbolCodeLensProvider(
    (document) =>
      manager.isEligibleDocument(document) &&
      readCreationUiControls(document.uri).has('symbolCodeLens'),
    (document, error) => {
      output.appendLine(
        `Could not load symbols for ${document.uri.toString()}: ${errorMessage(error)}`,
      );
    },
  );
  workspaceRef.current = workspace;
  provider.setGroupBy(readGroupBy());

  const run =
    (action: string, callback: (...arguments_: unknown[]) => Promise<void>) =>
    async (...arguments_: unknown[]): Promise<void> => {
      try {
        await callback(...arguments_);
      } catch (error) {
        const message = errorMessage(error);
        output.appendLine(`${action} failed: ${message}`);
        await vscode.window.showErrorMessage(`Coding Notes for AI: ${message}`);
      }
    };

  const createNote = run('Add note', async (argument) => {
    if (isCommentReply(argument)) {
      await commentUi.acceptCommentReply(argument);
      return;
    }
    await openDraft(manager, commentUi, output);
  });

  const moveNote = run('Move note', async (argument) => {
    const id = resolveNoteId(argument, manager, commentUi);
    if (!id) {
      await vscode.window.showWarningMessage('Select a note before moving it.');
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || !manager.isEligibleDocument(editor.document)) {
      await vscode.window.showWarningMessage(
        'Open an eligible workspace text file and select the new target first.',
      );
      return;
    }
    const target = await chooseAnchorTarget(editor, output);
    if (!target) {
      return;
    }
    const updated = await manager.moveNote(id, editor.document, target.range, target.symbol);
    workspace.synchronize();
    await revealReviewComment(updated);
  });

  const createSymbolNote = run('Add symbol note', async (argument) => {
    if (!isSymbolHoverTarget(argument) && !isSymbolCodeLensTarget(argument)) {
      await vscode.window.showWarningMessage('The selected symbol is no longer available.');
      return;
    }
    const document = await vscode.workspace.openTextDocument(
      isSymbolHoverTarget(argument) ? vscode.Uri.parse(argument.uri) : argument.uri,
    );
    if (!manager.isEligibleDocument(document)) {
      await vscode.window.showWarningMessage('A note cannot be added to this document.');
      return;
    }
    let symbol: ResolvedDocumentSymbol;
    if (isSymbolHoverTarget(argument)) {
      const resolved = await reconcileDocumentSymbol(document, argument.descriptor);
      if (resolved.state !== 'matched') {
        await vscode.window.showWarningMessage(
          'The selected symbol changed or is ambiguous. Select it again and retry.',
        );
        return;
      }
      symbol = resolved.symbol;
    } else {
      symbol = argument.symbol;
    }
    const category = await chooseCategory(document.uri);
    if (!category) {
      return;
    }
    const thread = commentUi.createDraft(document, symbol.selectionRange, {
      category,
      status: readDefaultStatus(document.uri),
      anchorKind: 'symbol',
      symbolLabel: symbol.descriptor.name,
    });
    if (!thread) {
      await vscode.window.showWarningMessage('A note cannot be added to this symbol.');
    }
  });

  context.subscriptions.push(
    output,
    treeView,
    provider,
    manager,
    commentUi,
    symbolCodeLenses,
    symbolNoteCodeLenses,
    vscode.languages.registerCodeLensProvider({ language: '*' }, symbolCodeLenses),
    vscode.languages.registerCodeLensProvider({ language: '*' }, symbolNoteCodeLenses),
    vscode.languages.registerHoverProvider({ language: '*' }, symbolHoverProvider),
    manager.startWatching(),
    manager.onDidChange(() => {
      void workspace.refresh(false);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codingNotesForAi.outline.groupBy')) {
        provider.setGroupBy(readGroupBy());
      }
      if (event.affectsConfiguration('codingNotesForAi.creationUi')) {
        symbolCodeLenses.refresh();
      }
    }),
    vscode.commands.registerCommand('codingNotesForAi.createNote', createNote),
    vscode.commands.registerCommand('codingNotesForAi.moveNote', moveNote),
    vscode.commands.registerCommand(CREATE_SYMBOL_NOTE_COMMAND, createSymbolNote),
    vscode.commands.registerCommand(
      'codingNotesForAi.cancelNote',
      run('Cancel note', async (argument) => {
        commentUi.discardDraft(argument);
      }),
    ),
    vscode.commands.registerCommand(
      'codingNotesForAi.replyToNote',
      run('Reply to note', async (argument) => {
        if (isCommentReply(argument)) {
          await commentUi.acceptCommentReply(argument);
          return;
        }
        await vscode.window.showInformationMessage(
          'Each Coding Notes for AI thread contains one finding. Use Edit Note to update it.',
        );
      }),
    ),
    vscode.commands.registerCommand(
      'codingNotesForAi.editNote',
      run('Edit note', async (argument) => {
        const id = resolveNoteId(argument, manager, commentUi);
        if (!id) {
          await vscode.window.showWarningMessage('Select a note before editing it.');
          return;
        }
        const review = unwrapReviewComment(argument);
        if (review?.anchorState === 'attached') {
          await revealReviewComment(review);
        }
        if (commentUi.startEditing(id)) {
          return;
        }
        await vscode.window.showWarningMessage(
          'Reattach this note before editing it in the native multiline editor.',
        );
      }),
    ),
    vscode.commands.registerCommand(
      'codingNotesForAi.saveNoteEdit',
      run('Save note edit', async (argument) => {
        await commentUi.saveEdit(argument);
      }),
    ),
    vscode.commands.registerCommand(
      'codingNotesForAi.cancelNoteEdit',
      run('Cancel note edit', async (argument) => {
        commentUi.cancelEdit(argument);
      }),
    ),
    vscode.commands.registerCommand(
      'codingNotesForAi.changeCategory',
      run('Change note category', async (argument) => {
        const draft = commentUi.getDraftState(argument);
        if (draft) {
          const category = await chooseCategory(draft.uri, {
            title: 'Coding Notes for AI: Select category',
            ...(draft.category ? { currentCategory: draft.category } : {}),
          });
          if (!category) {
            return;
          }
          if (!commentUi.setDraftCategory(argument, category)) {
            await vscode.window.showWarningMessage('This note draft is no longer available.');
          }
          return;
        }

        const id = resolveNoteId(argument, manager, commentUi);
        if (!id) {
          await vscode.window.showWarningMessage('Select a note before changing its category.');
          return;
        }
        const entry = manager.getEntry(id);
        if (!entry) {
          await vscode.window.showWarningMessage('The selected note is no longer available.');
          return;
        }
        const category = await chooseCategory(entry.view.uri, {
          currentCategory: entry.view.category,
          title: 'Coding Notes for AI: Change category',
        });
        if (!category || category === entry.view.category) {
          return;
        }
        await manager.updateCategory(id, category);
        workspace.synchronize();
      }),
    ),
    vscode.commands.registerCommand(
      'codingNotesForAi.deleteNote',
      run('Delete note', async (argument) => {
        const id = resolveNoteId(argument, manager, commentUi);
        if (!id) {
          await vscode.window.showWarningMessage('Select a note before deleting it.');
          return;
        }
        const confirmation = await vscode.window.showWarningMessage(
          'Delete this note? This removes it from the configured note store.',
          { modal: true },
          'Delete',
        );
        if (confirmation !== 'Delete') {
          return;
        }
        await manager.deleteNote(id);
        workspace.synchronize();
      }),
    ),
    vscode.commands.registerCommand(
      'codingNotesForAi.clearAllNotes',
      run('Clear all notes', async () => {
        await workspace.ready();
        const snapshot = manager.captureClearAllSnapshot();
        const count = snapshot.length;
        if (count === 0) {
          await vscode.window.showInformationMessage('There are no coding notes to clear.');
          return;
        }
        const confirmation = await vscode.window.showWarningMessage(
          `Delete all ${count} coding note${count === 1 ? '' : 's'} from this workspace? This cannot be undone.`,
          { modal: true },
          'Delete All Notes',
        );
        if (confirmation !== 'Delete All Notes') {
          return;
        }
        const result = await manager.clearAllNotes(snapshot);
        workspace.synchronize();
        if (result.skippedCount > 0) {
          await vscode.window.showWarningMessage(
            `Deleted ${result.deletedCount} coding note${result.deletedCount === 1 ? '' : 's'}. ${result.skippedCount} note${result.skippedCount === 1 ? '' : 's'} changed or were removed externally and were skipped.`,
          );
          return;
        }
        await vscode.window.showInformationMessage(
          `Deleted ${result.deletedCount} coding note${result.deletedCount === 1 ? '' : 's'}.`,
        );
      }),
    ),
    vscode.commands.registerCommand(
      'codingNotesForAi.resolveNote',
      run('Resolve note', async (argument) => {
        const id = resolveNoteId(argument, manager, commentUi);
        if (!id) {
          await vscode.window.showWarningMessage('Select a note before resolving it.');
          return;
        }
        await manager.resolveNote(id);
        workspace.synchronize();
      }),
    ),
    vscode.commands.registerCommand(
      'codingNotesForAi.reopenNote',
      run('Reopen note', async (argument) => {
        const id = resolveNoteId(argument, manager, commentUi);
        if (!id) {
          await vscode.window.showWarningMessage('Select a resolved note before reopening it.');
          return;
        }
        await manager.reopenNote(id);
        workspace.synchronize();
      }),
    ),
    vscode.commands.registerCommand('codingNotesForAi.reattachNote', moveNote),
    vscode.commands.registerCommand(
      'codingNotesForAi.showComments',
      run('Show notes', async () => {
        await workspace.refresh(false);
        const count = provider.getComments().length;
        try {
          // The generated focus command follows the view if the user moved it to
          // another container, so it is preferable to forcing open Explorer.
          await vscode.commands.executeCommand('codingNotesForAi.commentsView.focus');
          await vscode.window.showInformationMessage(reviewNotesShownMessage(count));
        } catch (error) {
          output.appendLine(`Could not focus the Coding Notes for AI view: ${errorMessage(error)}`);
          await vscode.commands.executeCommand('workbench.view.explorer');
          await vscode.window.showWarningMessage(
            `${reviewNotesShownMessage(count)} The view could not be focused automatically; open Coding Notes for AI in Explorer.`,
          );
        }
      }),
    ),
    vscode.commands.registerCommand('codingNotesForAi.refreshComments', () =>
      workspace.refresh(true),
    ),
    vscode.commands.registerCommand(
      'codingNotesForAi.generateOutline',
      run('Generate and copy AI resolution report', async () => {
        await workspace.refresh(false);
        const scope = await chooseReportScope();
        if (!scope) {
          return;
        }
        const allComments = provider.getComments();
        const comments =
          scope === 'open'
            ? allComments.filter(({ status }) => status !== 'resolved')
            : allComments;
        if (comments.length === 0) {
          await vscode.window.showInformationMessage(
            scope === 'open'
              ? 'There are no open coding notes to include in the report.'
              : 'There are no coding notes to include in the report.',
          );
          return;
        }
        await generateCommentsOutline(comments, manager.getSharedStoreUris());
        await vscode.window.showInformationMessage(
          `Opened and copied an AI resolution report with ${comments.length} note${comments.length === 1 ? '' : 's'}. Paste it into an AI coding agent to begin.`,
        );
      }),
    ),
    vscode.commands.registerCommand(
      'codingNotesForAi.copyPrompt',
      run('Copy AI prompt', async (argument) => {
        await workspace.ready();
        await copyReviewPrompt(resolveReviewArgument(argument, manager, commentUi), () =>
          provider.getComments(),
        );
      }),
    ),
    vscode.commands.registerCommand(
      'codingNotesForAi.revealComment',
      run('Reveal note', async (argument) => {
        const review = unwrapReviewComment(resolveReviewArgument(argument, manager, commentUi));
        if (review) {
          await revealReviewComment(review);
          commentUi.expandNote(review.id);
        }
      }),
    ),
  );

  await workspace.refresh(false);
}

export function deactivate(): void {
  // All extension resources are owned by ExtensionContext.subscriptions.
}

class ReviewWorkspace {
  private refreshQueue: Promise<void> = Promise.resolve();
  private hasLoaded = false;

  public constructor(
    private readonly manager: ReviewNoteManager,
    private readonly provider: ReviewCommentsTreeProvider,
    private readonly commentUi: ReviewCommentController,
    private readonly symbolNoteCodeLenses: ReviewSymbolNoteCodeLensProvider,
    private readonly treeView: vscode.TreeView<ReviewTreeElement>,
    private readonly output: vscode.OutputChannel,
  ) {}

  public refresh(notify: boolean): Promise<void> {
    this.refreshQueue = this.refreshQueue
      .catch(() => undefined)
      .then(async () => {
        this.output.clear();
        try {
          const result = await this.manager.refresh();
          this.acceptResult(result, true);
          if (notify) {
            await vscode.window.showInformationMessage(summaryMessage(result.notes));
          }
        } catch (error) {
          const message = errorMessage(error);
          this.output.appendLine(`Refresh failed: ${message}`);
          if (notify) {
            await vscode.window.showErrorMessage(`Coding Notes for AI refresh failed: ${message}`);
          }
        } finally {
          this.hasLoaded = true;
        }
      });
    return this.refreshQueue;
  }

  public synchronize(updateThreads = true): void {
    this.acceptResult({ notes: this.manager.getNotes(), issues: [] }, updateThreads);
  }

  public async ready(): Promise<void> {
    if (!this.hasLoaded) {
      await this.refresh(false);
      return;
    }
    await this.refreshQueue;
  }

  private acceptResult(result: ReviewNoteManagerResult, updateThreads: boolean): void {
    this.provider.setComments(result.notes);
    this.symbolNoteCodeLenses.setNotes(result.notes);
    if (updateThreads) {
      this.commentUi.replaceNotes(
        result.notes.filter(({ anchorState }) => anchorState === 'attached').map(toThreadNote),
      );
    }

    const detachedCount = result.notes.filter(
      ({ anchorState }) => anchorState !== 'attached',
    ).length;
    const warningCount = result.issues.length + detachedCount;
    this.treeView.message = `${result.notes.length} note${result.notes.length === 1 ? '' : 's'}${warningCount ? ` • ${warningCount} warning${warningCount === 1 ? '' : 's'}` : ''}`;
    void vscode.commands.executeCommand(
      'setContext',
      'codingNotesForAi.hasComments',
      result.notes.length > 0,
    );
    this.output.appendLine(summaryMessage(result.notes));
  }
}

async function openDraft(
  manager: ReviewNoteManager,
  commentUi: ReviewCommentController,
  output: vscode.OutputChannel,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.window.showWarningMessage(
      'Open a workspace text file before adding a coding note.',
    );
    return;
  }
  if (!manager.isEligibleDocument(editor.document)) {
    await vscode.window.showWarningMessage(
      'Coding Notes for AI is disabled for this document or it is outside the workspace.',
    );
    return;
  }

  const category = await chooseCategory(editor.document.uri);
  if (!category) {
    return;
  }
  const target = await chooseAnchorTarget(editor, output);
  if (!target) {
    return;
  }
  const thread = commentUi.createDraft(editor.document, target.range, {
    category,
    status: readDefaultStatus(editor.document.uri),
    anchorKind: target.anchorKind,
    ...(target.symbol ? { symbolLabel: target.symbol.descriptor.name } : {}),
  });
  if (!thread) {
    await vscode.window.showWarningMessage('A note cannot be added to this document.');
  }
}

async function chooseAnchorTarget(
  editor: vscode.TextEditor,
  output: vscode.OutputChannel,
): Promise<AnchorTarget | undefined> {
  const { document, selection } = editor;
  const range = selection.isEmpty ? document.lineAt(selection.active.line).range : selection;
  const symbolProbe = selection.isEmpty
    ? new vscode.Range(selection.active, selection.active)
    : selection;
  const fallback: AnchorTarget = {
    range,
    anchorKind: selection.isEmpty ? 'line' : 'range',
  };

  let symbols: ResolvedDocumentSymbol[] = [];
  try {
    symbols = sortDocumentSymbolsByProximity(await listDocumentSymbols(document), symbolProbe);
  } catch (error) {
    output.appendLine(
      `Document symbols are unavailable for ${document.uri.toString()}: ${errorMessage(error)}`,
    );
  }
  if (symbols.length === 0) {
    return fallback;
  }

  const symbolItems = symbols.map((symbol, index): AnchorQuickPickItem => {
    const symbolContext = symbol.descriptor.containerName
      ? `${symbol.descriptor.kind} in ${symbol.descriptor.containerName}`
      : symbol.descriptor.kind;
    return {
      label: `$(symbol-method) ${symbol.descriptor.name}`,
      description: index === 0 ? `Closest • ${symbolContext}` : symbolContext,
      detail: `Line ${symbol.selectionRange.start.line + 1} • Follows this symbol when the language service can still identify it.`,
      target: { range: symbol.selectionRange, anchorKind: 'symbol', symbol },
    };
  });
  const [closestSymbol, ...remainingSymbols] = symbolItems;
  const chosen = await vscode.window.showQuickPick<AnchorQuickPickItem>(
    [
      closestSymbol!,
      {
        label: selection.isEmpty ? '$(list-selection) Current line' : '$(selection) Selected range',
        description: 'Exact target',
        target: fallback,
      },
      ...remainingSymbols,
    ],
    {
      title: 'Coding Notes for AI: Choose the target',
      placeHolder: 'Choose the exact code or any symbol in this file',
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  return chosen?.target;
}

async function chooseCategory(
  resource: vscode.Uri,
  options: CategoryPickerOptions = {},
): Promise<string | undefined> {
  const configuration = vscode.workspace.getConfiguration('codingNotesForAi', resource);
  const configured = configuration.get<unknown>('categories');
  const defaultCategory = readDefaultCategory(resource);
  const currentCategory = options.currentCategory?.trim();
  const categories = getSelectableCategories(configured, defaultCategory, currentCategory);

  const selected = await vscode.window.showQuickPick<CategoryQuickPickItem>(
    [
      ...categories.map((category): CategoryQuickPickItem => {
        const markers = [
          ...(category === currentCategory ? ['Current'] : []),
          ...(category === defaultCategory ? ['Default'] : []),
        ];
        return {
          label: category,
          category,
          ...(markers.length > 0 ? { description: markers.join(' • ') } : {}),
          picked: category === (currentCategory ?? defaultCategory),
        };
      }),
      {
        label: '$(edit) Custom category…',
        description: 'Enter any category',
        alwaysShow: true,
        custom: true,
      },
    ],
    {
      title: options.title ?? 'Coding Notes for AI: Select a category',
      placeHolder: 'Choose a category or enter your own',
      matchOnDescription: true,
    },
  );
  if (!selected) {
    return undefined;
  }
  if (!selected.custom) {
    return selected.category;
  }

  const custom = await vscode.window.showInputBox({
    title: 'Coding Notes for AI: Custom category',
    prompt: 'Enter a category for this note',
    value: currentCategory ?? '',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) {
        return 'Enter a category.';
      }
      return value.trim().length > 1_024 ? 'Use 1024 characters or fewer.' : undefined;
    },
  });
  const customCategory = custom?.trim();
  if (!customCategory) {
    return undefined;
  }
  if (!categories.includes(customCategory)) {
    await configuration.update(
      'categories',
      addCustomCategory(configured, customCategory),
      categoryConfigurationTarget(configuration),
    );
  }
  return customCategory;
}

function categoryConfigurationTarget(
  configuration: vscode.WorkspaceConfiguration,
): vscode.ConfigurationTarget {
  const inspected = configuration.inspect<unknown>('categories');
  if (inspected?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  if (inspected?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

async function chooseReportScope(): Promise<'open' | 'all' | undefined> {
  const selected = await vscode.window.showQuickPick<ReportScopeQuickPickItem>(
    [
      {
        label: 'Open notes',
        description: 'Exclude resolved notes',
        scope: 'open',
      },
      {
        label: 'All notes',
        description: 'Include resolved notes',
        scope: 'all',
      },
    ],
    {
      title: 'Coding Notes for AI: Choose report scope',
      placeHolder: 'Include open notes only or every note?',
    },
  );
  return selected?.scope;
}

async function resolveDraftSymbol(
  document: vscode.TextDocument,
  input: NewReviewThreadInput,
): Promise<ResolvedDocumentSymbol | undefined> {
  if (input.anchorKind !== 'symbol') {
    return undefined;
  }
  const symbol = await findEnclosingDocumentSymbol(document, input.displayRange ?? input.range);
  if (!symbol || (input.symbolLabel && symbol.descriptor.name !== input.symbolLabel)) {
    throw new Error(
      'The selected symbol is no longer available. Add the note to its range instead.',
    );
  }
  return symbol;
}

function toThreadNote(review: ReviewNoteView): ReviewThreadNote {
  return {
    id: review.id,
    uri: review.uri,
    range: review.range,
    body: review.comment,
    category: review.category,
    status: review.status,
    ...(review.symbolLabel ? { symbolLabel: review.symbolLabel } : {}),
    updatedAt: review.updatedAt,
  };
}

function resolveNoteId(
  argument: unknown,
  manager: ReviewNoteManager,
  commentUi: ReviewCommentController,
): string | undefined {
  const nativeId = commentUi.getNoteId(argument);
  if (nativeId) {
    return nativeId;
  }
  const review = unwrapReviewComment(argument);
  if (review) {
    return review.id;
  }
  if (typeof argument === 'string' && manager.getEntry(argument)) {
    return argument;
  }
  return undefined;
}

function resolveReviewArgument(
  argument: unknown,
  manager: ReviewNoteManager,
  commentUi: ReviewCommentController,
): unknown {
  const id = resolveNoteId(argument, manager, commentUi);
  return id ? (manager.getEntry(id)?.view ?? argument) : argument;
}

function isCommentReply(value: unknown): value is vscode.CommentReply {
  if (typeof value !== 'object' || value === null || !('thread' in value) || !('text' in value)) {
    return false;
  }
  const candidate = value as { readonly thread?: unknown; readonly text?: unknown };
  return (
    typeof candidate.text === 'string' &&
    typeof candidate.thread === 'object' &&
    candidate.thread !== null
  );
}

function readDefaultCategory(resource: vscode.Uri): string {
  const configured = vscode.workspace
    .getConfiguration('codingNotesForAi', resource)
    .get<unknown>('defaultCategory');
  return typeof configured === 'string' && configured.trim() ? configured.trim() : 'General';
}

function inferNativeAnchorKind(
  document: vscode.TextDocument,
  requestedRange: vscode.Range,
): 'line' | 'range' {
  const range = document.validateRange(requestedRange);
  if (range.isEmpty) {
    return 'line';
  }
  const line =
    range.start.line === range.end.line ? document.lineAt(range.start.line).range : undefined;
  return line && line.isEqual(range) ? 'line' : 'range';
}

function readDefaultStatus(resource: vscode.Uri): string {
  const configured = vscode.workspace
    .getConfiguration('codingNotesForAi', resource)
    .get<unknown>('defaultStatus');
  return typeof configured === 'string' &&
    (BUILT_IN_STATUSES as readonly string[]).includes(configured)
    ? configured
    : 'open';
}

function readGroupBy(): ReviewGroupBy {
  const configured = vscode.workspace
    .getConfiguration('codingNotesForAi.outline')
    .get<string>('groupBy', 'file');
  return configured === 'category' || configured === 'status' ? configured : 'file';
}

function readCreationUiControls(resource?: vscode.Uri): ReadonlySet<CreationUiControl> {
  const configured = vscode.workspace
    .getConfiguration('codingNotesForAi', resource)
    .get<unknown>('creationUi');
  const allowed = new Set<CreationUiControl>(['lineGutter', 'symbolCodeLens', 'symbolHover']);
  if (Array.isArray(configured)) {
    return new Set(
      configured.filter(
        (value): value is CreationUiControl =>
          typeof value === 'string' && allowed.has(value as CreationUiControl),
      ),
    );
  }
  return new Set(['lineGutter', 'symbolHover']);
}

function readNewNoteDisplay(resource: vscode.Uri): 'collapse' | 'expanded' {
  const configured = vscode.workspace
    .getConfiguration('codingNotesForAi', resource)
    .get<unknown>('newNoteDisplay');
  return configured === 'expanded' ? 'expanded' : 'collapse';
}

function summaryMessage(notes: readonly ReviewNoteView[]): string {
  const detached = notes.filter(({ anchorState }) => anchorState !== 'attached').length;
  return `Coding Notes for AI loaded ${notes.length} note${notes.length === 1 ? '' : 's'}${detached ? ` (${detached} needs reattachment)` : ''}.`;
}

function reviewNotesShownMessage(count: number): string {
  return `Showing ${count} note${count === 1 ? '' : 's'} in Coding Notes for AI.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
