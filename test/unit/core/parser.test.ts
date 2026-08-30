import { describe, expect, it } from 'vitest';

import { findDuplicateReviewIds, parseReviewComments, type ReviewComment } from '../../../src/core';

const ID = '11111111-1111-4111-8111-111111111111';

function fields(id = ID, body: readonly string[] = ['Describe the issue.']): string[] {
  return [
    'CODING-NOTE-START',
    `id: ${id}`,
    'category: Accessibility',
    'status: open',
    'comment:',
    ...body,
    'CODING-NOTE-END',
  ];
}

function starBlock(id = ID, body?: readonly string[]): string {
  return ['/*', ...fields(id, body).map((line) => ` * ${line}`), ' */'].join('\n');
}

function htmlBlock(id = ID, body?: readonly string[]): string {
  return ['<!--', ...fields(id, body), '-->'].join('\n');
}

function lineBlock(delimiter: '//' | '#', id = ID, body?: readonly string[]): string {
  return fields(id, body)
    .map((line) => `${delimiter} ${line}`)
    .join('\n');
}

describe('parseReviewComments wrappers', () => {
  it.each([
    ['typescript', 'file.ts'],
    ['typescriptreact', 'file.tsx'],
    ['javascript', 'file.js'],
    ['javascriptreact', 'file.jsx'],
    ['css', 'file.css'],
    ['scss', 'file.scss'],
    ['less', 'file.less'],
  ])('parses a decorated block comment for %s', (languageId, relativePath) => {
    const source = `const before = true;\n${starBlock()}\nconst after = true;`;
    const result = parseReviewComments(source, {
      workspaceFolder: 'workspace',
      relativePath,
      languageId,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments).toEqual([
      {
        workspaceFolder: 'workspace',
        relativePath,
        startLine: 3,
        endLine: 9,
        id: ID,
        category: 'Accessibility',
        status: 'open',
        comment: 'Describe the issue.',
      },
    ]);
  });

  it.each([
    ['html', 'file.html'],
    ['xml', 'file.xml'],
    ['svg', 'file.svg'],
    ['markdown', 'file.md'],
    ['mdx', 'file.mdx'],
  ])('parses an HTML comment for %s', (languageId, relativePath) => {
    const result = parseReviewComments(htmlBlock(), { languageId, relativePath });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments[0]).toMatchObject({
      startLine: 2,
      endLine: 8,
      comment: 'Describe the issue.',
    });
  });

  it.each([
    ['yaml', 'file.yaml'],
    ['python', 'file.py'],
    ['shellscript', 'file.sh'],
    ['powershell', 'file.ps1'],
  ])('parses hash line comments for %s', (languageId, relativePath) => {
    const result = parseReviewComments(lineBlock('#'), { languageId, relativePath });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments[0]).toMatchObject({ startLine: 1, endLine: 7, id: ID });
  });

  it('parses JSONC line comments', () => {
    const result = parseReviewComments(lineBlock('//'), {
      languageId: 'jsonc',
      relativePath: 'settings.jsonc',
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments).toHaveLength(1);
  });

  it('parses TSX-style brace-wrapped block comments', () => {
    const source = [
      '<section>',
      '  {/*',
      ...fields().map((line) => `   * ${line}`),
      '   */}',
      '</section>',
    ].join('\n');
    const result = parseReviewComments(source, { languageId: 'typescriptreact' });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments[0]).toMatchObject({ startLine: 3, endLine: 9 });
  });

  it('parses PowerShell block comments', () => {
    const source = ['<#', ...fields(), '#>'].join('\n');
    const result = parseReviewComments(source, { languageId: 'powershell' });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments).toHaveLength(1);
  });
});

describe('parseReviewComments content and recovery', () => {
  it('supports LF and CRLF without leaking carriage returns', () => {
    const lf = parseReviewComments(starBlock(), { relativePath: 'file.ts' });
    const crlf = parseReviewComments(starBlock().replace(/\n/g, '\r\n'), {
      relativePath: 'file.ts',
    });

    expect(crlf).toEqual(lf);
    expect(crlf.comments[0]?.comment).not.toContain('\r');
  });

  it('parses multiple blocks in one file', () => {
    const secondId = '22222222-2222-4222-8222-222222222222';
    const result = parseReviewComments(`${starBlock()}\nconst value = 1;\n${starBlock(secondId)}`, {
      relativePath: 'file.ts',
    });

    expect(result.comments.map((comment) => comment.id)).toEqual([ID, secondId]);
    expect(result.diagnostics).toEqual([]);
  });

  it('preserves multiline text and meaningful indentation or leading stars', () => {
    const result = parseReviewComments(
      starBlock(ID, ['First line', '  indented line', '*literal star']),
      {
        languageId: 'typescript',
      },
    );

    expect(result.comments[0]?.comment).toBe('First line\n  indented line\n*literal star');
  });

  it('does not strip a meaningful star in an undecorated block', () => {
    const source = ['/*', ...fields(ID, ['*important']), '*/'].join('\n');
    const result = parseReviewComments(source, { languageId: 'css' });

    expect(result.comments[0]?.comment).toBe('*important');
  });

  it('supports an empty comment body', () => {
    const result = parseReviewComments(lineBlock('#', ID, []), { languageId: 'python' });

    expect(result.comments[0]?.comment).toBe('');
  });

  it('reports malformed field order and continues to a later valid block', () => {
    const malformed = [
      '/*',
      ' * CODING-NOTE-START',
      ` * id: ${ID}`,
      ' * status: open',
      ' * category: Accessibility',
      ' * comment:',
      ' * CODING-NOTE-END',
      ' */',
    ].join('\n');
    const validId = '22222222-2222-4222-8222-222222222222';
    const result = parseReviewComments(`${malformed}\n${starBlock(validId)}`, {
      relativePath: 'file.ts',
    });

    expect(result.diagnostics.some((diagnostic) => diagnostic.kind === 'malformed')).toBe(true);
    expect(result.comments.map((comment) => comment.id)).toEqual([validId]);
  });

  it('reports nested blocks without returning a corrupt comment', () => {
    const source = [
      '/*',
      ' * CODING-NOTE-START',
      ` * id: ${ID}`,
      ' * CODING-NOTE-START',
      ' * CODING-NOTE-END',
      ' * CODING-NOTE-END',
      ' */',
    ].join('\n');
    const result = parseReviewComments(source, { languageId: 'typescript' });

    expect(result.comments).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ kind: 'nested', line: 4 })]);
  });

  it('reports an unclosed block', () => {
    const source = [
      '/*',
      ...fields()
        .slice(0, -1)
        .map((line) => ` * ${line}`),
      ' */',
    ].join('\n');
    const result = parseReviewComments(source, { languageId: 'typescript' });

    expect(result.comments).toEqual([]);
    expect(result.diagnostics.some((diagnostic) => diagnostic.kind === 'unclosed')).toBe(true);
  });

  it('reports duplicate IDs while retaining both comments', () => {
    const result = parseReviewComments(`${starBlock()}\n${starBlock()}`, {
      relativePath: 'file.ts',
    });

    expect(result.comments).toHaveLength(2);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: 'duplicate-id', id: ID, line: 11 }),
    ]);
  });

  it('finds duplicate IDs across workspace files', () => {
    const base: ReviewComment = {
      workspaceFolder: 'one',
      relativePath: 'src/one.ts',
      startLine: 2,
      endLine: 8,
      id: ID,
      category: 'Code Review',
      status: 'open',
      comment: '',
    };
    const diagnostics = findDuplicateReviewIds([
      base,
      { ...base, workspaceFolder: 'two', relativePath: 'src/two.ts', startLine: 10, endLine: 16 },
    ]);

    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: 'duplicate-id',
        workspaceFolder: 'two',
        relativePath: 'src/two.ts',
        line: 10,
      }),
    ]);
  });

  it('uses exact one-based marker line numbers', () => {
    const result = parseReviewComments(`line one\nline two\n${htmlBlock()}\nlast`, {
      languageId: 'markdown',
    });

    expect(result.comments[0]).toMatchObject({ startLine: 4, endLine: 10 });
  });

  it('ignores marker strings and template literals', () => {
    const source = [
      'const one = "// CODING-NOTE-START";',
      'const two = `/*',
      ' * CODING-NOTE-START',
      ` * id: ${ID}`,
      ' * category: Code Review',
      ' * status: open',
      ' * comment:',
      ' * not a review',
      ' * CODING-NOTE-END',
      ' */`;',
    ].join('\n');
    const result = parseReviewComments(source, { languageId: 'typescript' });

    expect(result).toEqual({ comments: [], diagnostics: [] });
  });

  it('detects a real review block in a template expression but ignores literal text', () => {
    const expressionId = '22222222-2222-4222-8222-222222222222';
    const source = [
      'const value = `literal text',
      starBlock(),
      '${',
      starBlock(expressionId),
      '42',
      '} trailing text`;',
    ].join('\n');
    const result = parseReviewComments(source, { languageId: 'typescript' });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments.map((comment) => comment.id)).toEqual([expressionId]);
  });

  it('ignores marker-shaped HTML comments inside script strings', () => {
    const falseBlock = htmlBlock();
    const validId = '22222222-2222-4222-8222-222222222222';
    const source = [
      '<script>',
      '  const example = `',
      falseBlock,
      '  `;',
      '</script>',
      htmlBlock(validId),
    ].join('\n');
    const result = parseReviewComments(source, { languageId: 'html' });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments.map((comment) => comment.id)).toEqual([validId]);
  });

  it('ignores marker-shaped HTML comments inside quoted markup attributes', () => {
    const falseBlock = htmlBlock();
    const validId = '22222222-2222-4222-8222-222222222222';
    const source = `<div data-example="${falseBlock}"></div>\n${htmlBlock(validId)}`;
    const result = parseReviewComments(source, { languageId: 'html' });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments.map((comment) => comment.id)).toEqual([validId]);
  });

  it('ignores marker-shaped comments inside Markdown fenced code examples', () => {
    const falseBlock = htmlBlock();
    const validId = '22222222-2222-4222-8222-222222222222';
    const source = ['```html', falseBlock, '```', htmlBlock(validId)].join('\n');
    const result = parseReviewComments(source, { languageId: 'markdown' });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments.map((comment) => comment.id)).toEqual([validId]);
  });

  it('ignores marker-shaped comments inside Markdown indented code blocks', () => {
    const falseBlock = htmlBlock()
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    const validId = '22222222-2222-4222-8222-222222222222';
    const result = parseReviewComments(`${falseBlock}\n${htmlBlock(validId)}`, {
      languageId: 'markdown',
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments.map((comment) => comment.id)).toEqual([validId]);
  });

  it('ignores marker-shaped comments inside multiline Markdown code spans', () => {
    const validId = '22222222-2222-4222-8222-222222222222';
    const source = ['`', htmlBlock(), '`', htmlBlock(validId)].join('\n');
    const result = parseReviewComments(source, { languageId: 'markdown' });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments.map((comment) => comment.id)).toEqual([validId]);
  });

  it('ignores slash-block review examples inside MDX fences', () => {
    const validId = '22222222-2222-4222-8222-222222222222';
    const source = ['```tsx', starBlock(), '```', starBlock(validId)].join('\n');
    const result = parseReviewComments(source, { languageId: 'mdx' });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments.map((comment) => comment.id)).toEqual([validId]);
  });

  it.each([
    ['ESM template literal', ['export const example = `', htmlBlock(), '`;'].join('\n')],
    ['template expression', ['{`', htmlBlock(), '`}'].join('\n')],
    ['quoted expression', ['{"', htmlBlock(), '"}'].join('\n')],
  ])('ignores marker-shaped markup comments inside an MDX %s', (_, literal) => {
    const validId = '22222222-2222-4222-8222-222222222222';
    const result = parseReviewComments(`${literal}\n${htmlBlock(validId)}`, {
      languageId: 'mdx',
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments.map((comment) => comment.id)).toEqual([validId]);
  });

  it('ignores hash markers inside Python triple-quoted strings', () => {
    const source = ['value = """', ...fields().map((line) => `# ${line}`), '"""'].join('\n');
    const result = parseReviewComments(source, { languageId: 'python' });

    expect(result).toEqual({ comments: [], diagnostics: [] });
  });

  it('continues scanning after an apostrophe in JSX text', () => {
    const source = `<p>don't miss this</p>\n${starBlock()}`;
    const result = parseReviewComments(source, { languageId: 'typescriptreact' });

    expect(result.comments).toHaveLength(1);
  });

  it('parses a JSX review block after an apostrophe on the same line', () => {
    const source = `<><p>don't miss this</p>{${starBlock()}}</>`;
    const result = parseReviewComments(source, { languageId: 'typescriptreact' });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments).toHaveLength(1);
  });

  it.each([
    ['generic function', 'function identity<T>(value: T): T { return value; }'],
    ['generic type reference', 'const values: Array<string> = [];'],
    ['less-than expression', 'const result = left <right> value;'],
  ])('does not mistake a %s for a JSX root', (_, code) => {
    const result = parseReviewComments(`${code}\n${starBlock()}`, {
      languageId: 'typescriptreact',
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments).toHaveLength(1);
  });

  it('ignores hash marker blocks in YAML block scalars', () => {
    const validId = '22222222-2222-4222-8222-222222222222';
    const source = [
      'description: |',
      ...fields().map((line) => `  # ${line}`),
      lineBlock('#', validId),
    ].join('\n');
    const result = parseReviewComments(source, { languageId: 'yaml' });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments.map((comment) => comment.id)).toEqual([validId]);
  });

  it.each(["'", '"'])('ignores hash marker blocks in multiline YAML %s scalars', (quote) => {
    const validId = '22222222-2222-4222-8222-222222222222';
    const source = [
      `description: ${quote}first line`,
      ...fields().map((line) => `  # ${line}`),
      `  last line${quote}`,
      lineBlock('#', validId),
    ].join('\n');
    const result = parseReviewComments(source, { languageId: 'yaml' });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments.map((comment) => comment.id)).toEqual([validId]);
  });

  it('ignores hash marker blocks in PowerShell here-strings', () => {
    const validId = '22222222-2222-4222-8222-222222222222';
    const source = ['$message = @"', lineBlock('#'), '"@', lineBlock('#', validId)].join('\n');
    const result = parseReviewComments(source, { languageId: 'powershell' });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments.map((comment) => comment.id)).toEqual([validId]);
  });

  it('ignores PowerShell block-comment shapes inside quoted and here-string text', () => {
    const validId = '22222222-2222-4222-8222-222222222222';
    const blockShape = ['<#', ...fields(), '#>'];
    const source = [
      '$ordinary = "',
      ...blockShape,
      '"',
      "$here = @'",
      ...blockShape,
      "'@",
      ['<#', ...fields(validId), '#>'].join('\n'),
    ].join('\n');
    const result = parseReviewComments(source, { languageId: 'powershell' });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments.map((comment) => comment.id)).toEqual([validId]);
  });

  it('ignores hash marker blocks in shell heredocs', () => {
    const validId = '22222222-2222-4222-8222-222222222222';
    const source = [
      "cat <<'REVIEW_EXAMPLE'",
      lineBlock('#'),
      'REVIEW_EXAMPLE',
      lineBlock('#', validId),
    ].join('\n');
    const result = parseReviewComments(source, { languageId: 'shellscript' });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments.map((comment) => comment.id)).toEqual([validId]);
  });

  it.each(["'", '"'])('ignores hash marker blocks in multiline shell %s strings', (quote) => {
    const validId = '22222222-2222-4222-8222-222222222222';
    const source = [
      `message=${quote}first line`,
      lineBlock('#'),
      `last line${quote}`,
      lineBlock('#', validId),
    ].join('\n');
    const result = parseReviewComments(source, { languageId: 'shellscript' });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments.map((comment) => comment.id)).toEqual([validId]);
  });

  it.each([
    ['shellscript', "path='C:\\'"],
    ['yaml', "path: 'C:\\'"],
  ])('treats backslashes literally in %s single-quoted strings', (languageId, declaration) => {
    const result = parseReviewComments(`${declaration}\n${lineBlock('#')}`, { languageId });

    expect(result.diagnostics).toEqual([]);
    expect(result.comments).toHaveLength(1);
  });

  it.each(['value=$((1 << 3))', '(( value = 1 << 3 ))'])(
    'does not mistake shell arithmetic for a heredoc: %s',
    (arithmetic) => {
      const result = parseReviewComments(`${arithmetic}\n${lineBlock('#')}`, {
        languageId: 'shellscript',
      });

      expect(result.diagnostics).toEqual([]);
      expect(result.comments).toHaveLength(1);
    },
  );

  it('requires marker names to occupy their own logical comment lines', () => {
    const source = starBlock().replace(
      'CODING-NOTE-START',
      `prefix ${ID} CODING-NOTE-START suffix`,
    );
    const result = parseReviewComments(source, { languageId: 'typescript' });

    expect(result.comments).toEqual([]);
    expect(result.diagnostics.some((diagnostic) => diagnostic.kind === 'malformed')).toBe(true);
  });

  it('does not parse marker names in ordinary Markdown prose', () => {
    const result = parseReviewComments(fields().join('\n'), { languageId: 'markdown' });

    expect(result).toEqual({ comments: [], diagnostics: [] });
  });

  it.each([
    ['slash block', ['/*', ...fields()].join('\n'), 'typescript'],
    ['HTML block', ['<!--', ...fields()].join('\n'), 'html'],
  ])(
    'rejects a complete review pair inside an unterminated %s wrapper',
    (_, source, languageId) => {
      const result = parseReviewComments(source, { languageId });

      expect(result.comments).toEqual([]);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          kind: 'malformed',
          message: expect.stringContaining('comment wrapper is not terminated'),
        }),
      ]);
    },
  );
});
