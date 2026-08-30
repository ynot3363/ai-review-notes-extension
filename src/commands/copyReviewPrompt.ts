import * as vscode from 'vscode';

import { generateReviewPrompt } from '../core';
import { selectReviewComment, type ReviewSource } from './reviewSelection';

export async function copyReviewPrompt(
  argument: unknown,
  getComments: ReviewSource,
): Promise<void> {
  const review = await selectReviewComment(argument, getComments);
  if (!review) {
    return;
  }

  if (review.anchorState !== 'attached') {
    await vscode.window.showWarningMessage(
      `Note ${review.id} is ${review.anchorState}. Reattach it before creating an AI prompt.`,
    );
    return;
  }

  const document = await vscode.workspace.openTextDocument(review.uri);
  const contextLines = vscode.workspace
    .getConfiguration('codingNotesForAi.prompt', review.uri)
    .get<number>('contextLines', 20);
  const workspaceName =
    vscode.workspace.name ??
    vscode.workspace.workspaceFolders?.map((folder) => folder.name).join(', ') ??
    review.workspaceFolder;
  const prompt = generateReviewPrompt(review, document.getText(), {
    contextLines,
    workspaceName,
    ...(review.storageMode === 'shared'
      ? { storePath: vscode.workspace.asRelativePath(review.storeUri, false) }
      : {}),
  });

  await vscode.env.clipboard.writeText(prompt);
  await vscode.window.showInformationMessage('AI coding-note prompt copied to the clipboard.');
}
