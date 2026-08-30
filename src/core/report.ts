import {
  BUILT_IN_CATEGORIES,
  BUILT_IN_STATUSES,
  type MarkdownReportOptions,
  type ReviewComment,
} from './types';

/** Render a deterministic Markdown snapshot of parsed notes. */
export function generateMarkdownReport(
  comments: readonly ReviewComment[],
  options: MarkdownReportOptions = {},
): string {
  const sorted = [...comments].sort(compareComments);
  const generatedAt = normalizeTimestamp(options.generatedAt);
  const workspaceName = options.workspaceName ?? inferWorkspaceName(sorted);
  const title = options.title?.trim() || 'Coding Notes for AI Report';
  const statusCounts = countValues(sorted.map((comment) => comment.status));
  const categoryCounts = countValues(sorted.map((comment) => comment.category));
  const folders = new Set(sorted.map((comment) => comment.workspaceFolder).filter(Boolean));
  const storePaths = normalizeStorePaths(options.storePaths);
  const resolveInstruction =
    storePaths.length > 0
      ? '4. After completing a note, use the coding note store path listed above to update its matching ID to `resolved`. Preserve its ID, category, body, and anchor metadata.'
      : '4. After completing a note, update its matching ID in the configured Coding Notes for AI store to `resolved`. Preserve its ID, category, body, and anchor metadata.';

  const output: string[] = [
    `# ${escapeHeading(title)}`,
    '',
    `- **Generated:** ${escapeInline(generatedAt)}`,
    `- **Workspace:** ${escapeInline(workspaceName || '(unknown)')}`,
    ...renderStorePaths(storePaths),
    `- **Total notes:** ${sorted.length}`,
    '',
    '## Instructions for the AI coding agent',
    '',
    'Treat this report as a workspace task list:',
    '',
    '1. Read each note that is not already resolved and inspect the current code at its referenced file and line range.',
    '2. Decide whether the note is still valid. Implement a focused fix for valid actionable notes; answer or clarify question notes when appropriate.',
    '3. Run relevant checks or tests and avoid unrelated changes.',
    resolveInstruction,
    '5. Summarize what you changed, what you verified, and any notes you could not safely resolve.',
    '',
    '## Counts by status',
    '',
    ...renderCountTable('Status', statusCounts, BUILT_IN_STATUSES),
    '',
    '## Counts by category',
    '',
    ...renderCountTable('Category', categoryCounts, BUILT_IN_CATEGORIES),
    '',
    '## Notes by file',
    '',
  ];

  if (sorted.length === 0) {
    output.push('_No notes found._', '');
    return `${output.join('\n')}\n`;
  }

  const groups = groupByFile(sorted);
  for (const group of groups) {
    const fileLabel =
      folders.size > 1 && group.workspaceFolder
        ? `${group.workspaceFolder} — ${group.relativePath || '(unknown file)'}`
        : group.relativePath || '(unknown file)';
    output.push(`### \`${escapeCodeSpan(fileLabel)}\``, '');

    for (const comment of group.comments) {
      const range =
        comment.startLine === comment.endLine
          ? `Line ${comment.startLine}`
          : `Lines ${comment.startLine}–${comment.endLine}`;
      output.push(
        `#### ${range}`,
        '',
        `- **ID:** \`${escapeCodeSpan(comment.id)}\``,
        `- **Category:** ${escapeInline(comment.category)}`,
        `- **Status:** ${escapeInline(comment.status)}`,
        '',
        '**Note**',
        '',
      );

      if (comment.comment.length === 0) {
        output.push('_No note provided._', '');
      } else {
        const fence = fenceFor(comment.comment);
        output.push(`${fence}text`, comment.comment, fence, '');
      }
    }
  }

  return `${output.join('\n')}\n`;
}

/** Backwards-friendly semantic alias. */
export const generateReviewReport = generateMarkdownReport;

function normalizeStorePaths(paths: readonly string[] | undefined): string[] {
  return [...new Set((paths ?? []).map((path) => path.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function renderStorePaths(paths: readonly string[]): string[] {
  if (paths.length === 0) {
    return [];
  }
  if (paths.length === 1) {
    return [`- **Coding note store:** \`${escapeCodeSpan(paths[0]!)}\``];
  }
  return ['- **Coding note stores:**', ...paths.map((path) => `  - \`${escapeCodeSpan(path)}\``)];
}

function compareComments(left: ReviewComment, right: ReviewComment): number {
  return (
    left.workspaceFolder.localeCompare(right.workspaceFolder) ||
    left.relativePath.localeCompare(right.relativePath) ||
    left.startLine - right.startLine ||
    left.endLine - right.endLine ||
    left.id.localeCompare(right.id)
  );
}

function normalizeTimestamp(value: Date | string | undefined): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '(unknown)' : value.toISOString();
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return new Date().toISOString();
}

function inferWorkspaceName(comments: readonly ReviewComment[]): string {
  const names = [...new Set(comments.map((comment) => comment.workspaceFolder).filter(Boolean))];
  return names.join(', ');
}

function countValues(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function renderCountTable(
  label: string,
  counts: ReadonlyMap<string, number>,
  preferredOrder: readonly string[],
): string[] {
  const preferred = preferredOrder.filter((value) => counts.has(value));
  const preferredSet = new Set(preferredOrder);
  const remaining = [...counts.keys()]
    .filter((value) => !preferredSet.has(value))
    .sort((left, right) => left.localeCompare(right));
  const values = [...preferred, ...remaining];

  if (values.length === 0) {
    return ['_None._'];
  }

  return [
    `| ${label} | Count |`,
    '| --- | ---: |',
    ...values.map((value) => `| ${escapeTableCell(value)} | ${counts.get(value) ?? 0} |`),
  ];
}

function groupByFile(comments: readonly ReviewComment[]): Array<{
  workspaceFolder: string;
  relativePath: string;
  comments: ReviewComment[];
}> {
  const groups = new Map<
    string,
    { workspaceFolder: string; relativePath: string; comments: ReviewComment[] }
  >();
  for (const comment of comments) {
    const key = `${comment.workspaceFolder}\0${comment.relativePath}`;
    const group = groups.get(key) ?? {
      workspaceFolder: comment.workspaceFolder,
      relativePath: comment.relativePath,
      comments: [],
    };
    group.comments.push(comment);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function escapeInline(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([*_`[\]<>])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ');
}

function escapeHeading(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/([\\`*_{}[\]()#+.!|>~-])/g, '\\$1');
}

function escapeTableCell(value: string): string {
  return escapeInline(value).replace(/\|/g, '\\|');
}

function escapeCodeSpan(value: string): string {
  return value.replace(/`/g, '\u02cb').replace(/[\r\n]+/g, ' ');
}

function fenceFor(value: string): string {
  const runs = value.match(/`+/g) ?? [];
  const longest = runs.reduce((length, run) => Math.max(length, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}
