import assert from 'node:assert/strict';

import * as vscode from 'vscode';

const EXTENSION_ID = 'aepcodes.coding-notes-for-ai';
const CRITICAL_COMMANDS = [
  'codingNotesForAi.createNote',
  'codingNotesForAi.createSymbolNote',
  'codingNotesForAi.cancelNote',
  'codingNotesForAi.replyToNote',
  'codingNotesForAi.editNote',
  'codingNotesForAi.saveNoteEdit',
  'codingNotesForAi.cancelNoteEdit',
  'codingNotesForAi.changeCategory',
  'codingNotesForAi.deleteNote',
  'codingNotesForAi.clearAllNotes',
  'codingNotesForAi.resolveNote',
  'codingNotesForAi.reopenNote',
  'codingNotesForAi.moveNote',
  'codingNotesForAi.reattachNote',
  'codingNotesForAi.showComments',
  'codingNotesForAi.refreshComments',
  'codingNotesForAi.generateOutline',
  'codingNotesForAi.copyPrompt',
] as const;
const REMOVED_ASSISTANT_COMMANDS = [
  'codingNotesForAi.openWith',
  'codingNotesForAi.openInCodex',
  'codingNotesForAi.openInVscodeChat',
  'codingNotesForAi.openInClaudeCode',
] as const;

type TestCallback = () => void | Promise<void>;

const testCases: Array<{ readonly name: string; readonly callback: TestCallback }> = [];
let setupCallback: TestCallback = () => undefined;
let teardownCallback: TestCallback = () => undefined;
let persistedThread: vscode.CommentThread | undefined;
let persistedComment: vscode.Comment | undefined;
let persistedNoteId: string | undefined;

suite('Coding Notes for AI extension', () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Expected ${EXTENSION_ID} to be installed in the Extension Host.`);

    await extension.activate();
    assert.equal(extension.isActive, true, 'The extension should be active after activation.');

    const manifest = extension.packageJSON as {
      capabilities?: { untrustedWorkspaces?: { supported?: unknown } };
    };
    assert.equal(
      manifest.capabilities?.untrustedWorkspaces?.supported,
      'limited',
      'The extension should remain available with limited functionality in Restricted Mode.',
    );
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test('registers every critical public command', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = CRITICAL_COMMANDS.filter((command) => !registered.has(command));
    const obsolete = REMOVED_ASSISTANT_COMMANDS.filter((command) => registered.has(command));

    assert.deepEqual(missing, [], `Missing registered commands: ${missing.join(', ')}`);
    assert.deepEqual(obsolete, [], `Obsolete assistant commands remain: ${obsolete.join(', ')}`);
    assert.equal(
      registered.has('codingNotesForAi.importInlineComments'),
      false,
      'The removed legacy import command must not be registered.',
    );
  });

  test('contributes draft category, copy, resolve, and unresolved thread actions', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    const manifest = extension.packageJSON as {
      contributes?: {
        commands?: Array<{ command?: string; icon?: string }>;
        menus?: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
        configuration?: {
          properties?: Record<string, { default?: unknown }>;
        };
      };
    };
    const copyCommand = manifest.contributes?.commands?.find(
      ({ command }) => command === 'codingNotesForAi.copyPrompt',
    );
    const threadTitleEntries = manifest.contributes?.menus?.['comments/commentThread/title'] ?? [];
    const threadContextEntries =
      manifest.contributes?.menus?.['comments/commentThread/context'] ?? [];
    const treeItemEntries = manifest.contributes?.menus?.['view/item/context'] ?? [];
    const viewTitleEntries = manifest.contributes?.menus?.['view/title'] ?? [];
    const copyEntries = threadTitleEntries.filter(
      ({ command }) => command === 'codingNotesForAi.copyPrompt',
    );
    const resolveEntry = threadTitleEntries.find(
      ({ command }) => command === 'codingNotesForAi.resolveNote',
    );
    const reopenCommand = manifest.contributes?.commands?.find(
      ({ command }) => command === 'codingNotesForAi.reopenNote',
    );
    const moveCommand = manifest.contributes?.commands?.find(
      ({ command }) => command === 'codingNotesForAi.moveNote',
    );
    const reportCommand = manifest.contributes?.commands?.find(
      ({ command }) => command === 'codingNotesForAi.generateOutline',
    );
    const reportViewTitleEntry = viewTitleEntries.find(
      ({ command }) => command === 'codingNotesForAi.generateOutline',
    );
    const reopenEntry = threadTitleEntries.find(
      ({ command }) => command === 'codingNotesForAi.reopenNote',
    );
    const draftCategoryEntry = threadContextEntries.find(
      ({ command, when }) =>
        command === 'codingNotesForAi.changeCategory' && when?.includes('commentThreadIsEmpty'),
    );
    const submitDraftEntry = threadContextEntries.find(
      ({ command, when }) =>
        command === 'codingNotesForAi.createNote' && when?.includes('commentThreadIsEmpty'),
    );
    const configuredCategories =
      manifest.contributes?.configuration?.properties?.['codingNotesForAi.categories']?.default;
    const creationUiDefault =
      manifest.contributes?.configuration?.properties?.['codingNotesForAi.creationUi']?.default;
    const newNoteDisplayDefault =
      manifest.contributes?.configuration?.properties?.['codingNotesForAi.newNoteDisplay']?.default;
    const clearAllCommand = manifest.contributes?.commands?.find(
      ({ command }) => command === 'codingNotesForAi.clearAllNotes',
    );
    const clearAllViewTitleEntry = viewTitleEntries.find(
      ({ command }) => command === 'codingNotesForAi.clearAllNotes',
    );
    const treeReopenEntries = treeItemEntries.filter(
      ({ command }) => command === 'codingNotesForAi.reopenNote',
    );
    const treeMoveEntries = treeItemEntries.filter(
      ({ command }) => command === 'codingNotesForAi.moveNote',
    );

    assert.equal(copyCommand?.icon, '$(copy)');
    assert.deepEqual(
      new Set(copyEntries.map(({ when, group }) => `${when}::${group}`)),
      new Set([
        'commentController == codingNotesForAi && commentThread == open::navigation@1',
        'commentController == codingNotesForAi && commentThread == resolved::navigation@1',
      ]),
    );
    assert.equal(
      resolveEntry?.when,
      'commentController == codingNotesForAi && commentThread == open',
    );
    assert.equal(resolveEntry?.group, 'navigation@2');
    assert.equal(reopenCommand?.icon, '$(issues)');
    assert.equal(moveCommand?.icon, '$(move)');
    assert.equal(reportCommand?.icon, '$(markdown)');
    assert.equal(reportViewTitleEntry?.when, 'view == codingNotesForAi.commentsView');
    assert.equal(reportViewTitleEntry?.group, 'navigation@2');
    assert.deepEqual(creationUiDefault, ['lineGutter', 'symbolHover']);
    assert.equal(newNoteDisplayDefault, 'collapse');
    assert.equal(clearAllCommand?.icon, '$(trash)');
    assert.equal(
      clearAllViewTitleEntry?.when,
      'view == codingNotesForAi.commentsView && codingNotesForAi.hasComments',
    );
    assert.equal(
      reopenEntry?.when,
      'commentController == codingNotesForAi && commentThread == resolved',
    );
    assert.equal(reopenEntry?.group, 'navigation@2');
    assert.equal(draftCategoryEntry?.group, 'inline@1');
    assert.equal(submitDraftEntry?.group, 'inline@2');
    assert.deepEqual(
      new Set(treeReopenEntries.map(({ when, group }) => `${when}::${group}`)),
      new Set([
        'view == codingNotesForAi.commentsView && viewItem == codingNotesForAi.resolvedComment::codingNotesForAi.manage@1',
        'view == codingNotesForAi.commentsView && viewItem == codingNotesForAi.resolvedDetachedComment::inline@1',
      ]),
    );
    assert.deepEqual(
      new Set(treeMoveEntries.map(({ when, group }) => `${when}::${group}`)),
      new Set([
        'view == codingNotesForAi.commentsView && viewItem == codingNotesForAi.comment::codingNotesForAi.manage@2',
        'view == codingNotesForAi.commentsView && viewItem == codingNotesForAi.resolvedComment::codingNotesForAi.manage@2',
      ]),
    );
    assert.deepEqual(configuredCategories, [
      'General',
      'Bug',
      'Improvement',
      'Question',
      'Documentation',
      'Testing',
      'Performance',
      'Security',
      'Accessibility',
      'Other',
    ]);
  });

  test('note creation is safe when no text editor is active', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.equal(vscode.window.activeTextEditor, undefined);

    await assert.doesNotReject(executeAndDismissNotifications('codingNotesForAi.createNote'));
    assert.equal(vscode.window.activeTextEditor, undefined);
  });

  test('persists a selected draft category and supports edit, resolve, and unresolved actions', async () => {
    const fixtureUri = await findFixtureUri();
    const originalSource = decode(await vscode.workspace.fs.readFile(fixtureUri));
    const selectedRange = new vscode.Range(0, 13, 0, 18);
    const thread = {
      uri: fixtureUri,
      range: selectedRange,
      comments: [] as vscode.Comment[],
      canReply: true,
      collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
      dispose: () => undefined,
    } as unknown as vscode.CommentThread;

    const reply = {
      thread,
      text: 'Review this exact identifier.',
    } satisfies vscode.CommentReply;

    await executeAndSelectNextQuickPick('codingNotesForAi.changeCategory', reply);
    assert.equal(thread.contextValue, 'codingNotesForAi.draft');
    assert.equal(thread.label, 'Accessibility');
    await vscode.commands.executeCommand('codingNotesForAi.createNote', reply);

    assert.equal(thread.comments.length, 1);
    const comment = thread.comments[0];
    assert.ok(comment);
    persistedThread = thread;
    persistedComment = comment;
    await vscode.commands.executeCommand('codingNotesForAi.editNote', comment);
    assert.equal(comment.mode, vscode.CommentMode.Editing);
    comment.body = 'Review this exact identifier.\nKeep the public name stable.';
    await executeAndDismissNotifications('codingNotesForAi.refreshComments');
    assert.equal(comment.mode, vscode.CommentMode.Editing);
    assert.equal(comment.body, 'Review this exact identifier.\nKeep the public name stable.');
    await vscode.commands.executeCommand('codingNotesForAi.saveNoteEdit', comment);
    await vscode.commands.executeCommand('codingNotesForAi.resolveNote', thread);

    const sidecarUri = vscode.Uri.joinPath(
      assertWorkspaceFolder(fixtureUri).uri,
      'CODING_NOTES_FOR_AI.json',
    );
    const sidecar = JSON.parse(decode(await vscode.workspace.fs.readFile(sidecarUri))) as {
      notes?: Array<Record<string, unknown>>;
    };
    const note = sidecar.notes?.find(
      ({ body }) => body === 'Review this exact identifier.\nKeep the public name stable.',
    );
    assert.ok(note);
    persistedNoteId = note.id as string;
    assert.equal(note.anchorKind, 'range');
    assert.equal(note.category, 'Accessibility');
    assert.deepEqual(note.anchor, {
      ...(note.anchor as Record<string, unknown>),
      range: {
        start: { line: 0, character: 13 },
        end: { line: 0, character: 18 },
      },
    });
    assert.equal(note.status, 'resolved');
    assert.equal(thread.contextValue, 'resolved');

    await vscode.commands.executeCommand('codingNotesForAi.reopenNote', thread);
    const reopenedSidecar = JSON.parse(decode(await vscode.workspace.fs.readFile(sidecarUri))) as {
      notes?: Array<Record<string, unknown>>;
    };
    const reopenedNote = reopenedSidecar.notes?.find(
      ({ body }) => body === 'Review this exact identifier.\nKeep the public name stable.',
    );
    assert.ok(reopenedNote);
    assert.equal(reopenedNote.status, 'open');
    assert.equal(thread.contextValue, 'open');
    assert.equal(decode(await vscode.workspace.fs.readFile(fixtureUri)), originalSource);
  });

  test('opens and expands a note from the reveal command', async () => {
    assert.ok(persistedThread, 'Expected the persisted native thread from note creation.');
    assert.ok(persistedNoteId, 'Expected the persisted note ID from note creation.');
    const folder = assertWorkspaceFolder(persistedThread.uri);
    persistedThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;

    await vscode.commands.executeCommand('codingNotesForAi.revealComment', {
      id: persistedNoteId,
      uri: persistedThread.uri,
      workspaceFolderUri: folder.uri,
      storeUri: vscode.Uri.joinPath(folder.uri, 'CODING_NOTES_FOR_AI.json'),
      range: persistedThread.range,
      relativePath: 'coding-note-fixture.ts',
      startLine: 1,
      endLine: 1,
      anchorState: 'attached',
    });

    assert.equal(persistedThread.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
  });

  test('can reveal the comments view and refresh its workspace state', async () => {
    await assert.doesNotReject(executeAndDismissNotifications('codingNotesForAi.showComments'));
    await assert.doesNotReject(executeAndDismissNotifications('codingNotesForAi.refreshComments'));
  });

  test('changes a persisted category from its native comment action', async () => {
    assert.ok(persistedComment, 'Expected the persisted native comment from note creation.');
    assert.ok(persistedThread, 'Expected the persisted native thread from note creation.');

    await executeAndSelectNextQuickPick('codingNotesForAi.changeCategory', persistedComment);

    const sidecarUri = vscode.Uri.joinPath(
      assertWorkspaceFolder(persistedThread.uri).uri,
      'CODING_NOTES_FOR_AI.json',
    );
    const sidecar = JSON.parse(decode(await vscode.workspace.fs.readFile(sidecarUri))) as {
      notes?: Array<Record<string, unknown>>;
    };
    const note = sidecar.notes?.find(
      ({ body }) => body === 'Review this exact identifier.\nKeep the public name stable.',
    );
    assert.ok(note);
    assert.equal(note.category, 'General');
    assert.equal(persistedComment.label, 'General • open');
    assert.equal(persistedThread.label, 'General • open');
  });

  test('opens and copies an AI resolution report', async () => {
    await executeCommandPaletteAction(
      'Coding Notes for AI: Generate & Copy AI Resolution Report',
      () =>
        vscode.window.activeTextEditor?.document.isUntitled === true &&
        vscode.window.activeTextEditor.document.languageId === 'markdown' &&
        /^# Coding Notes for AI — Resolution Task/mu.test(
          vscode.window.activeTextEditor.document.getText(),
        ),
    );

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    assert.equal(editor.document.isUntitled, true);
    assert.equal(editor.document.languageId, 'markdown');
    assert.match(editor.document.getText(), /^# Coding Notes for AI — Resolution Task/mu);
    assert.match(editor.document.getText(), /Instructions for the AI coding agent/u);
    assert.match(editor.document.getText(), /Coding note store:\*\* `CODING_NOTES_FOR_AI\.json`/u);
    assert.match(editor.document.getText(), /coding-note-fixture\.ts/u);
    assert.match(editor.document.getText(), /Keep the public name stable\./u);
    assert.equal(await vscode.env.clipboard.readText(), editor.document.getText());
  });

  test('copies a generated prompt for a persisted note', async () => {
    await executeAndDriveUi('codingNotesForAi.copyPrompt');

    const clipboard = await vscode.env.clipboard.readText();
    assert.match(
      clipboard,
      /Note ID: [\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}/iu,
    );
    assert.match(clipboard, /Keep the public name stable\./u);
    assert.match(clipboard, /Coding note store: .*CODING_NOTES_FOR_AI\.json/u);
  });

  test('copy action accepts native comment and thread arguments', async () => {
    assert.ok(persistedComment, 'Expected the persisted native comment from note creation.');
    assert.ok(persistedThread, 'Expected the persisted native thread from note creation.');

    await executeAndDismissNotifications('codingNotesForAi.copyPrompt', persistedComment);
    await assertClipboardContainsPersistedNote();

    await executeAndDismissNotifications('codingNotesForAi.copyPrompt', persistedThread);
    await assertClipboardContainsPersistedNote();
  });
});

export async function runExtensionHostTests(): Promise<void> {
  await setupCallback();
  for (const { name, callback } of testCases) {
    try {
      await callback();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Extension-host test failed: ${name}: ${message}`);
    } finally {
      await teardownCallback();
    }
  }
}

function suite(_name: string, register: () => void): void {
  register();
}

function suiteSetup(callback: TestCallback): void {
  setupCallback = callback;
}

function teardown(callback: TestCallback): void {
  teardownCallback = callback;
}

function test(name: string, callback: TestCallback): void {
  testCases.push({ name, callback });
}

async function executeAndDriveUi(command: string, ...args: unknown[]): Promise<void> {
  let outcome: { error?: unknown } | undefined;
  const deadline = Date.now() + 10_000;
  void Promise.resolve(vscode.commands.executeCommand(command, ...args)).then(
    () => {
      outcome = {};
    },
    (error: unknown) => {
      outcome = { error };
    },
  );

  while (!outcome) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await vscode.commands.executeCommand('notifications.clearAll');
    if (Date.now() >= deadline) {
      throw new Error(`Command ${command} did not settle after its UI was accepted or dismissed.`);
    }
  }

  if (outcome.error !== undefined) {
    throw outcome.error;
  }
}

async function executeCommandPaletteAction(title: string, completed: () => boolean): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.quickOpen', `>${title}`);
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');

  const deadline = Date.now() + 10_000;
  while (!completed()) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    if (Date.now() >= deadline) {
      throw new Error(`Command Palette action did not complete: ${title}`);
    }
  }
  await vscode.commands.executeCommand('notifications.clearAll');
}

async function executeAndSelectNextQuickPick(command: string, ...args: unknown[]): Promise<void> {
  let outcome: { error?: unknown } | undefined;
  const deadline = Date.now() + 10_000;
  void Promise.resolve(vscode.commands.executeCommand(command, ...args)).then(
    () => {
      outcome = {};
    },
    (error: unknown) => {
      outcome = { error };
    },
  );

  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  while (!outcome) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await vscode.commands.executeCommand('notifications.clearAll');
    if (Date.now() >= deadline) {
      throw new Error(`Command ${command} did not settle after its category was selected.`);
    }
  }

  if (outcome.error !== undefined) {
    throw outcome.error;
  }
}

async function assertClipboardContainsPersistedNote(): Promise<void> {
  const clipboard = await vscode.env.clipboard.readText();
  assert.match(clipboard, /Keep the public name stable\./u);
  assert.match(clipboard, /Coding note store: .*CODING_NOTES_FOR_AI\.json/u);
}

async function findFixtureUri(): Promise<vscode.Uri> {
  const matches = await vscode.workspace.findFiles('coding-note-fixture.ts', undefined, 1);
  assert.equal(matches.length, 1, 'The disposable test workspace should contain its fixture.');
  const uri = matches[0];
  assert.ok(uri);
  return uri;
}

function assertWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  assert.ok(folder, `Expected ${uri.toString()} to belong to a workspace folder.`);
  return folder;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function executeAndDismissNotifications(command: string, ...args: unknown[]): Promise<void> {
  let outcome: { error?: unknown } | undefined;
  const deadline = Date.now() + 10_000;
  void Promise.resolve(vscode.commands.executeCommand(command, ...args)).then(
    () => {
      outcome = {};
    },
    (error: unknown) => {
      outcome = { error };
    },
  );

  while (!outcome) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await vscode.commands.executeCommand('notifications.clearAll');
    if (Date.now() >= deadline) {
      throw new Error(`Command ${command} did not settle after its notification was dismissed.`);
    }
  }

  if (outcome.error !== undefined) {
    throw outcome.error;
  }
}
