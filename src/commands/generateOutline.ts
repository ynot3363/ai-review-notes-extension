import * as vscode from 'vscode';

import { generateMarkdownReport } from '../core';
import type { ReviewNoteView } from '../services/reviewNoteView';

export async function generateCommentsOutline(
  comments: readonly ReviewNoteView[],
  sharedStoreUris: readonly vscode.Uri[],
): Promise<void> {
  const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const workspaceName =
    vscode.workspace.name ??
    vscode.workspace.workspaceFolders?.map((folder) => folder.name).join(', ') ??
    'Untitled Workspace';
  const report = generateMarkdownReport(comments, {
    title: 'Coding Notes for AI — Resolution Task',
    workspaceName,
    generatedAt: new Date(),
    storePaths: sharedStorePaths(sharedStoreUris, includeWorkspaceFolder),
  });
  await vscode.env.clipboard.writeText(report);
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: report,
  });
  await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false,
  });
}

function sharedStorePaths(
  storeUris: readonly vscode.Uri[],
  includeWorkspaceFolder: boolean,
): string[] {
  return [
    ...new Set(
      storeUris.map((storeUri) =>
        vscode.workspace.asRelativePath(storeUri, includeWorkspaceFolder),
      ),
    ),
  ];
}
