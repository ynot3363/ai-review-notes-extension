import * as vscode from 'vscode';

import type { ReviewComment } from '../core';
import { isReviewNoteView, type ReviewNoteView } from '../services/reviewNoteView';
import { getReviewCommentTreeContext } from './reviewCommentContext';

export type ReviewGroupBy = 'file' | 'category' | 'status';

export class ReviewGroupItem extends vscode.TreeItem {
  public constructor(
    public readonly key: string,
    public readonly groupBy: ReviewGroupBy,
    public readonly comments: readonly ReviewNoteView[],
  ) {
    super(key, vscode.TreeItemCollapsibleState.Expanded);
    this.description = String(comments.length);
    this.contextValue = 'codingNotesForAi.group';
    this.iconPath = groupIcon(groupBy);
  }
}

export class ReviewCommentItem extends vscode.TreeItem {
  public override readonly contextValue: string;

  public constructor(public readonly review: ReviewNoteView) {
    const summary = summarizeComment(review.comment);
    super(`${review.category}: ${summary}`, vscode.TreeItemCollapsibleState.None);

    this.contextValue = getReviewCommentTreeContext(review);
    const anchorWarning = review.anchorState === 'attached' ? '' : ` • ${review.anchorState}`;
    this.description = `${review.status}${anchorWarning} • ${displayPath(review)}:${review.startLine}`;
    this.tooltip = createTooltip(review);
    this.iconPath =
      review.anchorState === 'attached'
        ? statusIcon(review.status)
        : new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    this.command = {
      command: 'codingNotesForAi.revealComment',
      title: 'Open Note',
      arguments: [review],
    };
  }
}

export type ReviewTreeElement = ReviewGroupItem | ReviewCommentItem;

export class ReviewCommentsTreeProvider
  implements vscode.TreeDataProvider<ReviewTreeElement>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<ReviewTreeElement | undefined>();
  private comments: readonly ReviewNoteView[] = [];
  private groupBy: ReviewGroupBy = 'file';

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public setComments(comments: readonly ReviewNoteView[]): void {
    this.comments = [...comments].sort(compareComments);
    this.changeEmitter.fire(undefined);
  }

  public getComments(): readonly ReviewNoteView[] {
    return this.comments;
  }

  public setGroupBy(groupBy: ReviewGroupBy): void {
    if (this.groupBy !== groupBy) {
      this.groupBy = groupBy;
      this.changeEmitter.fire(undefined);
    }
  }

  public refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  public getTreeItem(element: ReviewTreeElement): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: ReviewTreeElement): ReviewTreeElement[] {
    if (element instanceof ReviewCommentItem) {
      return [];
    }

    if (element instanceof ReviewGroupItem) {
      return element.comments.map((comment) => new ReviewCommentItem(comment));
    }

    const groups = new Map<string, ReviewNoteView[]>();
    for (const comment of this.comments) {
      const key = groupKey(comment, this.groupBy);
      const group = groups.get(key);
      if (group) {
        group.push(comment);
      } else {
        groups.set(key, [comment]);
      }
    }

    return [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, comments]) => new ReviewGroupItem(key, this.groupBy, comments));
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }
}

export function unwrapReviewComment(value: unknown): ReviewNoteView | undefined {
  if (value instanceof ReviewCommentItem) {
    return value.review;
  }

  if (isReviewNoteView(value)) {
    return value;
  }

  return undefined;
}

function groupKey(comment: ReviewNoteView, groupBy: ReviewGroupBy): string {
  switch (groupBy) {
    case 'category':
      return comment.category;
    case 'status':
      return comment.status;
    case 'file':
      return displayPath(comment);
  }
}

function compareComments(left: ReviewNoteView, right: ReviewNoteView): number {
  return (
    displayPath(left).localeCompare(displayPath(right)) ||
    left.startLine - right.startLine ||
    left.id.localeCompare(right.id)
  );
}

function summarizeComment(comment: string): string {
  const firstLine = comment
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return '(empty comment)';
  }

  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}…`;
}

function displayPath(comment: ReviewComment): string {
  const isMultiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  return isMultiRoot && comment.workspaceFolder
    ? `${comment.workspaceFolder} — ${comment.relativePath}`
    : comment.relativePath;
}

function createTooltip(comment: ReviewNoteView): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.appendMarkdown(`**${escapeMarkdown(comment.category)}**  \n`);
  tooltip.appendMarkdown(`Status: \`${escapeMarkdown(comment.status)}\`  \n`);
  tooltip.appendMarkdown(`Anchor: \`${escapeMarkdown(comment.anchorState)}\`  \n`);
  tooltip.appendMarkdown(
    `${escapeMarkdown(displayPath(comment))}:${comment.startLine}-${comment.endLine}  \n`,
  );
  tooltip.appendMarkdown(`ID: \`${escapeMarkdown(comment.id)}\`\n\n`);
  tooltip.appendText(comment.comment || '(empty comment)');
  return tooltip;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/gu, '\\$&');
}

function groupIcon(groupBy: ReviewGroupBy): vscode.ThemeIcon {
  switch (groupBy) {
    case 'category':
      return new vscode.ThemeIcon('tag');
    case 'status':
      return new vscode.ThemeIcon('filter');
    case 'file':
      return new vscode.ThemeIcon('file-code');
  }
}

function statusIcon(status: string): vscode.ThemeIcon {
  switch (status) {
    case 'resolved':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    case 'question':
      return new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.yellow'));
    case 'follow-up':
      return new vscode.ThemeIcon('debug-step-over', new vscode.ThemeColor('charts.orange'));
    default:
      return new vscode.ThemeIcon(
        'issues',
        new vscode.ThemeColor('problemsWarningIcon.foreground'),
      );
  }
}
