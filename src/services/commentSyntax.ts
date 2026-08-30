/**
 * Language-specific rendering and insertion planning for coding-note blocks.
 *
 * This module intentionally has no VS Code dependency. Commands can translate a
 * VS Code document/selection into offsets and apply the returned plan in one edit.
 */

import { REVIEW_END_MARKER, REVIEW_START_MARKER } from '../core';

export const CODING_NOTE_START_MARKER = REVIEW_START_MARKER;
export const CODING_NOTE_END_MARKER = REVIEW_END_MARKER;

export type CommentSyntaxKind = 'block' | 'html' | 'line' | 'jsx-expression';
export type CommentSyntaxFailureReason = 'strict-json' | 'unsupported' | 'unsafe-jsx-position';

export interface CommentSyntax {
  readonly kind: CommentSyntaxKind;
  readonly opening: string;
  readonly contentPrefix: string;
  readonly closing?: string;
}

export interface CommentSyntaxResolution {
  readonly supported: boolean;
  readonly languageId: string;
  readonly syntax?: CommentSyntax;
  readonly reason?: Exclude<CommentSyntaxFailureReason, 'unsafe-jsx-position'>;
  readonly message?: string;
}

export interface CreateCommentBlockOptions {
  readonly languageId: string;
  readonly id: string;
  readonly category: string;
  readonly status?: string;
  readonly comment?: string;
  readonly eol?: '\n' | '\r\n';
  readonly indent?: string;
  /** Use only after determining that the insertion point is a JSX child. */
  readonly jsxContext?: boolean;
}

export interface RenderedCommentBlock {
  readonly text: string;
  /** Offset within `text` at which the editor cursor should be placed. */
  readonly bodyOffset: number;
  readonly syntax: CommentSyntax;
}

export interface PlanCommentInsertionOptions extends CreateCommentBlockOptions {
  readonly documentText: string;
  readonly cursorOffset: number;
  readonly selectionStart?: number;
  readonly selectionEnd?: number;
}

export interface CommentInsertionPlan extends RenderedCommentBlock {
  readonly insertionOffset: number;
  /** Absolute offset in the document after the insertion is applied. */
  readonly cursorOffset: number;
  readonly jsxContext: JsxInsertionContext;
}

export type JsxInsertionContext = 'code' | 'child' | 'tag';

interface JsxContextAnalysis {
  readonly context: JsxInsertionContext;
  readonly tagStart?: number;
  /** Start of the current JavaScript region, excluding earlier JSX text. */
  readonly codeStart?: number;
}

interface UnsafeInsertionRegion {
  readonly start: number;
  readonly kind: 'comment' | 'literal' | 'tag' | 'raw-text' | 'cdata' | 'fence' | 'inline-code';
}

const C_BLOCK_SYNTAX: CommentSyntax = Object.freeze({
  kind: 'block',
  opening: '/*',
  contentPrefix: ' * ',
  closing: ' */',
});

const JSX_EXPRESSION_SYNTAX: CommentSyntax = Object.freeze({
  kind: 'jsx-expression',
  opening: '{/*',
  contentPrefix: ' * ',
  closing: ' */}',
});

const HTML_SYNTAX: CommentSyntax = Object.freeze({
  kind: 'html',
  opening: '<!--',
  contentPrefix: '',
  closing: '-->',
});

const HASH_LINE_SYNTAX: CommentSyntax = Object.freeze({
  kind: 'line',
  opening: '',
  contentPrefix: '# ',
});

const C_BLOCK_LANGUAGES = new Set(['typescript', 'javascript', 'css', 'scss', 'less', 'jsonc']);

const JSX_LANGUAGES = new Set(['typescriptreact', 'javascriptreact', 'tsx', 'jsx']);

const HTML_LANGUAGES = new Set(['html', 'xml', 'svg', 'markdown']);
const MDX_LANGUAGES = new Set(['mdx']);

const HASH_LINE_LANGUAGES = new Set([
  'yaml',
  'yml',
  'python',
  'shellscript',
  'shell',
  'bash',
  'zsh',
  'fish',
  'powershell',
]);

const STRICT_JSON_LANGUAGES = new Set(['json', 'jsonl']);

/** Error intended to be caught and shown as a friendly command message. */
export class UnsupportedCommentSyntaxError extends Error {
  public constructor(
    public readonly reason: CommentSyntaxFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedCommentSyntaxError';
  }
}

/** Backward-compatible domain name; both classes are caught the same way. */
export class CommentSyntaxError extends UnsupportedCommentSyntaxError {
  public constructor(reason: CommentSyntaxFailureReason, message: string) {
    super(reason, message);
    this.name = 'CommentSyntaxError';
  }
}

export function normalizeLanguageId(languageId: string): string {
  return languageId.trim().toLowerCase();
}

export function isJsxLanguage(languageId: string): boolean {
  return JSX_LANGUAGES.has(normalizeLanguageId(languageId));
}

export function resolveCommentSyntax(
  languageId: string,
  options: { readonly jsxContext?: boolean } = {},
): CommentSyntaxResolution {
  const normalized = normalizeLanguageId(languageId);

  if (STRICT_JSON_LANGUAGES.has(normalized)) {
    return {
      supported: false,
      languageId: normalized,
      reason: 'strict-json',
      message:
        'Coding Notes for AI comments cannot be inserted into strict JSON because JSON does not permit comments.',
    };
  }

  if (JSX_LANGUAGES.has(normalized)) {
    return {
      supported: true,
      languageId: normalized,
      syntax: options.jsxContext ? JSX_EXPRESSION_SYNTAX : C_BLOCK_SYNTAX,
    };
  }

  // MDX uses JavaScript expression comments. HTML comments are accepted by
  // Markdown but are not valid MDX syntax in common MDX toolchains.
  if (MDX_LANGUAGES.has(normalized)) {
    return {
      supported: true,
      languageId: normalized,
      syntax: JSX_EXPRESSION_SYNTAX,
    };
  }

  if (C_BLOCK_LANGUAGES.has(normalized)) {
    return { supported: true, languageId: normalized, syntax: C_BLOCK_SYNTAX };
  }

  if (HTML_LANGUAGES.has(normalized)) {
    return { supported: true, languageId: normalized, syntax: HTML_SYNTAX };
  }

  if (HASH_LINE_LANGUAGES.has(normalized)) {
    return { supported: true, languageId: normalized, syntax: HASH_LINE_SYNTAX };
  }

  return {
    supported: false,
    languageId: normalized,
    reason: 'unsupported',
    message: `Coding Notes for AI does not have a safe comment wrapper for language "${languageId}".`,
  };
}

/** Returns undefined for strict JSON and unsupported language identifiers. */
export function getCommentSyntax(
  languageId: string,
  options: { readonly jsxContext?: boolean } = {},
): CommentSyntax | undefined {
  return resolveCommentSyntax(languageId, options).syntax;
}

export function requireCommentSyntax(
  languageId: string,
  options: { readonly jsxContext?: boolean } = {},
): CommentSyntax {
  const resolution = resolveCommentSyntax(languageId, options);
  if (!resolution.supported || !resolution.syntax) {
    throw new CommentSyntaxError(
      resolution.reason ?? 'unsupported',
      resolution.message ?? `Unsupported language: ${languageId}`,
    );
  }
  return resolution.syntax;
}

export function createCommentBlock(options: CreateCommentBlockOptions): RenderedCommentBlock {
  const syntax = requireCommentSyntax(options.languageId, {
    jsxContext: options.jsxContext === true,
  });
  validateMetadata('id', options.id, syntax);
  validateMetadata('category', options.category, syntax);
  validateMetadata('status', options.status ?? 'open', syntax);
  if (options.comment !== undefined) {
    validateCommentContent(options.comment, syntax);
  }
  const eol = options.eol ?? '\n';
  const indent = options.indent ?? '';
  const commentLines = options.comment === undefined ? [''] : splitLines(options.comment);
  const canonicalLines = [
    CODING_NOTE_START_MARKER,
    `id: ${options.id}`,
    `category: ${options.category}`,
    `status: ${options.status ?? 'open'}`,
    'comment:',
    ...commentLines,
    CODING_NOTE_END_MARKER,
  ];

  const outputLines: string[] = [];
  if (syntax.opening) {
    outputLines.push(`${indent}${syntax.opening}`);
  }

  const bodyLineIndex = outputLines.length + 5;
  for (const line of canonicalLines) {
    outputLines.push(`${indent}${syntax.contentPrefix}${line}`);
  }

  if (syntax.closing) {
    outputLines.push(`${indent}${syntax.closing}`);
  }

  const text = outputLines.join(eol);
  let bodyOffset = 0;
  for (let index = 0; index < bodyLineIndex; index += 1) {
    bodyOffset += outputLines[index]!.length + eol.length;
  }
  bodyOffset += indent.length + syntax.contentPrefix.length;

  return { text, bodyOffset, syntax };
}

/** More explicit alias for callers that prefer the domain name. */
export const createReviewCommentBlock = createCommentBlock;

/**
 * Build a syntax-safe insertion edit and the resulting cursor position.
 *
 * A non-empty selection is never replaced: the block is inserted immediately
 * above the selection's first line. A cursor in indentation is treated the same
 * way. Safe mid-line cursors remain exact so block comments can be placed in an
 * expression. Positions inside literals, existing comments, markup-only regions,
 * and other constructs that would hide or corrupt the note are moved to the
 * nearest safe line boundary without replacing source text.
 */
export function planCommentInsertion(options: PlanCommentInsertionOptions): CommentInsertionPlan {
  assertOffset(options.cursorOffset, options.documentText.length, 'cursorOffset');
  const selectionStart = options.selectionStart ?? options.cursorOffset;
  const selectionEnd = options.selectionEnd ?? selectionStart;
  assertOffset(selectionStart, options.documentText.length, 'selectionStart');
  assertOffset(selectionEnd, options.documentText.length, 'selectionEnd');

  const firstSelectionOffset = Math.min(selectionStart, selectionEnd);
  const hasSelection = selectionStart !== selectionEnd;
  let insertionOffset = hasSelection
    ? lineStartAt(options.documentText, firstSelectionOffset)
    : options.cursorOffset;

  if (!hasSelection) {
    const currentLineStart = lineStartAt(options.documentText, insertionOffset);
    const beforeCursor = options.documentText.slice(currentLineStart, insertionOffset);
    if (/^[\t ]*$/.test(beforeCursor)) {
      insertionOffset = currentLineStart;
    }
  }

  // A line comment inserted after source text would comment out the rest of the
  // original line (and attach it to the end marker). Relocate the whole block
  // immediately above that line so the original source remains byte-for-byte.
  const baseSyntax = requireCommentSyntax(options.languageId);
  let needsLeadingEol = false;
  let relocatedAfterHeader = false;
  if (baseSyntax.kind === 'line') {
    insertionOffset = lineStartAt(options.documentText, insertionOffset);
    const unsafeLineRegion = findUnsafeLineLanguageInsertionRegion(
      options.documentText,
      insertionOffset,
      options.languageId,
    );
    if (unsafeLineRegion) {
      insertionOffset = lineStartAt(options.documentText, unsafeLineRegion.start);
    }
    const protectedHeaderEnd = findProtectedLineHeaderEnd(options.documentText, options.languageId);
    if (insertionOffset < protectedHeaderEnd) {
      insertionOffset = protectedHeaderEnd;
      relocatedAfterHeader = true;
      needsLeadingEol =
        protectedHeaderEnd === options.documentText.length &&
        !endsWithLineBreak(options.documentText);
    }
  }

  if (isMarkupDocumentLanguage(options.languageId)) {
    const unsafeMarkupRegion = findUnsafeMarkupInsertionRegion(
      options.documentText,
      insertionOffset,
      options.languageId,
    );
    if (unsafeMarkupRegion) {
      insertionOffset = lineStartAt(options.documentText, unsafeMarkupRegion.start);
    }
  }

  let jsxAnalysis: JsxContextAnalysis = { context: 'code' };
  if (isJsxLanguage(options.languageId)) {
    jsxAnalysis = analyzeJsxInsertionContext(options.documentText, insertionOffset);
    if (jsxAnalysis.context === 'tag' && jsxAnalysis.tagStart !== undefined) {
      insertionOffset = lineStartAt(options.documentText, jsxAnalysis.tagStart);
      jsxAnalysis = analyzeJsxInsertionContext(options.documentText, insertionOffset);
    }
  }

  if (baseSyntax.kind === 'block' && jsxAnalysis.context === 'code') {
    const unsafeJavaScriptRegion = findUnsafeJavaScriptInsertionRegion(
      options.documentText,
      insertionOffset,
      jsxAnalysis.codeStart ?? 0,
    );
    if (unsafeJavaScriptRegion) {
      insertionOffset = lineStartAt(options.documentText, unsafeJavaScriptRegion.start);
      if (isJsxLanguage(options.languageId)) {
        jsxAnalysis = analyzeJsxInsertionContext(options.documentText, insertionOffset);
      }
    }
  }

  const eol = options.eol ?? detectEol(options.documentText);
  const lineStart = lineStartAt(options.documentText, insertionOffset);
  const lineEnd = lineEndAt(options.documentText, insertionOffset);
  const indentationSource =
    insertionOffset === lineStart
      ? options.documentText.slice(lineStart, lineEnd)
      : options.documentText.slice(lineStart, insertionOffset);
  const indentationMatch = indentationSource.match(/^[\t ]*/);
  const inferredIndent =
    options.indent ??
    (relocatedAfterHeader
      ? ''
      : insertionOffset === lineStart
        ? (indentationMatch?.[0] ?? '')
        : '');
  const rendered = createCommentBlock({
    ...options,
    eol,
    indent: inferredIndent,
    jsxContext: jsxAnalysis.context === 'child',
  });

  const atLineBoundary = insertionOffset === lineStart;
  const suffix = atLineBoundary && insertionOffset < options.documentText.length ? eol : '';
  const prefix = needsLeadingEol ? eol : '';
  const text = prefix + rendered.text + suffix;
  const bodyOffset = prefix.length + rendered.bodyOffset;

  return {
    ...rendered,
    text,
    bodyOffset,
    insertionOffset,
    cursorOffset: insertionOffset + bodyOffset,
    jsxContext: jsxAnalysis.context,
  };
}

export function detectJsxInsertionContext(source: string, offset: number): JsxInsertionContext {
  assertOffset(offset, source.length, 'offset');
  return analyzeJsxInsertionContext(source, offset).context;
}

function analyzeJsxInsertionContext(source: string, offset: number): JsxContextAnalysis {
  const prefix = source.slice(0, offset);
  type Mode = 'code' | 'jsx-text' | 'expression';
  let mode: Mode = 'code';
  let expressionBraceDepth = 0;
  const elementReturnModes: Mode[] = [];
  let codeStart = 0;
  let index = 0;

  while (index < prefix.length) {
    const character = prefix[index];

    if (mode === 'code' || mode === 'expression') {
      const tokenEnd = skipJavaScriptStringOrComment(prefix, index);
      if (tokenEnd !== undefined) {
        index = tokenEnd;
        continue;
      }
    }

    if (mode === 'jsx-text' && character === '{') {
      mode = 'expression';
      codeStart = index + 1;
      expressionBraceDepth = 1;
      index += 1;
      continue;
    }

    if (mode === 'expression') {
      if (character === '{') {
        expressionBraceDepth += 1;
        index += 1;
        continue;
      }
      if (character === '}') {
        expressionBraceDepth -= 1;
        if (expressionBraceDepth === 0) {
          mode = 'jsx-text';
        }
        index += 1;
        continue;
      }
    }

    if (character !== '<') {
      index += 1;
      continue;
    }

    const parsed = parseJsxTag(prefix, index);
    const canOpen =
      mode === 'jsx-text' ||
      ((mode === 'code' || mode === 'expression') && canStartRootJsx(prefix, index));
    if (!parsed || (parsed.closing ? mode !== 'jsx-text' : !canOpen)) {
      index += 1;
      continue;
    }
    if (parsed.incomplete) {
      return { context: 'tag', tagStart: index };
    }

    if (parsed.closing) {
      const returnMode = elementReturnModes.pop();
      if (returnMode) {
        mode = returnMode;
        if (mode === 'code' || mode === 'expression') {
          codeStart = parsed.end;
        }
      }
    } else if (!parsed.selfClosing) {
      elementReturnModes.push(mode);
      mode = 'jsx-text';
    } else if (mode === 'code' || mode === 'expression') {
      codeStart = parsed.end;
    }

    index = parsed.end;
  }

  return mode === 'jsx-text' ? { context: 'child' } : { context: 'code', codeStart };
}

interface ParsedJsxTag {
  readonly end: number;
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly incomplete: boolean;
}

function parseJsxTag(source: string, start: number): ParsedJsxTag | undefined {
  let index = start + 1;
  let closing = false;
  if (source[index] === '/') {
    closing = true;
    index += 1;
  }
  while (
    source[index] === ' ' ||
    source[index] === '\t' ||
    source[index] === '\r' ||
    source[index] === '\n'
  ) {
    index += 1;
  }

  // Fragments (`<>` and `</>`) and normal JSX element names are supported.
  if (source[index] !== '>' && !/[A-Za-z]/.test(source[index] ?? '')) {
    return undefined;
  }

  let name = '';
  if (source[index] !== '>') {
    const nameStart = index;
    index += 1;
    while (/[A-Za-z0-9_.:-]/.test(source[index] ?? '')) {
      index += 1;
    }
    name = source.slice(nameStart, index);
    if (!/[\s/>]/.test(source[index] ?? '')) {
      return undefined;
    }
  }

  let braceDepth = 0;
  for (; index < source.length; index += 1) {
    const character = source[index];
    const quotedEnd = skipQuotedString(source, index);
    if (quotedEnd !== undefined) {
      index = quotedEnd - 1;
    } else if (braceDepth > 0) {
      const commentEnd = skipJavaScriptComment(source, index);
      if (commentEnd !== undefined) {
        index = commentEnd - 1;
        continue;
      }
      if (character === '{') {
        braceDepth += 1;
      } else if (character === '}') {
        braceDepth -= 1;
      }
    } else if (character === '{') {
      braceDepth += 1;
    } else if (character === '>' && braceDepth === 0) {
      let previous = index - 1;
      while (/\s/.test(source[previous] ?? '')) {
        previous -= 1;
      }
      return {
        end: index + 1,
        name,
        closing,
        selfClosing: !closing && source[previous] === '/',
        incomplete: false,
      };
    }
  }

  return { end: source.length, name, closing, selfClosing: false, incomplete: true };
}

function canStartRootJsx(source: string, lessThan: number): boolean {
  const before = source.slice(0, lessThan).trimEnd();
  if (before.length === 0) {
    return true;
  }
  const previous = before[before.length - 1] ?? '';
  if ('([{=,:;!?'.includes(previous)) {
    return true;
  }
  return /(?:\breturn|=>)$/.test(before);
}

function isMarkupDocumentLanguage(languageId: string): boolean {
  const normalized = normalizeLanguageId(languageId);
  return HTML_LANGUAGES.has(normalized) || MDX_LANGUAGES.has(normalized);
}

function findUnsafeJavaScriptInsertionRegion(
  source: string,
  offset: number,
  scanStart: number,
): UnsafeInsertionRegion | undefined {
  type Frame =
    | { readonly kind: 'code' }
    | { readonly kind: 'quote'; readonly quote: "'" | '"'; readonly start: number }
    | {
        readonly kind: 'template';
        readonly start: number;
        phase: 'raw' | 'expression';
        braceDepth: number;
      };

  const frames: Frame[] = [{ kind: 'code' }];
  let index = Math.max(0, scanStart);
  while (index < offset) {
    const frame = frames[frames.length - 1]!;
    const character = source[index];

    if (frame.kind === 'quote') {
      if (character === '\\') {
        index += 2;
      } else if (character === frame.quote) {
        frames.pop();
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }

    if (frame.kind === 'template' && frame.phase === 'raw') {
      if (character === '\\') {
        index += 2;
      } else if (character === '`') {
        frames.pop();
        index += 1;
      } else if (character === '$' && source[index + 1] === '{') {
        if (offset <= index + 1) {
          return { start: frame.start, kind: 'literal' };
        }
        frame.phase = 'expression';
        frame.braceDepth = 0;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    const commentEnd = skipJavaScriptComment(source, index);
    if (commentEnd !== undefined) {
      if (commentEnd > offset) {
        return { start: index, kind: 'comment' };
      }
      index = commentEnd;
      continue;
    }

    if (character === "'" || character === '"') {
      frames.push({ kind: 'quote', quote: character, start: index });
      index += 1;
      continue;
    }
    if (character === '`') {
      frames.push({ kind: 'template', start: index, phase: 'raw', braceDepth: 0 });
      index += 1;
      continue;
    }

    if (frame.kind === 'template') {
      if (character === '{') {
        frame.braceDepth += 1;
      } else if (character === '}') {
        if (frame.braceDepth === 0) {
          frame.phase = 'raw';
        } else {
          frame.braceDepth -= 1;
        }
      }
    }
    index += 1;
  }

  const frame = frames[frames.length - 1]!;
  if (frame.kind === 'quote') {
    return { start: frame.start, kind: 'literal' };
  }
  if (frame.kind === 'template' && frame.phase === 'raw') {
    return { start: frame.start, kind: 'literal' };
  }
  return undefined;
}

function findUnsafeMarkupInsertionRegion(
  source: string,
  offset: number,
  languageId: string,
): UnsafeInsertionRegion | undefined {
  const normalized = normalizeLanguageId(languageId);
  if (normalized === 'markdown' || normalized === 'mdx') {
    const fence = findOpenMarkdownFence(source, offset);
    if (fence !== undefined) {
      return { start: fence, kind: 'fence' };
    }
    const inlineCode = findOpenMarkdownInlineCode(source, offset);
    if (inlineCode !== undefined) {
      return { start: inlineCode, kind: 'inline-code' };
    }
  }

  if (normalized === 'mdx') {
    const mdxCommentStart = source.lastIndexOf('{/*', offset - 1);
    const mdxCommentEnd = source.lastIndexOf('*/}', offset - 1);
    if (mdxCommentStart > mdxCommentEnd) {
      return { start: mdxCommentStart, kind: 'comment' };
    }
  }

  return findUnsafeMarkupStructureRegion(source, offset);
}

function findUnsafeLineLanguageInsertionRegion(
  source: string,
  offset: number,
  languageId: string,
): UnsafeInsertionRegion | undefined {
  const normalized = normalizeLanguageId(languageId);
  if (normalized === 'python') {
    const tripleQuote = findPythonTripleQuotedString(source, offset);
    if (tripleQuote !== undefined) {
      return { start: tripleQuote, kind: 'literal' };
    }
  }

  if (normalized === 'yaml' || normalized === 'yml') {
    const blockScalar = findYamlBlockScalar(source, offset);
    if (blockScalar !== undefined) {
      return { start: blockScalar, kind: 'literal' };
    }
  }

  if (
    normalized === 'shellscript' ||
    normalized === 'shell' ||
    normalized === 'bash' ||
    normalized === 'zsh' ||
    normalized === 'fish'
  ) {
    const heredoc = findShellHeredoc(source, offset);
    if (heredoc !== undefined) {
      return { start: heredoc, kind: 'literal' };
    }
    return findUnsafeJavaScriptInsertionRegion(source, offset, 0);
  }

  if (normalized === 'powershell') {
    const blockComment = findDelimitedRegion(source, offset, '<#', '#>');
    if (blockComment !== undefined) {
      return { start: blockComment, kind: 'comment' };
    }
    const hereString = findPowerShellHereString(source, offset);
    if (hereString !== undefined) {
      return { start: hereString, kind: 'literal' };
    }
    return findUnsafeJavaScriptInsertionRegion(source, offset, 0);
  }

  return undefined;
}

function findPythonTripleQuotedString(source: string, offset: number): number | undefined {
  let active: { readonly start: number; readonly delimiter: "'''" | '"""' } | undefined;
  let index = 0;
  while (index < offset) {
    if (active) {
      const closing = source.indexOf(active.delimiter, index);
      if (closing < 0 || closing + active.delimiter.length > offset) {
        return active.start;
      }
      active = undefined;
      index = closing + 3;
      continue;
    }

    if (source[index] === '#') {
      const newline = source.indexOf('\n', index + 1);
      index = newline < 0 ? offset : newline + 1;
      continue;
    }
    const delimiter = source.startsWith("'''", index)
      ? "'''"
      : source.startsWith('"""', index)
        ? '"""'
        : undefined;
    if (delimiter) {
      active = { start: index, delimiter };
      index += 3;
      continue;
    }
    if (source[index] === "'" || source[index] === '"') {
      const end = skipQuotedString(source, index);
      if (end !== undefined) {
        index = Math.min(end, offset);
        continue;
      }
    }
    index += 1;
  }
  return active?.start;
}

function findYamlBlockScalar(source: string, offset: number): number | undefined {
  let active: { readonly start: number; readonly indentation: number } | undefined;
  let lineStart = 0;
  while (lineStart < offset) {
    const lineEnd = lineEndAt(source, lineStart);
    const line = source.slice(lineStart, lineEnd).replace(/\r$/, '');
    const indentation = leadingWhitespaceWidth(line);
    if (active && line.trim().length > 0 && indentation <= active.indentation) {
      active = undefined;
    }
    if (!active && isYamlBlockScalarHeader(line)) {
      active = { start: lineStart, indentation };
    }
    if (lineEnd >= offset) {
      break;
    }
    lineStart = lineEnd + 1;
  }

  if (active) {
    const currentLine = source.slice(offset, lineEndAt(source, offset)).replace(/\r$/, '');
    if (
      currentLine.trim().length > 0 &&
      leadingWhitespaceWidth(currentLine) <= active.indentation
    ) {
      return undefined;
    }
  }
  return active?.start;
}

function isYamlBlockScalarHeader(line: string): boolean {
  const withoutComment = line.replace(/\s+#.*$/, '').trimEnd();
  return /(?:^|:\s+|-\s+)[>|](?:[+-]?[1-9]?|[1-9][+-]?)$/.test(withoutComment);
}

function findShellHeredoc(source: string, offset: number): number | undefined {
  let active:
    { readonly start: number; readonly delimiter: string; readonly stripTabs: boolean } | undefined;
  let lineStart = 0;
  while (lineStart < offset) {
    const lineEnd = lineEndAt(source, lineStart);
    const line = source.slice(lineStart, lineEnd).replace(/\r$/, '');
    if (active) {
      const candidate = active.stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === active.delimiter) {
        active = undefined;
      }
    } else {
      const opening = /<<(-)?\s*(?:['"]([^'"]+)['"]|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
      const delimiter = opening?.[2] ?? opening?.[3];
      if (opening && delimiter) {
        active = { start: lineStart, delimiter, stripTabs: opening[1] === '-' };
      }
    }
    if (lineEnd >= offset) {
      break;
    }
    lineStart = lineEnd + 1;
  }
  return active?.start;
}

function findPowerShellHereString(source: string, offset: number): number | undefined {
  let active: { readonly start: number; readonly quote: "'" | '"' } | undefined;
  let lineStart = 0;
  while (lineStart < offset) {
    const lineEnd = lineEndAt(source, lineStart);
    const line = source.slice(lineStart, lineEnd).replace(/\r$/, '');
    if (active) {
      if (line.trim() === `${active.quote}@`) {
        active = undefined;
      }
    } else {
      const opening = /@(['"])\s*$/.exec(line);
      if (opening) {
        active = { start: lineStart + opening.index, quote: opening[1] as "'" | '"' };
      }
    }
    if (lineEnd >= offset) {
      break;
    }
    lineStart = lineEnd + 1;
  }
  return active?.start;
}

function findDelimitedRegion(
  source: string,
  offset: number,
  opening: string,
  closing: string,
): number | undefined {
  let depth = 0;
  let activeStart: number | undefined;
  let index = 0;
  while (index < offset) {
    if (source.startsWith(opening, index)) {
      if (depth === 0) {
        activeStart = index;
      }
      depth += 1;
      index += opening.length;
    } else if (depth > 0 && source.startsWith(closing, index)) {
      depth -= 1;
      if (depth === 0) {
        activeStart = undefined;
      }
      index += closing.length;
    } else {
      index += 1;
    }
  }
  return activeStart;
}

function leadingWhitespaceWidth(line: string): number {
  return /^[\t ]*/.exec(line)?.[0].length ?? 0;
}

function findOpenMarkdownFence(source: string, offset: number): number | undefined {
  let open:
    { readonly start: number; readonly marker: '`' | '~'; readonly length: number } | undefined;
  let lineStart = 0;

  while (lineStart < offset) {
    const fullLineEnd = lineEndAt(source, lineStart);
    const inspectedEnd = Math.min(fullLineEnd, offset);
    const line = source.slice(lineStart, inspectedEnd).replace(/\r$/, '');
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (match) {
      const run = match[1]!;
      const marker = run[0] as '`' | '~';
      if (!open) {
        open = { start: lineStart, marker, length: run.length };
      } else if (
        marker === open.marker &&
        run.length >= open.length &&
        (match[2] ?? '').trim().length === 0
      ) {
        open = undefined;
      }
    }

    if (fullLineEnd >= offset) {
      break;
    }
    lineStart = fullLineEnd + 1;
  }

  return open?.start;
}

function findOpenMarkdownInlineCode(source: string, offset: number): number | undefined {
  const lineStart = lineStartAt(source, offset);
  let opening: { readonly start: number; readonly length: number } | undefined;
  let index = lineStart;

  while (index < offset) {
    if (source[index] !== '`' || isBackslashEscaped(source, index, lineStart)) {
      index += 1;
      continue;
    }
    let runEnd = index + 1;
    while (runEnd < offset && source[runEnd] === '`') {
      runEnd += 1;
    }
    const length = runEnd - index;
    if (!opening) {
      opening = { start: index, length };
    } else if (opening.length === length) {
      opening = undefined;
    }
    index = runEnd;
  }

  return opening?.start;
}

function findUnsafeMarkupStructureRegion(
  source: string,
  offset: number,
): UnsafeInsertionRegion | undefined {
  let index = 0;
  while (index < offset) {
    const tagStart = source.indexOf('<', index);
    if (tagStart < 0 || tagStart >= offset) {
      break;
    }

    if (source.startsWith('<!--', tagStart)) {
      const closing = source.indexOf('-->', tagStart + 4);
      const end = closing < 0 ? source.length : closing + 3;
      if (offset < end) {
        return { start: tagStart, kind: 'comment' };
      }
      index = end;
      continue;
    }

    if (source.startsWith('<![CDATA[', tagStart)) {
      const closing = source.indexOf(']]>', tagStart + 9);
      const end = closing < 0 ? source.length : closing + 3;
      if (offset < end) {
        return { start: tagStart, kind: 'cdata' };
      }
      index = end;
      continue;
    }

    if (source.startsWith('<?', tagStart)) {
      const closing = source.indexOf('?>', tagStart + 2);
      const end = closing < 0 ? source.length : closing + 2;
      if (offset < end) {
        return { start: tagStart, kind: 'tag' };
      }
      index = end;
      continue;
    }

    const parsed = parseJsxTag(source, tagStart);
    if (!parsed) {
      index = tagStart + 1;
      continue;
    }
    if (parsed.incomplete || offset < parsed.end) {
      return { start: tagStart, kind: 'tag' };
    }

    const rawName = parsed.name.toLowerCase();
    if (
      !parsed.closing &&
      !parsed.selfClosing &&
      (rawName === 'script' || rawName === 'style' || rawName === 'textarea' || rawName === 'title')
    ) {
      const closing = findRawTextClosingTag(source, parsed.end, rawName);
      if (!closing || offset < closing.end) {
        return { start: tagStart, kind: 'raw-text' };
      }
      index = closing.end;
      continue;
    }

    index = parsed.end;
  }

  return undefined;
}

function findRawTextClosingTag(
  source: string,
  searchStart: number,
  tagName: string,
): { readonly start: number; readonly end: number } | undefined {
  const expression = new RegExp(`<\\/\\s*${tagName}\\s*>`, 'gi');
  expression.lastIndex = searchStart;
  const match = expression.exec(source);
  return match ? { start: match.index, end: match.index + match[0].length } : undefined;
}

function findProtectedLineHeaderEnd(source: string, languageId: string): number {
  const firstLines = firstPhysicalLines(source, 2);
  let protectedEnd = 0;
  const firstText = firstLines[0]?.text.replace(/^\uFEFF/, '') ?? '';
  if (firstText.startsWith('#!')) {
    protectedEnd = firstLines[0]?.endIncludingEol ?? 0;
  }

  if (normalizeLanguageId(languageId) === 'python') {
    const encodingCookie = /^[\t \f]*#.*?coding[=:][\t ]*[-_.A-Za-z0-9]+/;
    for (const line of firstLines) {
      if (encodingCookie.test(line.text.replace(/^\uFEFF/, ''))) {
        protectedEnd = Math.max(protectedEnd, line.endIncludingEol);
      }
    }
  }
  return protectedEnd;
}

function firstPhysicalLines(
  source: string,
  count: number,
): Array<{ readonly text: string; readonly endIncludingEol: number }> {
  const lines: Array<{ readonly text: string; readonly endIncludingEol: number }> = [];
  let start = 0;
  while (lines.length < count && start < source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline < 0 ? source.length : newline;
    const textEnd = end > start && source[end - 1] === '\r' ? end - 1 : end;
    lines.push({
      text: source.slice(start, textEnd),
      endIncludingEol: newline < 0 ? source.length : newline + 1,
    });
    if (newline < 0) {
      break;
    }
    start = newline + 1;
  }
  return lines;
}

function isBackslashEscaped(source: string, offset: number, boundary: number): boolean {
  let backslashes = 0;
  for (let index = offset - 1; index >= boundary && source[index] === '\\'; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function endsWithLineBreak(source: string): boolean {
  return source.endsWith('\n') || source.endsWith('\r');
}

function skipJavaScriptStringOrComment(source: string, start: number): number | undefined {
  return skipQuotedString(source, start) ?? skipJavaScriptComment(source, start);
}

function skipQuotedString(source: string, start: number): number | undefined {
  const quote = source[start];
  if (quote !== "'" && quote !== '"' && quote !== '`') {
    return undefined;
  }
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
    } else if (source[index] === quote) {
      return index + 1;
    }
  }
  return source.length;
}

function skipJavaScriptComment(source: string, start: number): number | undefined {
  if (source[start] !== '/') {
    return undefined;
  }
  if (source[start + 1] === '/') {
    const newline = source.indexOf('\n', start + 2);
    return newline < 0 ? source.length : newline + 1;
  }
  if (source[start + 1] === '*') {
    const closing = source.indexOf('*/', start + 2);
    return closing < 0 ? source.length : closing + 2;
  }
  return undefined;
}

function validateMetadata(field: string, value: string, syntax: CommentSyntax): void {
  if (!value || /[\r\n\u2028\u2029]/.test(value)) {
    throw new TypeError(`${field} must be a non-empty, single-line value.`);
  }
  validateWrapperContent(field, value, syntax);
}

function validateCommentContent(value: string, syntax: CommentSyntax): void {
  validateWrapperContent('comment', value, syntax);
}

function validateWrapperContent(field: string, value: string, syntax: CommentSyntax): void {
  const forbidden = syntax.kind === 'html' ? '--' : syntax.kind === 'line' ? undefined : '*/';
  if (forbidden && value.includes(forbidden)) {
    throw new TypeError(
      `${field} contains the reserved sequence "${forbidden}", which would terminate the comment wrapper.`,
    );
  }
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/);
}

function lineStartAt(source: string, offset: number): number {
  const newline = source.lastIndexOf('\n', Math.max(0, offset - 1));
  return newline < 0 ? 0 : newline + 1;
}

function lineEndAt(source: string, offset: number): number {
  const newline = source.indexOf('\n', offset);
  return newline < 0 ? source.length : newline;
}

function detectEol(source: string): '\n' | '\r\n' {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function assertOffset(offset: number, length: number, name: string): void {
  if (!Number.isInteger(offset) || offset < 0 || offset > length) {
    throw new RangeError(`${name} must be an integer between 0 and ${length}.`);
  }
}
