import type { ReviewComment, ReviewPromptOptions } from './types';

export const DEFAULT_CONTEXT_LINES = 8;
export const MAX_CONTEXT_LINES = 200;

/** Generate (but never submit) a prompt for one note. */
export function generateReviewPrompt(
  review: ReviewComment,
  source: string,
  options: ReviewPromptOptions = {},
): string {
  const contextLines = normalizeContextLines(options.contextLines);
  const sourceLines = splitSourceLines(source);
  const firstSourceLine = Math.max(1, Math.min(review.startLine, sourceLines.length));
  const lastSourceLine = Math.max(firstSourceLine, Math.min(review.endLine, sourceLines.length));
  const contextStart = Math.max(1, firstSourceLine - contextLines);
  const contextEnd = Math.min(sourceLines.length, lastSourceLine + contextLines);
  const numberedSource = sourceLines
    .slice(contextStart - 1, contextEnd)
    .map(
      (line, index) =>
        `${String(contextStart + index).padStart(String(contextEnd).length, ' ')} | ${line}`,
    )
    .join('\n');
  const sourceFence = fenceFor(numberedSource);
  const commentFence = fenceFor(review.comment);
  const workspaceName = options.workspaceName ?? (review.workspaceFolder || '(unknown)');
  const storeLine = options.storePath
    ? [`Coding note store: ${singleLine(options.storePath)}`]
    : [];

  return [
    'Analyze this structured note.',
    '',
    `Workspace: ${singleLine(workspaceName)}`,
    `File: ${singleLine(review.relativePath || '(unknown)')}`,
    ...storeLine,
    `Line range: ${review.startLine}-${review.endLine}`,
    `Note ID: ${singleLine(review.id)}`,
    `Category: ${singleLine(review.category)}`,
    `Status: ${singleLine(review.status)}`,
    '',
    'Coding note:',
    `${commentFence}text`,
    review.comment,
    commentFence,
    '',
    `Surrounding source code (lines ${contextStart}-${contextEnd}; ${contextLines} context line${contextLines === 1 ? '' : 's'} requested on each side):`,
    `${sourceFence}text`,
    numberedSource,
    sourceFence,
    '',
    'Determine whether the finding is valid, explain your reasoning, and propose a focused change. Do not modify unrelated code.',
  ].join('\n');
}

/** Common naming aliases for consumers outside VS Code. */
export const generateAiPrompt = generateReviewPrompt;
export const buildReviewPrompt = generateReviewPrompt;

function normalizeContextLines(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_CONTEXT_LINES;
  }
  return Math.min(MAX_CONTEXT_LINES, Math.max(0, Math.floor(value)));
}

function splitSourceLines(source: string): string[] {
  return source.split(/\r\n|\n|\r/);
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function fenceFor(value: string): string {
  const runs = value.match(/`+/g) ?? [];
  const longest = runs.reduce((length, run) => Math.max(length, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}
