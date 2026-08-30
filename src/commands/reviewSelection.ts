import * as vscode from 'vscode';

import type { ReviewNoteView } from '../services/reviewNoteView';
import { unwrapReviewComment } from '../views/reviewCommentsTreeProvider';

export type ReviewSource = () => readonly ReviewNoteView[];

interface ReviewQuickPickItem extends vscode.QuickPickItem {
  readonly review: ReviewNoteView;
}

export async function selectReviewComment(
  argument: unknown,
  getComments: ReviewSource,
): Promise<ReviewNoteView | undefined> {
  const argumentReview = unwrapReviewComment(argument);
  if (argumentReview) {
    return argumentReview;
  }

  const comments = getComments();
  if (comments.length === 0) {
    await vscode.window.showInformationMessage('No AI notes were found in this workspace.');
    return undefined;
  }

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const cursorLine = activeEditor.selection.active.line + 1;
    const matches = comments.filter(
      (comment) =>
        comment.uri.toString() === activeEditor.document.uri.toString() &&
        cursorLine >= comment.startLine &&
        cursorLine <= comment.endLine,
    );
    if (matches.length === 1) {
      return matches[0];
    }
  }

  const selection = await vscode.window.showQuickPick<ReviewQuickPickItem>(
    comments.map((review) => ({
      label: review.category,
      description: `${review.status} • ${displayPath(review)}:${review.startLine}`,
      detail: firstLine(review.comment),
      review,
    })),
    {
      title: 'Select an AI note',
      placeHolder: 'Choose the finding to use',
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );

  return selection?.review;
}

export async function revealReviewComment(review: ReviewNoteView): Promise<void> {
  if (review.anchorState !== 'attached') {
    await vscode.window.showWarningMessage(
      `Note ${review.id} is ${review.anchorState}. Reattach it to a current selection before navigating.`,
    );
    return;
  }

  const document = await vscode.workspace.openTextDocument(review.uri);
  const editor = await vscode.window.showTextDocument(document, {
    preview: true,
    preserveFocus: false,
  });

  const range = new vscode.Range(
    document.validatePosition(review.range.start),
    document.validatePosition(review.range.end),
  );
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function displayPath(review: ReviewNoteView): string {
  const isMultiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  return isMultiRoot && review.workspaceFolder
    ? `${review.workspaceFolder} — ${review.relativePath}`
    : review.relativePath;
}

function firstLine(comment: string): string {
  return (
    comment
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? '(empty comment)'
  );
}
