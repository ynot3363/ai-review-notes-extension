import {
  REVIEW_END_MARKER,
  REVIEW_START_MARKER,
  type ParseReviewCommentsOptions,
  type ParseReviewCommentsResult,
  type ReviewComment,
  type ReviewDiagnostic,
} from './types';

type CommentKind = 'slash-line' | 'hash-line' | 'slash-block' | 'html-block' | 'powershell-block';

interface CommentRegion {
  id: number;
  kind: CommentKind;
  contentStart: number;
  contentEnd: number;
  openingOffset: number;
  openingColumn: number;
  terminated: boolean;
}

interface LogicalCommentLine {
  regionId: number;
  kind: CommentKind;
  line: number;
  text: string;
  wrapperTerminated: boolean;
}

interface OffsetRange {
  start: number;
  end: number;
}

type SlashScanContext =
  | { kind: 'code'; closingBraceDepth?: number }
  | { kind: 'jsx-text'; depth: number }
  | { kind: 'string'; quote: "'" | '"' }
  | { kind: 'template' };

interface PendingBlock {
  start: LogicalCommentLine;
  last: LogicalCommentLine;
  content: LogicalCommentLine[];
  nestedDepth: number;
  invalid: boolean;
}

const SLASH_LANGUAGE_IDS = new Set([
  'typescript',
  'typescriptreact',
  'tsx',
  'javascript',
  'javascriptreact',
  'jsx',
  'css',
  'scss',
  'less',
  'jsonc',
]);

const MARKUP_LANGUAGE_IDS = new Set(['html', 'xml', 'svg', 'markdown', 'mdx']);
const JSX_LANGUAGE_IDS = new Set(['typescriptreact', 'tsx', 'javascriptreact', 'jsx', 'mdx']);
const HASH_LANGUAGE_IDS = new Set([
  'yaml',
  'yml',
  'python',
  'py',
  'shellscript',
  'shell',
  'bash',
  'zsh',
  'fish',
  'powershell',
  'ps1',
]);

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.svg': 'svg',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'mdx',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.py': 'python',
  '.sh': 'shellscript',
  '.bash': 'shellscript',
  '.zsh': 'shellscript',
  '.fish': 'shellscript',
  '.ps1': 'powershell',
  '.psd1': 'powershell',
  '.psm1': 'powershell',
  '.json': 'json',
  '.jsonc': 'jsonc',
};

/**
 * Parse review blocks from source text without relying on VS Code APIs.
 *
 * Only markers found inside actual comments are considered. Valid review
 * comments are retained even when another block in the same file is malformed.
 */
export function parseReviewComments(
  source: string,
  options: ParseReviewCommentsOptions = {},
): ParseReviewCommentsResult {
  const context = {
    workspaceFolder: options.workspaceFolder ?? '',
    relativePath: options.relativePath ?? '',
  };
  const lineStarts = buildLineStarts(source);
  const languageId = resolveLanguageId(options.languageId, options.relativePath);
  const regions = extractCommentRegions(source, languageId);
  const lines = regions
    .flatMap((region) => logicalLinesForRegion(source, region, lineStarts))
    .sort((left, right) => left.line - right.line || left.regionId - right.regionId);

  const comments: ReviewComment[] = [];
  const diagnostics: ReviewDiagnostic[] = [];
  let pending: PendingBlock | undefined;

  const reportUnclosed = (block: PendingBlock, endLine?: number): void => {
    diagnostics.push({
      kind: 'unclosed',
      severity: 'error',
      message: `Coding-note block starting on line ${block.start.line} has no matching ${REVIEW_END_MARKER}.`,
      ...context,
      line: block.start.line,
      ...(endLine === undefined ? {} : { endLine }),
    });
  };

  for (const line of lines) {
    if (pending && !isContinuation(pending.last, line)) {
      reportUnclosed(pending, pending.last.line);
      pending = undefined;
    }

    const marker = line.text.trim();
    if (marker === REVIEW_START_MARKER) {
      if (pending) {
        diagnostics.push({
          kind: 'nested',
          severity: 'error',
          message: `Nested ${REVIEW_START_MARKER} on line ${line.line}; coding-note blocks cannot be nested.`,
          ...context,
          line: line.line,
        });
        pending.nestedDepth += 1;
        pending.invalid = true;
        pending.last = line;
      } else {
        pending = {
          start: line,
          last: line,
          content: [],
          nestedDepth: 0,
          invalid: false,
        };
      }
      continue;
    }

    if (marker === REVIEW_END_MARKER) {
      if (!pending) {
        diagnostics.push({
          kind: 'malformed',
          severity: 'error',
          message: `${REVIEW_END_MARKER} on line ${line.line} does not have a matching start marker.`,
          ...context,
          line: line.line,
        });
        continue;
      }

      pending.last = line;
      if (pending.nestedDepth > 0) {
        pending.nestedDepth -= 1;
        continue;
      }

      if (!pending.invalid) {
        const parsed = parseCompletedBlock(pending, line, context);
        if ('comment' in parsed) {
          comments.push(parsed.comment);
        } else {
          diagnostics.push(parsed.diagnostic);
        }
      }
      pending = undefined;
      continue;
    }

    if (pending) {
      pending.content.push(line);
      pending.last = line;
    }
  }

  if (pending) {
    reportUnclosed(pending, pending.last.line);
  }

  diagnostics.push(...findDuplicateReviewIds(comments));
  return { comments, diagnostics };
}

/**
 * Find duplicate IDs in an aggregate result (including comments from different
 * files/workspace folders). Every occurrence after the first is reported.
 */
export function findDuplicateReviewIds(comments: readonly ReviewComment[]): ReviewDiagnostic[] {
  const firstById = new Map<string, ReviewComment>();
  const diagnostics: ReviewDiagnostic[] = [];

  for (const comment of comments) {
    const first = firstById.get(comment.id);
    if (!first) {
      firstById.set(comment.id, comment);
      continue;
    }

    const firstLocation = first.relativePath
      ? `${first.relativePath}:${first.startLine}`
      : `line ${first.startLine}`;
    diagnostics.push({
      kind: 'duplicate-id',
      severity: 'warning',
      message: `Note ID "${comment.id}" duplicates the block at ${firstLocation}.`,
      workspaceFolder: comment.workspaceFolder,
      relativePath: comment.relativePath,
      line: comment.startLine,
      endLine: comment.endLine,
      id: comment.id,
    });
  }

  return diagnostics;
}

function parseCompletedBlock(
  pending: PendingBlock,
  end: LogicalCommentLine,
  context: Pick<ReviewComment, 'workspaceFolder' | 'relativePath'>,
): { comment: ReviewComment } | { diagnostic: ReviewDiagnostic } {
  const malformed = (reason: string): { diagnostic: ReviewDiagnostic } => ({
    diagnostic: {
      kind: 'malformed',
      severity: 'error',
      message: `Malformed coding-note block on lines ${pending.start.line}-${end.line}: ${reason}`,
      ...context,
      line: pending.start.line,
      endLine: end.line,
    },
  });

  if (!pending.start.wrapperTerminated) {
    return malformed('the containing comment wrapper is not terminated.');
  }

  if (pending.content.length < 4) {
    return malformed('expected id, category, status, and comment fields in that order.');
  }

  const id = fieldValue(pending.content[0]!.text, 'id');
  const category = fieldValue(pending.content[1]!.text, 'category');
  const status = fieldValue(pending.content[2]!.text, 'status');

  if (id === undefined || id.length === 0) {
    return malformed('the id field is missing or empty.');
  }
  if (category === undefined || category.length === 0) {
    return malformed('the category field is missing or empty.');
  }
  if (status === undefined || status.length === 0) {
    return malformed('the status field is missing or empty.');
  }
  if (!/^\s*comment:\s*$/.test(pending.content[3]!.text)) {
    return malformed('the comment field is missing, out of order, or contains inline text.');
  }

  return {
    comment: {
      ...context,
      startLine: pending.start.line,
      endLine: end.line,
      id,
      category,
      status,
      comment: pending.content
        .slice(4)
        .map((line) => line.text)
        .join('\n'),
    },
  };
}

function fieldValue(line: string, field: string): string | undefined {
  const match = new RegExp(`^\\s*${field}:\\s*(.*?)\\s*$`).exec(line);
  return match?.[1];
}

function isContinuation(previous: LogicalCommentLine, next: LogicalCommentLine): boolean {
  if (previous.regionId === next.regionId) {
    return true;
  }

  const previousIsLineComment = previous.kind === 'slash-line' || previous.kind === 'hash-line';
  return previousIsLineComment && previous.kind === next.kind && next.line === previous.line + 1;
}

function resolveLanguageId(
  languageId: string | undefined,
  relativePath: string | undefined,
): string {
  const normalized = languageId?.trim().toLowerCase();
  if (normalized) {
    return normalized;
  }

  const path = relativePath?.toLowerCase() ?? '';
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? (LANGUAGE_BY_EXTENSION[path.slice(dot)] ?? '') : '';
}

function extractCommentRegions(source: string, languageId: string): CommentRegion[] {
  const scanSlash = !languageId || SLASH_LANGUAGE_IDS.has(languageId) || languageId === 'mdx';
  const scanMarkup = !languageId || MARKUP_LANGUAGE_IDS.has(languageId);
  const scanHash = !languageId || HASH_LANGUAGE_IDS.has(languageId);
  const fencedCodeRanges =
    languageId === 'markdown' || languageId === 'mdx' ? findMarkdownFencedCodeRanges(source) : [];
  const markdownLiteralRanges =
    languageId === 'markdown' || languageId === 'mdx'
      ? (() => {
          const blockCodeRanges = mergeOffsetRanges([
            ...fencedCodeRanges,
            ...findMarkdownIndentedCodeRanges(source),
          ]);
          return mergeOffsetRanges([
            ...blockCodeRanges,
            ...findMarkdownCodeSpanRanges(source, blockCodeRanges),
          ]);
        })()
      : [];
  const markupIgnoredRanges = scanMarkup
    ? mergeOffsetRanges([
        ...markdownLiteralRanges,
        ...(languageId === 'mdx'
          ? findMdxJavaScriptLiteralRanges(source, markdownLiteralRanges)
          : []),
        ...findMarkupLiteralRanges(
          source,
          languageId === 'html' || languageId === 'markdown' || languageId === 'mdx',
        ),
      ])
    : [];
  const powershellLiteralRanges =
    languageId === 'powershell' || languageId === 'ps1' ? findPowerShellLiteralRanges(source) : [];
  const hashIgnoredRanges = scanHash
    ? mergeOffsetRanges([
        ...(languageId === 'yaml' || languageId === 'yml' ? findYamlBlockScalarRanges(source) : []),
        ...(isShellLanguage(languageId) ? findShellHeredocRanges(source) : []),
        ...powershellLiteralRanges,
      ])
    : [];
  const regions: CommentRegion[] = [];

  if (scanSlash) {
    regions.push(
      ...scanSlashComments(source, markdownLiteralRanges, JSX_LANGUAGE_IDS.has(languageId)),
    );
  }
  if (scanMarkup) {
    regions.push(...scanDelimitedBlocks(source, '<!--', '-->', 'html-block', markupIgnoredRanges));
  }
  if (scanHash) {
    regions.push(...scanHashComments(source, languageId, hashIgnoredRanges));
  }
  if (!languageId || languageId === 'powershell' || languageId === 'ps1') {
    regions.push(
      ...scanDelimitedBlocks(source, '<#', '#>', 'powershell-block', powershellLiteralRanges),
    );
  }

  return regions
    .sort(
      (left, right) =>
        left.openingOffset - right.openingOffset || left.contentStart - right.contentStart,
    )
    .map((region, id) => ({ ...region, id }));
}

function scanSlashComments(
  source: string,
  ignoredRanges: readonly OffsetRange[] = [],
  jsxAware = false,
): CommentRegion[] {
  const regions: CommentRegion[] = [];
  let index = 0;
  const contexts: SlashScanContext[] = [{ kind: 'code' }];

  while (index < source.length) {
    const ignoredRange = rangeContainingOffset(index, ignoredRanges);
    if (ignoredRange) {
      index = ignoredRange.end;
      contexts.splice(0, contexts.length, { kind: 'code' });
      continue;
    }

    const context = contexts[contexts.length - 1]!;
    const character = source[index];

    if (context.kind === 'string') {
      if (character === '\\') {
        index += 2;
        continue;
      }
      if (character === context.quote || character === '\n') {
        contexts.pop();
      }
      index += 1;
      continue;
    }

    if (context.kind === 'template') {
      if (character === '\\') {
        index += 2;
        continue;
      }
      if (character === '`') {
        contexts.pop();
        index += 1;
        continue;
      }
      if (character === '$' && source[index + 1] === '{') {
        contexts.push({ kind: 'code', closingBraceDepth: 1 });
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (context.kind === 'jsx-text') {
      if (character === '{') {
        contexts.push({ kind: 'code', closingBraceDepth: 1 });
        index += 1;
        continue;
      }
      if (character === '<') {
        const tag = scanJsxTag(source, index);
        if (tag) {
          if (tag.closing) {
            context.depth -= 1;
            if (context.depth === 0) {
              contexts.pop();
            }
          } else if (!tag.selfClosing) {
            context.depth += 1;
          }
          index = tag.end;
          continue;
        }
      }
      index += 1;
      continue;
    }

    if (character === '/' && source[index + 1] === '/') {
      const openingOffset = index;
      const lineStart = source.lastIndexOf('\n', openingOffset - 1) + 1;
      const prefix = source.slice(lineStart, openingOffset);
      const newline = source.indexOf('\n', openingOffset + 2);
      const contentEnd = newline >= 0 ? newline : source.length;

      // Generated line-comment review blocks occupy their own physical lines.
      if (prefix.trim().length === 0) {
        regions.push({
          id: -1,
          kind: 'slash-line',
          contentStart: openingOffset + 2,
          contentEnd,
          openingOffset,
          openingColumn: openingOffset - lineStart,
          terminated: true,
        });
      }
      index = contentEnd;
      continue;
    }

    if (character === '/' && source[index + 1] === '*') {
      const openingOffset = index;
      const closingOffset = source.indexOf('*/', openingOffset + 2);
      const lineStart = source.lastIndexOf('\n', openingOffset - 1) + 1;
      regions.push({
        id: -1,
        kind: 'slash-block',
        contentStart: openingOffset + 2,
        contentEnd: closingOffset >= 0 ? closingOffset : source.length,
        openingOffset,
        openingColumn: openingOffset - lineStart,
        terminated: closingOffset >= 0,
      });
      index = closingOffset >= 0 ? closingOffset + 2 : source.length;
      continue;
    }

    if (character === "'" || character === '"') {
      contexts.push({ kind: 'string', quote: character });
      index += 1;
      continue;
    }

    if (character === '`') {
      contexts.push({ kind: 'template' });
      index += 1;
      continue;
    }

    if (jsxAware && character === '<' && canStartRootJsx(source, index)) {
      const tag = scanJsxTag(source, index);
      if (tag && !tag.closing) {
        if (!tag.selfClosing) {
          contexts.push({ kind: 'jsx-text', depth: 1 });
        }
        index = tag.end;
        continue;
      }
    }

    if (context.closingBraceDepth !== undefined) {
      if (character === '{') {
        context.closingBraceDepth += 1;
        index += 1;
        continue;
      }
      if (character === '}') {
        context.closingBraceDepth -= 1;
        if (context.closingBraceDepth === 0) {
          contexts.pop();
        }
        index += 1;
        continue;
      }
    }

    index += 1;
  }

  return regions;
}

function canStartRootJsx(source: string, lessThan: number): boolean {
  const before = source.slice(0, lessThan).trimEnd();
  if (before.length === 0) {
    return true;
  }

  const previous = before[before.length - 1] ?? '';
  if ('([{=,:;!?&|'.includes(previous)) {
    return true;
  }

  return /(?:\breturn|=>)$/.test(before);
}

interface ScannedJsxTag {
  closing: boolean;
  end: number;
  selfClosing: boolean;
}

function scanJsxTag(source: string, start: number): ScannedJsxTag | undefined {
  if (source[start] !== '<') {
    return undefined;
  }

  let cursor = start + 1;
  let closing = false;
  if (source[cursor] === '/') {
    closing = true;
    cursor += 1;
  }

  // Fragments use <> and </> rather than a tag name.
  if (source[cursor] === '>') {
    return { closing, end: cursor + 1, selfClosing: closing };
  }

  if (!/[A-Za-z_$]/.test(source[cursor] ?? '')) {
    return undefined;
  }
  cursor += 1;
  while (cursor < source.length && /[A-Za-z0-9_$:.-]/.test(source[cursor]!)) {
    cursor += 1;
  }

  const nameBoundary = source[cursor];
  if (nameBoundary !== '>' && nameBoundary !== '/' && !/\s/.test(nameBoundary ?? '')) {
    return undefined;
  }

  let quote: "'" | '"' | '`' | undefined;
  let expressionDepth = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (quote) {
      if (character === '\\') {
        cursor += 2;
        continue;
      }
      if (character === quote) {
        quote = undefined;
      }
      cursor += 1;
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      cursor += 1;
      continue;
    }
    if (character === '{') {
      expressionDepth += 1;
      cursor += 1;
      continue;
    }
    if (character === '}' && expressionDepth > 0) {
      expressionDepth -= 1;
      cursor += 1;
      continue;
    }
    if (character === '>' && expressionDepth === 0) {
      const beforeClosingBracket = source.slice(start, cursor).trimEnd();
      return {
        closing,
        end: cursor + 1,
        selfClosing: beforeClosingBracket.endsWith('/'),
      };
    }
    cursor += 1;
  }

  return undefined;
}

function scanDelimitedBlocks(
  source: string,
  opening: string,
  closing: string,
  kind: 'html-block' | 'powershell-block',
  ignoredRanges: readonly OffsetRange[] = [],
): CommentRegion[] {
  const regions: CommentRegion[] = [];
  let searchFrom = 0;

  while (searchFrom < source.length) {
    const openingOffset = source.indexOf(opening, searchFrom);
    if (openingOffset < 0) {
      break;
    }
    const ignoredRange = rangeContainingOffset(openingOffset, ignoredRanges);
    if (ignoredRange) {
      searchFrom = ignoredRange.end;
      continue;
    }
    const closingOffset = source.indexOf(closing, openingOffset + opening.length);
    const lineStart = source.lastIndexOf('\n', openingOffset - 1) + 1;
    regions.push({
      id: -1,
      kind,
      contentStart: openingOffset + opening.length,
      contentEnd: closingOffset >= 0 ? closingOffset : source.length,
      openingOffset,
      openingColumn: openingOffset - lineStart,
      terminated: closingOffset >= 0,
    });
    searchFrom = closingOffset >= 0 ? closingOffset + closing.length : source.length;
  }

  return regions;
}

function findMarkdownFencedCodeRanges(source: string): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  let active: { character: '`' | '~'; length: number; start: number } | undefined;
  let lineStart = 0;

  while (lineStart <= source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline >= 0 ? newline : source.length;
    const rawLine = source.slice(lineStart, lineEnd);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (active) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1];
      if (closing && closing[0] === active.character && closing.length >= active.length) {
        ranges.push({
          start: active.start,
          end: newline >= 0 ? newline + 1 : source.length,
        });
        active = undefined;
      }
    } else {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      const delimiter = opening?.[1];
      const info = opening?.[2] ?? '';
      if (delimiter && !(delimiter[0] === '`' && info.includes('`'))) {
        active = {
          character: delimiter[0] as '`' | '~',
          length: delimiter.length,
          start: lineStart,
        };
      }
    }

    if (newline < 0) {
      break;
    }
    lineStart = newline + 1;
  }

  if (active) {
    ranges.push({ start: active.start, end: source.length });
  }

  return ranges;
}

function findMarkdownIndentedCodeRanges(source: string): OffsetRange[] {
  return physicalSourceLines(source)
    .filter(({ text }) => /^(?: {4}|\t)/.test(text))
    .map(({ start, endIncludingNewline }) => ({ start, end: endIncludingNewline }));
}

function findMarkdownCodeSpanRanges(
  source: string,
  ignoredRanges: readonly OffsetRange[],
): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  let index = 0;

  while (index < source.length) {
    const ignoredRange = rangeContainingOffset(index, ignoredRanges);
    if (ignoredRange) {
      index = ignoredRange.end;
      continue;
    }
    if (source[index] !== '`') {
      index += 1;
      continue;
    }

    const delimiterLength = repeatedCharacterRunLength(source, index, '`');
    let candidate = index + delimiterLength;
    let closingEnd: number | undefined;
    while (candidate < source.length) {
      candidate = source.indexOf('`', candidate);
      if (candidate < 0) {
        break;
      }
      const ignoredCandidate = rangeContainingOffset(candidate, ignoredRanges);
      if (ignoredCandidate) {
        candidate = ignoredCandidate.end;
        continue;
      }
      const candidateLength = repeatedCharacterRunLength(source, candidate, '`');
      if (candidateLength === delimiterLength) {
        closingEnd = candidate + candidateLength;
        break;
      }
      candidate += candidateLength;
    }

    if (closingEnd !== undefined) {
      ranges.push({ start: index, end: closingEnd });
      index = closingEnd;
    } else {
      index += delimiterLength;
    }
  }

  return ranges;
}

function repeatedCharacterRunLength(source: string, start: number, character: string): number {
  let end = start;
  while (source[end] === character) {
    end += 1;
  }
  return end - start;
}

function findMdxJavaScriptLiteralRanges(
  source: string,
  ignoredRanges: readonly OffsetRange[],
): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  let expressionDepth = 0;
  let index = 0;

  while (index < source.length) {
    const ignoredRange = rangeContainingOffset(index, ignoredRanges);
    if (ignoredRange) {
      index = ignoredRange.end;
      continue;
    }

    const character = source[index];
    if (character === '{') {
      expressionDepth += 1;
      index += 1;
      continue;
    }
    if (character === '}' && expressionDepth > 0) {
      expressionDepth -= 1;
      index += 1;
      continue;
    }

    const isTemplate = character === '`' && source[index - 1] !== '`' && source[index + 1] !== '`';
    const isQuotedExpression =
      (character === "'" || character === '"') &&
      (expressionDepth > 0 || isMdxEsmQuotePosition(source, index));
    if (!isTemplate && !isQuotedExpression) {
      index += 1;
      continue;
    }

    const end = findJavaScriptLiteralEnd(source, index, character as "'" | '"' | '`');
    ranges.push({ start: index, end });
    index = end;
  }

  return ranges;
}

function isMdxEsmQuotePosition(source: string, offset: number): boolean {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  return /^\s*(?:export|import)\b/.test(source.slice(lineStart, offset));
}

function findJavaScriptLiteralEnd(source: string, start: number, quote: "'" | '"' | '`'): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === quote) {
      return index + 1;
    }
    index += 1;
  }
  return source.length;
}

interface ScannedMarkupTag {
  closing: boolean;
  end: number;
  name: string;
  quotedRanges: OffsetRange[];
  selfClosing: boolean;
}

const HTML_RAW_TEXT_ELEMENTS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);

/**
 * Locate markup contexts where a `<!--` sequence is text rather than the
 * beginning of a markup comment: quoted attributes, CDATA, and HTML raw-text
 * elements such as script/style. Actual comments are skipped while finding
 * those ranges so their contents cannot be mistaken for markup structure.
 */
function findMarkupLiteralRanges(source: string, includeHtmlRawText: boolean): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  let index = 0;

  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      const closingOffset = source.indexOf('-->', index + 4);
      index = closingOffset >= 0 ? closingOffset + 3 : source.length;
      continue;
    }

    if (source.startsWith('<![CDATA[', index)) {
      const closingOffset = source.indexOf(']]>', index + 9);
      const end = closingOffset >= 0 ? closingOffset + 3 : source.length;
      ranges.push({ start: index, end });
      index = end;
      continue;
    }

    if (source[index] !== '<') {
      index += 1;
      continue;
    }

    const tag = scanMarkupTag(source, index);
    if (!tag) {
      index += 1;
      continue;
    }

    ranges.push(...tag.quotedRanges);
    index = tag.end;

    if (
      includeHtmlRawText &&
      !tag.closing &&
      !tag.selfClosing &&
      HTML_RAW_TEXT_ELEMENTS.has(tag.name)
    ) {
      const closingTag = findClosingMarkupTag(source, index, tag.name);
      const end = closingTag?.start ?? source.length;
      if (index < end) {
        ranges.push({ start: index, end });
      }
      index = closingTag?.end ?? source.length;
    }
  }

  return mergeOffsetRanges(ranges);
}

function scanMarkupTag(source: string, start: number): ScannedMarkupTag | undefined {
  if (source[start] !== '<' || source.startsWith('<!--', start)) {
    return undefined;
  }

  let cursor = start + 1;
  let closing = false;
  if (source[cursor] === '/') {
    closing = true;
    cursor += 1;
  }

  const nameStart = cursor;
  while (cursor < source.length && /[A-Za-z0-9:_-]/.test(source[cursor]!)) {
    cursor += 1;
  }
  if (cursor === nameStart || !/[A-Za-z]/.test(source[nameStart]!)) {
    return undefined;
  }

  const name = source.slice(nameStart, cursor).toLowerCase();
  const quotedRanges: OffsetRange[] = [];
  let quote: "'" | '"' | undefined;
  let quoteStart = -1;

  while (cursor < source.length) {
    const character = source[cursor];
    if (quote) {
      if (character === quote) {
        quotedRanges.push({ start: quoteStart, end: cursor + 1 });
        quote = undefined;
        quoteStart = -1;
      }
      cursor += 1;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      quoteStart = cursor;
      cursor += 1;
      continue;
    }
    if (character === '>') {
      const beforeClosingBracket = source.slice(start, cursor).trimEnd();
      return {
        closing,
        end: cursor + 1,
        name,
        quotedRanges,
        selfClosing: beforeClosingBracket.endsWith('/'),
      };
    }
    cursor += 1;
  }

  if (quoteStart >= 0) {
    quotedRanges.push({ start: quoteStart, end: source.length });
  }
  return {
    closing,
    end: source.length,
    name,
    quotedRanges,
    selfClosing: false,
  };
}

function findClosingMarkupTag(
  source: string,
  searchFrom: number,
  name: string,
): { start: number; end: number } | undefined {
  const lowerSource = source.toLowerCase();
  const needle = `</${name}`;
  let candidate = lowerSource.indexOf(needle, searchFrom);

  while (candidate >= 0) {
    const tag = scanMarkupTag(source, candidate);
    if (tag?.closing && tag.name === name) {
      return { start: candidate, end: tag.end };
    }
    candidate = lowerSource.indexOf(needle, candidate + needle.length);
  }

  return undefined;
}

function mergeOffsetRanges(ranges: readonly OffsetRange[]): OffsetRange[] {
  const sorted = [...ranges]
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: OffsetRange[] = [];

  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

function rangeContainingOffset(
  offset: number,
  ranges: readonly OffsetRange[],
): OffsetRange | undefined {
  let low = 0;
  let high = ranges.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle]!.start <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const candidate = ranges[low - 1];
  return candidate && offset < candidate.end ? candidate : undefined;
}

interface PhysicalSourceLine {
  start: number;
  end: number;
  endIncludingNewline: number;
  text: string;
}

function physicalSourceLines(source: string): PhysicalSourceLine[] {
  const lines: PhysicalSourceLine[] = [];
  let start = 0;

  while (start <= source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline >= 0 ? newline : source.length;
    const rawText = source.slice(start, end);
    lines.push({
      start,
      end,
      endIncludingNewline: newline >= 0 ? newline + 1 : end,
      text: rawText.endsWith('\r') ? rawText.slice(0, -1) : rawText,
    });
    if (newline < 0) {
      break;
    }
    start = newline + 1;
  }

  return lines;
}

function findYamlBlockScalarRanges(source: string): OffsetRange[] {
  const lines = physicalSourceLines(source);
  const ranges: OffsetRange[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const header =
      /^( *)(?:(?:[^#]*:[ \t]*)|(?:-[ \t]+))?([|>])([+-]?[1-9]?|[1-9][+-]?)[ \t]*(?:#.*)?$/.exec(
        line.text,
      );
    if (!header) {
      continue;
    }

    const baseIndent = header[1]!.length;
    const explicitIndent = /[1-9]/.exec(header[3] ?? '')?.[0];
    let contentIndent = explicitIndent ? baseIndent + Number(explicitIndent) : undefined;
    let cursor = index + 1;

    if (contentIndent === undefined) {
      while (cursor < lines.length && lines[cursor]!.text.trim().length === 0) {
        cursor += 1;
      }
      if (cursor >= lines.length) {
        continue;
      }
      const firstIndent = /^ */.exec(lines[cursor]!.text)![0].length;
      if (firstIndent <= baseIndent) {
        continue;
      }
      contentIndent = firstIndent;
    }

    const contentStart = lines[index + 1]?.start;
    if (contentStart === undefined) {
      continue;
    }

    cursor = index + 1;
    while (cursor < lines.length) {
      const contentLine = lines[cursor]!;
      if (contentLine.text.trim().length > 0) {
        const indentation = /^ */.exec(contentLine.text)![0].length;
        if (indentation < contentIndent) {
          break;
        }
      }
      cursor += 1;
    }

    const contentEnd = lines[cursor]?.start ?? source.length;
    if (contentEnd > contentStart) {
      ranges.push({ start: contentStart, end: contentEnd });
      index = cursor - 1;
    }
  }

  return ranges;
}

function findPowerShellLiteralRanges(source: string): OffsetRange[] {
  const hereStrings = findPowerShellHereStringRanges(source);
  const ranges = [...hereStrings];
  let index = 0;

  while (index < source.length) {
    const hereString = rangeContainingOffset(index, hereStrings);
    if (hereString) {
      index = hereString.end;
      continue;
    }

    if (source.startsWith('<#', index)) {
      const closingOffset = source.indexOf('#>', index + 2);
      index = closingOffset >= 0 ? closingOffset + 2 : source.length;
      continue;
    }
    if (source[index] === '#') {
      const newline = source.indexOf('\n', index + 1);
      index = newline >= 0 ? newline + 1 : source.length;
      continue;
    }

    const quote = source[index];
    if (quote !== "'" && quote !== '"') {
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (index < source.length) {
      if (quote === '"' && source[index] === '`') {
        index += 2;
        continue;
      }
      if (source[index] === quote) {
        if (source[index + 1] === quote) {
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      index += 1;
    }
    ranges.push({ start, end: index });
  }

  return mergeOffsetRanges(ranges);
}

function findPowerShellHereStringRanges(source: string): OffsetRange[] {
  const lines = physicalSourceLines(source);
  const ranges: OffsetRange[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const opening = /@(["'])[ \t]*$/.exec(line.text);
    if (!opening) {
      continue;
    }
    const openingOffset = opening.index;
    const previous = line.text[openingOffset - 1];
    if (previous && !/\s/.test(previous) && !'=(:,;{['.includes(previous)) {
      continue;
    }

    const closingToken = `${opening[1]}@`;
    let cursor = index + 1;
    while (cursor < lines.length) {
      const candidate = lines[cursor]!.text.trimStart();
      if (
        candidate.startsWith(closingToken) &&
        /^[ \t]*(?:;.*)?$/.test(candidate.slice(closingToken.length))
      ) {
        break;
      }
      cursor += 1;
    }

    const end = lines[cursor]?.endIncludingNewline ?? source.length;
    ranges.push({ start: line.start + openingOffset, end });
    index = cursor < lines.length ? cursor : lines.length;
  }

  return ranges;
}

interface ShellHeredocDeclaration {
  delimiter: string;
  stripTabs: boolean;
}

function isShellLanguage(languageId: string): boolean {
  return ['shellscript', 'shell', 'bash', 'zsh', 'fish'].includes(languageId);
}

function findShellHeredocRanges(source: string): OffsetRange[] {
  const lines = physicalSourceLines(source);
  const ranges: OffsetRange[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const declarations = findShellHeredocDeclarations(lines[index]!.text);
    if (declarations.length === 0) {
      continue;
    }

    let cursor = index + 1;
    for (const declaration of declarations) {
      const contentStart = lines[cursor]?.start ?? source.length;
      while (cursor < lines.length) {
        const candidate = declaration.stripTabs
          ? lines[cursor]!.text.replace(/^\t+/, '')
          : lines[cursor]!.text;
        if (candidate === declaration.delimiter) {
          break;
        }
        cursor += 1;
      }

      const contentEnd = lines[cursor]?.start ?? source.length;
      if (contentEnd > contentStart) {
        ranges.push({ start: contentStart, end: contentEnd });
      }
      if (cursor >= lines.length) {
        return ranges;
      }
      cursor += 1;
    }
    index = cursor - 1;
  }

  return ranges;
}

function findShellHeredocDeclarations(line: string): ShellHeredocDeclaration[] {
  const declarations: ShellHeredocDeclaration[] = [];
  let index = 0;
  let quote: "'" | '"' | undefined;
  let arithmeticParenthesisDepth = 0;

  while (index < line.length) {
    const character = line[index];
    if (quote) {
      if (character === '\\' && quote === '"') {
        index += 2;
        continue;
      }
      if (character === quote) {
        quote = undefined;
      }
      index += 1;
      continue;
    }
    if (arithmeticParenthesisDepth > 0) {
      if (character === '(') {
        arithmeticParenthesisDepth += 1;
      } else if (character === ')') {
        arithmeticParenthesisDepth -= 1;
      }
      index += 1;
      continue;
    }
    if (line.startsWith('$((', index)) {
      arithmeticParenthesisDepth = 2;
      index += 3;
      continue;
    }
    if (line.startsWith('((', index)) {
      arithmeticParenthesisDepth = 2;
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      index += 1;
      continue;
    }
    if (character === '#' && (index === 0 || /[\s;&|()]/.test(line[index - 1] ?? ''))) {
      break;
    }
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (
      character !== '<' ||
      line[index + 1] !== '<' ||
      line[index - 1] === '<' ||
      line[index + 2] === '<'
    ) {
      index += 1;
      continue;
    }

    let cursor = index + 2;
    const stripTabs = line[cursor] === '-';
    if (stripTabs) {
      cursor += 1;
    }
    while (line[cursor] === ' ' || line[cursor] === '\t') {
      cursor += 1;
    }

    let delimiter = '';
    const delimiterQuote = line[cursor];
    if (delimiterQuote === "'" || delimiterQuote === '"') {
      cursor += 1;
      while (cursor < line.length && line[cursor] !== delimiterQuote) {
        delimiter += line[cursor];
        cursor += 1;
      }
      if (line[cursor] !== delimiterQuote) {
        index += 2;
        continue;
      }
      cursor += 1;
    } else {
      while (cursor < line.length && !/[\s;&|()<>]/.test(line[cursor]!)) {
        if (line[cursor] === '\\' && cursor + 1 < line.length) {
          cursor += 1;
        }
        delimiter += line[cursor];
        cursor += 1;
      }
    }

    if (delimiter.length > 0) {
      declarations.push({ delimiter, stripTabs });
      index = cursor;
    } else {
      index += 2;
    }
  }

  return declarations;
}

function scanHashComments(
  source: string,
  languageId: string,
  ignoredRanges: readonly OffsetRange[] = [],
): CommentRegion[] {
  const regions: CommentRegion[] = [];
  let index = 0;
  let quote: "'" | '"' | undefined;
  let tripleQuote: "'''" | '"""' | undefined;
  const supportsTripleQuotes = !languageId || languageId === 'python' || languageId === 'py';
  const supportsMultilineQuotes =
    languageId === 'yaml' || languageId === 'yml' || isShellLanguage(languageId);

  while (index < source.length) {
    const ignoredRange = rangeContainingOffset(index, ignoredRanges);
    if (ignoredRange) {
      index = ignoredRange.end;
      quote = undefined;
      tripleQuote = undefined;
      continue;
    }

    if (tripleQuote) {
      if (source[index] === '\\') {
        index += 2;
        continue;
      }
      if (source.startsWith(tripleQuote, index)) {
        index += 3;
        tripleQuote = undefined;
      } else {
        index += 1;
      }
      continue;
    }

    if (quote) {
      const character = source[index];
      const backslashEscapes =
        quote === '"' ||
        (!isShellLanguage(languageId) && languageId !== 'yaml' && languageId !== 'yml');
      if (character === '\\' && backslashEscapes) {
        index += 2;
        continue;
      }
      if (
        character === "'" &&
        quote === "'" &&
        (languageId === 'yaml' || languageId === 'yml') &&
        source[index + 1] === "'"
      ) {
        index += 2;
        continue;
      }
      if (character === quote) {
        quote = undefined;
      } else if (character === '\n' && !supportsMultilineQuotes) {
        // Recover from an unterminated ordinary quote in single-line string
        // syntaxes. YAML flow scalars and shell quotes may span lines.
        quote = undefined;
      }
      index += 1;
      continue;
    }

    if (
      supportsTripleQuotes &&
      (source.startsWith("'''", index) || source.startsWith('"""', index))
    ) {
      tripleQuote = source.slice(index, index + 3) as "'''" | '"""';
      index += 3;
      continue;
    }

    const character = source[index];
    if (character === "'" || character === '"') {
      quote = character;
      index += 1;
      continue;
    }

    if (character === '#') {
      const lineStart = source.lastIndexOf('\n', index - 1) + 1;
      const prefix = source.slice(lineStart, index);
      const newline = source.indexOf('\n', index + 1);
      const contentEnd = newline >= 0 ? newline : source.length;
      if (prefix.trim().length === 0) {
        regions.push({
          id: -1,
          kind: 'hash-line',
          contentStart: index + 1,
          contentEnd,
          openingOffset: index,
          openingColumn: index - lineStart,
          terminated: true,
        });
      }
      index = contentEnd;
      continue;
    }

    index += 1;
  }

  return regions;
}

function logicalLinesForRegion(
  source: string,
  region: CommentRegion,
  lineStarts: readonly number[],
): LogicalCommentLine[] {
  const content = source.slice(region.contentStart, region.contentEnd);
  const rawLines = splitLinesWithOffsets(content, region.contentStart);
  const prepared = rawLines.map(({ text, offset }, index) => ({
    line: lineNumberAt(offset, lineStarts),
    text: prepareBlockLine(text, index, region),
  }));
  const starDecorated =
    region.kind === 'slash-block' &&
    prepared.some(({ text }) => /^\s*\*\s*CODING-NOTE-(?:START|END)\s*$/.test(text));

  return prepared.map(({ line, text }) => ({
    regionId: region.id,
    kind: region.kind,
    line,
    text: normalizeCommentLine(text, region.kind, starDecorated),
    wrapperTerminated: region.terminated,
  }));
}

function prepareBlockLine(text: string, index: number, region: CommentRegion): string {
  const prepared = text.endsWith('\r') ? text.slice(0, -1) : text;
  if (region.kind === 'slash-line' || region.kind === 'hash-line') {
    return prepared;
  }

  if (index === 0) {
    return /^[ \t]/.test(prepared) ? prepared.slice(1) : prepared;
  }

  let removable = region.openingColumn;
  let cursor = 0;
  while (removable > 0 && (prepared[cursor] === ' ' || prepared[cursor] === '\t')) {
    cursor += 1;
    removable -= 1;
  }
  return prepared.slice(cursor);
}

function normalizeCommentLine(text: string, kind: CommentKind, starDecorated: boolean): string {
  if (kind === 'slash-line' || kind === 'hash-line') {
    return /^[ \t]/.test(text) ? text.slice(1) : text;
  }

  if (kind === 'slash-block' && starDecorated) {
    const decorated = /^\s*\*(?:[ \t]?)(.*)$/.exec(text);
    return decorated?.[1] ?? text;
  }

  return text;
}

function splitLinesWithOffsets(
  content: string,
  absoluteStart: number,
): Array<{ text: string; offset: number }> {
  const lines: Array<{ text: string; offset: number }> = [];
  let start = 0;
  for (let index = 0; index <= content.length; index += 1) {
    if (index === content.length || content[index] === '\n') {
      lines.push({ text: content.slice(start, index), offset: absoluteStart + start });
      start = index + 1;
    }
  }
  return lines;
}

function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineNumberAt(offset: number, lineStarts: readonly number[]): number {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle]! <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return Math.max(1, low);
}
