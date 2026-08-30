/** The marker which begins a Coding Notes for AI block. */
export const REVIEW_START_MARKER = 'CODING-NOTE-START';

/** The marker which ends a Coding Notes for AI block. */
export const REVIEW_END_MARKER = 'CODING-NOTE-END';

export const BUILT_IN_CATEGORIES = [
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
] as const;

export type BuiltInCategory = (typeof BUILT_IN_CATEGORIES)[number];

export const BUILT_IN_STATUSES = ['open', 'question', 'follow-up', 'resolved'] as const;

export type ReviewStatus = (typeof BUILT_IN_STATUSES)[number];

/**
 * A parsed note. Line numbers are one-based and include the start and
 * end marker lines (but not comment-wrapper-only lines).
 */
export interface ReviewComment {
  workspaceFolder: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  id: string;
  category: string;
  status: string;
  comment: string;
}

export type ReviewDiagnosticKind = 'malformed' | 'nested' | 'unclosed' | 'duplicate-id';

export interface ReviewDiagnostic {
  kind: ReviewDiagnosticKind;
  severity: 'warning' | 'error';
  message: string;
  workspaceFolder: string;
  relativePath: string;
  /** The one-based source line most closely associated with the problem. */
  line: number;
  endLine?: number;
  id?: string;
}

export interface ParseReviewCommentsOptions {
  /** A name, path, or URI identifying the containing workspace folder. */
  workspaceFolder?: string;
  /** The workspace-relative path of the source file. */
  relativePath?: string;
  /** A VS Code language identifier. A file-extension fallback is also used. */
  languageId?: string;
}

export interface ParseReviewCommentsResult {
  comments: ReviewComment[];
  diagnostics: ReviewDiagnostic[];
}

export interface MarkdownReportOptions {
  workspaceName?: string;
  generatedAt?: Date | string;
  title?: string;
  /** Workspace-relative paths to the JSON stores the receiving agent should update. */
  storePaths?: readonly string[];
}

export interface ReviewPromptOptions {
  workspaceName?: string;
  /** Number of source lines to include on each side of the review block. */
  contextLines?: number;
  /** Workspace-relative path of the canonical external note store. */
  storePath?: string;
}
