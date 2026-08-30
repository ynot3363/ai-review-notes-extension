import * as vscode from 'vscode';

import type { ReviewComment } from '../core';

export type ReviewNoteAnchorState = 'attached' | 'ambiguous' | 'orphaned';

/**
 * Editor-facing projection of one persisted note.
 *
 * Core report and prompt generators consume the inherited, VS Code-independent
 * fields. The remaining fields are used only for navigation and native comment
 * threads.
 */
export interface ReviewNoteView extends ReviewComment {
  readonly uri: vscode.Uri;
  readonly workspaceFolderUri: vscode.Uri;
  readonly storeUri: vscode.Uri;
  readonly range: vscode.Range;
  readonly anchorState: ReviewNoteAnchorState;
  readonly anchorKind: 'line' | 'range' | 'symbol';
  readonly symbolLabel?: string;
  readonly storageMode: 'shared' | 'private';
  readonly updatedAt: string;
}

export function isReviewNoteView(value: unknown): value is ReviewNoteView {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<ReviewNoteView>;
  return (
    candidate.uri instanceof vscode.Uri &&
    candidate.workspaceFolderUri instanceof vscode.Uri &&
    candidate.storeUri instanceof vscode.Uri &&
    candidate.range instanceof vscode.Range &&
    typeof candidate.id === 'string' &&
    typeof candidate.relativePath === 'string' &&
    typeof candidate.startLine === 'number' &&
    typeof candidate.endLine === 'number' &&
    (candidate.anchorState === 'attached' ||
      candidate.anchorState === 'ambiguous' ||
      candidate.anchorState === 'orphaned')
  );
}
