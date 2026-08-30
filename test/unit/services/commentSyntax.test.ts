import { describe, expect, it } from 'vitest';

import { parseReviewComments } from '../../../src/core';
import {
  CommentSyntaxError,
  createCommentBlock,
  detectJsxInsertionContext,
  getCommentSyntax,
  planCommentInsertion,
  resolveCommentSyntax,
  UnsupportedCommentSyntaxError,
} from '../../../src/services/commentSyntax';

const BASE_OPTIONS = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  category: 'Code Review',
} as const;

describe('comment syntax', () => {
  it.each(['typescript', 'javascript', 'css', 'scss', 'less', 'jsonc'])(
    'renders the C-style block wrapper for %s',
    (languageId) => {
      const rendered = createCommentBlock({ ...BASE_OPTIONS, languageId });

      expect(rendered.syntax.kind).toBe('block');
      expect(rendered.text).toContain('/*\n * CODING-NOTE-START');
      expect(rendered.text).toContain('\n * comment:\n * \n * CODING-NOTE-END\n */');
    },
  );

  it.each(['typescriptreact', 'javascriptreact', 'tsx', 'jsx'])(
    'supports both code and JSX-child wrappers for %s',
    (languageId) => {
      const code = createCommentBlock({ ...BASE_OPTIONS, languageId });
      const child = createCommentBlock({ ...BASE_OPTIONS, languageId, jsxContext: true });

      expect(code.text).toMatch(/^\/\*/);
      expect(code.text).toMatch(/ \*\/$/);
      expect(child.text).toMatch(/^\{\/\*/);
      expect(child.text).toMatch(/ \*\/\}$/);
    },
  );

  it.each(['html', 'xml', 'svg', 'markdown'])('renders the markup wrapper for %s', (languageId) => {
    const rendered = createCommentBlock({ ...BASE_OPTIONS, languageId });

    expect(rendered.syntax.kind).toBe('html');
    expect(rendered.text).toBe(
      '<!--\nCODING-NOTE-START\nid: 123e4567-e89b-12d3-a456-426614174000\ncategory: Code Review\nstatus: open\ncomment:\n\nCODING-NOTE-END\n-->',
    );
  });

  it('renders an MDX-safe JavaScript expression comment', () => {
    const rendered = createCommentBlock({ ...BASE_OPTIONS, languageId: 'mdx' });

    expect(rendered.syntax.kind).toBe('jsx-expression');
    expect(rendered.text).toMatch(/^\{\/\*/);
    expect(rendered.text).toMatch(/ \*\/\}$/);
  });

  it.each(['yaml', 'yml', 'python', 'shellscript', 'shell', 'bash', 'zsh', 'fish', 'powershell'])(
    'renders the hash-line wrapper for %s',
    (languageId) => {
      const rendered = createCommentBlock({ ...BASE_OPTIONS, languageId });

      expect(rendered.syntax.kind).toBe('line');
      expect(rendered.text).toMatch(/^# CODING-NOTE-START/);
      expect(rendered.text).toContain('\n# comment:\n# \n# CODING-NOTE-END');
    },
  );

  it('uses the requested EOL, indentation, status, and multiline body', () => {
    const rendered = createCommentBlock({
      ...BASE_OPTIONS,
      languageId: 'typescript',
      eol: '\r\n',
      indent: '  ',
      status: 'question',
      comment: 'first line\nsecond line',
    });

    expect(rendered.text).not.toMatch(/(?<!\r)\n/);
    expect(rendered.text).toContain('  /*\r\n   * CODING-NOTE-START');
    expect(rendered.text).toContain('   * status: question');
    expect(rendered.text).toContain('   * first line\r\n   * second line');
    expect(rendered.text.slice(rendered.bodyOffset)).toMatch(/^first line/);
  });

  it('places the body cursor on an empty comment line for every wrapper', () => {
    for (const options of [
      { languageId: 'typescript' },
      { languageId: 'html' },
      { languageId: 'python' },
      { languageId: 'typescriptreact', jsxContext: true },
    ] as const) {
      const rendered = createCommentBlock({ ...BASE_OPTIONS, ...options });
      expect(rendered.text[rendered.bodyOffset]).toBe('\n');
      expect(rendered.text.slice(0, rendered.bodyOffset)).toMatch(/comment:\n(?: \* |# )?$/);
    }
  });

  it('rejects strict JSON with a machine-readable reason', () => {
    expect(resolveCommentSyntax('json')).toMatchObject({
      supported: false,
      reason: 'strict-json',
    });
    expect(() => createCommentBlock({ ...BASE_OPTIONS, languageId: 'json' })).toThrowError(
      expect.objectContaining({
        name: 'CommentSyntaxError',
        reason: 'strict-json',
        message: expect.stringContaining('JSON does not permit comments'),
      }),
    );
  });

  it('rejects unknown languages and exposes both error class names', () => {
    try {
      createCommentBlock({ ...BASE_OPTIONS, languageId: 'plaintext' });
      throw new Error('Expected the language to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedCommentSyntaxError);
      expect(error).toBeInstanceOf(CommentSyntaxError);
      expect(error).toMatchObject({ reason: 'unsupported' });
    }
    expect(getCommentSyntax('plaintext')).toBeUndefined();
  });

  it('prevents metadata from injecting extra logical lines', () => {
    expect(() =>
      createCommentBlock({
        ...BASE_OPTIONS,
        languageId: 'python',
        category: 'UX\nstatus: resolved',
      }),
    ).toThrow(TypeError);
  });

  it.each([
    { languageId: 'typescript', field: 'category', value: 'UX */ status: resolved' },
    { languageId: 'html', field: 'category', value: 'UX --> status: resolved' },
    { languageId: 'mdx', field: 'status', value: 'open */}' },
  ] as const)(
    'rejects $field values that terminate the $languageId wrapper',
    ({ languageId, field, value }) => {
      expect(() =>
        createCommentBlock({
          ...BASE_OPTIONS,
          languageId,
          ...(field === 'category' ? { category: value } : { status: value }),
        }),
      ).toThrowError(
        expect.objectContaining({ message: expect.stringContaining('reserved sequence') }),
      );
    },
  );

  it('rejects wrapper-breaking text supplied as an initial comment body', () => {
    expect(() =>
      createCommentBlock({
        ...BASE_OPTIONS,
        languageId: 'typescript',
        comment: 'Close the wrapper */ and inject code',
      }),
    ).toThrow(TypeError);
  });

  it.each([
    { languageId: 'typescript' },
    { languageId: 'typescriptreact', jsxContext: true },
    { languageId: 'html' },
    { languageId: 'mdx' },
    { languageId: 'python' },
  ] as const)('round-trips the $languageId wrapper through the core parser', (options) => {
    const rendered = createCommentBlock({
      ...BASE_OPTIONS,
      ...options,
      comment: 'Preserve the first line.\nAnd the second line.',
    });
    const parsed = parseReviewComments(rendered.text, {
      languageId: options.languageId,
      workspaceFolder: 'workspace',
      relativePath: `example.${options.languageId}`,
    });

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0]).toMatchObject({
      id: BASE_OPTIONS.id,
      category: BASE_OPTIONS.category,
      status: 'open',
      comment: 'Preserve the first line.\nAnd the second line.',
    });
  });
});

describe('JSX/TSX insertion planning', () => {
  it('uses a JSX expression wrapper between child elements and preserves the selected node', () => {
    const source = 'export const View = () => (\n  <div>\n    <Button />\n  </div>\n);\n';
    const selectedNode = source.indexOf('<Button');
    const selectionEnd = selectedNode + '<Button />'.length;
    const plan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId: 'typescriptreact',
      documentText: source,
      cursorOffset: selectedNode,
      selectionStart: selectedNode,
      selectionEnd,
    });
    const updated = insert(source, plan.insertionOffset, plan.text);

    expect(plan.jsxContext).toBe('child');
    expect(plan.text).toMatch(/^ {4}\{\/\*/);
    expect(updated).toContain(`${plan.text}    <Button />`);
    expect(updated).toContain('<Button />');
    expect(updated[plan.cursorOffset]).toBe('\n');
  });

  it('uses a normal block comment in TSX code', () => {
    const source = 'const answer = 42;\n';
    const plan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId: 'typescriptreact',
      documentText: source,
      cursorOffset: 0,
    });

    expect(plan.jsxContext).toBe('code');
    expect(plan.text).toMatch(/^\/\*/);
    expect(plan.text).not.toMatch(/^\{\/\*/);
  });

  it('uses a normal block before a selected root JSX expression', () => {
    const source = 'const view = (\n  <main />\n);\n';
    const start = source.indexOf('<main');
    const plan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId: 'javascriptreact',
      documentText: source,
      cursorOffset: start,
      selectionStart: start,
      selectionEnd: start + 8,
    });

    expect(plan.jsxContext).toBe('code');
    expect(plan.text).toMatch(/^ {2}\/\*/);
  });

  it('moves an attribute-list cursor before the containing nested tag', () => {
    const source = [
      'const view = (',
      '  <main>',
      '    <Button',
      '      disabled',
      '    />',
      '  </main>',
      ');',
      '',
    ].join('\n');
    const cursorOffset = source.indexOf('disabled');
    const tagLineOffset = source.indexOf('    <Button');
    const plan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId: 'typescriptreact',
      documentText: source,
      cursorOffset,
    });

    expect(plan.insertionOffset).toBe(tagLineOffset);
    expect(plan.jsxContext).toBe('child');
    expect(plan.text).toMatch(/^ {4}\{\/\*/);
  });

  it('uses a raw block inside a JSX JavaScript expression', () => {
    const source = [
      'const view = (',
      '  <main>',
      '    {enabled && (',
      '      <Button />',
      '    )}',
      '  </main>',
      ');',
      '',
    ].join('\n');
    const cursorOffset = source.indexOf('<Button');
    const plan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId: 'typescriptreact',
      documentText: source,
      cursorOffset,
      selectionStart: cursorOffset,
      selectionEnd: cursorOffset + '<Button />'.length,
    });

    expect(plan.jsxContext).toBe('code');
    expect(plan.text).toMatch(/^ {6}\/\*/);
  });

  it('does not mistake comparisons, generics, strings, or existing comments for JSX', () => {
    const source = [
      "const markup = '<div>';",
      '/* <Fake> */',
      'const smaller = left < right;',
      'function identity<T>(value: T) {',
      '  return value;',
      '}',
      '',
    ].join('\n');

    expect(detectJsxInsertionContext(source, source.length)).toBe('code');
  });

  it('treats apostrophes in JSX prose as text and returns to top-level code', () => {
    const source = "const view = <p>don't stop</p>;\nconst after = 1;\n";
    const proseOffset = source.indexOf("don't");
    const topLevelOffset = source.indexOf('const after');

    expect(detectJsxInsertionContext(source, proseOffset)).toBe('child');
    expect(detectJsxInsertionContext(source, topLevelOffset)).toBe('code');

    const plan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId: 'typescriptreact',
      documentText: source,
      cursorOffset: topLevelOffset,
    });
    expect(plan.jsxContext).toBe('code');
    expect(plan.text).toMatch(/^\/\*/);
  });

  it('ignores greater-than characters inside quoted JSX attributes', () => {
    const source = `const view = <p title="don't > stop">Text</p>;\nconst after = 1;\n`;

    expect(detectJsxInsertionContext(source, source.indexOf('Text'))).toBe('child');
    expect(detectJsxInsertionContext(source, source.indexOf('const after'))).toBe('code');
  });

  it('retains exact mid-line cursor insertion and detects CRLF', () => {
    const source = 'const result = left + right;\r\n';
    const cursorOffset = source.indexOf('+');
    const plan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId: 'typescript',
      documentText: source,
      cursorOffset,
    });

    expect(plan.insertionOffset).toBe(cursorOffset);
    expect(plan.text).toContain('\r\n');
    expect(plan.text).not.toMatch(/(?<!\r)\n/);
  });
});

describe('literal and existing-comment insertion safety', () => {
  it.each([
    { languageId: 'typescript', source: 'const text = "hello";\n' },
    { languageId: 'javascript', source: 'const text = "hello";\n' },
    { languageId: 'css', source: '.label { content: "hello"; }\n' },
    { languageId: 'scss', source: '$label: "hello";\n' },
    { languageId: 'less', source: '@label: "hello";\n' },
    { languageId: 'jsonc', source: '{ "label": "hello" }\n' },
  ])('relocates an insertion inside a $languageId quoted value', ({ languageId, source }) => {
    const cursorOffset = source.indexOf('hello') + 1;
    const plan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId,
      documentText: source,
      cursorOffset,
    });
    const updated = insert(source, plan.insertionOffset, plan.text);

    expect(plan.insertionOffset).toBe(0);
    expect(removeInsertion(updated, plan.insertionOffset, plan.text)).toBe(source);
    expect(updated[plan.cursorOffset]).toBe('\n');
    expect(parseReviewComments(updated, { languageId }).comments).toHaveLength(1);
  });

  it('relocates from template raw text but remains at a safe template expression boundary', () => {
    const source = 'const greeting = `hello ${name}`;\n';
    const rawCursor = source.indexOf('hello') + 2;
    const expressionCursor = source.indexOf('name');
    const rawPlan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId: 'typescript',
      documentText: source,
      cursorOffset: rawCursor,
    });
    const expressionPlan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId: 'typescript',
      documentText: source,
      cursorOffset: expressionCursor,
    });
    const expressionUpdated = insert(source, expressionPlan.insertionOffset, expressionPlan.text);

    expect(rawPlan.insertionOffset).toBe(0);
    expect(expressionPlan.insertionOffset).toBe(expressionCursor);
    expect(
      removeInsertion(expressionUpdated, expressionPlan.insertionOffset, expressionPlan.text),
    ).toBe(source);
    expect(
      parseReviewComments(expressionUpdated, { languageId: 'typescript' }).comments,
    ).toHaveLength(1);
  });

  it('relocates a selection from a later line of template raw text', () => {
    const source = 'const message = `first\nsecond\nthird`;\n';
    const selectionStart = source.indexOf('second');
    const plan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId: 'typescript',
      documentText: source,
      cursorOffset: selectionStart,
      selectionStart,
      selectionEnd: selectionStart + 'second'.length,
    });

    expect(plan.insertionOffset).toBe(0);
    expect(removeInsertion(insert(source, 0, plan.text), 0, plan.text)).toBe(source);
  });

  it('relocates a string insertion inside a TSX expression to a JSX-child boundary', () => {
    const source = [
      'const view = (',
      '  <div>',
      '    {enabled ? "hello" : null}',
      '  </div>',
      ');',
      '',
    ].join('\n');
    const expressionLine = source.indexOf('    {enabled');
    const plan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId: 'typescriptreact',
      documentText: source,
      cursorOffset: source.indexOf('hello') + 1,
    });
    const updated = insert(source, plan.insertionOffset, plan.text);

    expect(plan.insertionOffset).toBe(expressionLine);
    expect(plan.jsxContext).toBe('child');
    expect(plan.text).toMatch(/^ {4}\{\/\*/);
    expect(removeInsertion(updated, plan.insertionOffset, plan.text)).toBe(source);
    expect(parseReviewComments(updated, { languageId: 'typescriptreact' }).comments).toHaveLength(
      1,
    );
  });

  it.each([
    { source: 'const value = 1; // existing comment\n', cursorText: 'existing' },
    { source: 'const value = 1; /* existing comment */\n', cursorText: 'existing' },
    {
      source: 'const before = 1;\n/* existing\n * block comment\n */\nconst after = 2;\n',
      cursorText: 'block comment',
    },
  ])('relocates before an existing JavaScript comment', ({ source, cursorText }) => {
    const plan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId: 'typescript',
      documentText: source,
      cursorOffset: source.indexOf(cursorText),
    });
    const updated = insert(source, plan.insertionOffset, plan.text);

    expect(plan.insertionOffset).toBe(lineStartOffset(source, source.indexOf('existing')));
    expect(removeInsertion(updated, plan.insertionOffset, plan.text)).toBe(source);
    expect(parseReviewComments(updated, { languageId: 'typescript' }).comments).toHaveLength(1);
  });
});

describe('markup and Markdown insertion safety', () => {
  it.each([
    { languageId: 'html', source: '<div title="hello">Text</div>\n' },
    { languageId: 'xml', source: '<node value="hello" />\n' },
    { languageId: 'svg', source: '<text aria-label="hello">Text</text>\n' },
    { languageId: 'mdx', source: '<Card title="hello" />\n' },
  ])('relocates before a quoted $languageId tag attribute', ({ languageId, source }) => {
    const plan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId,
      documentText: source,
      cursorOffset: source.indexOf('hello') + 1,
    });
    const updated = insert(source, plan.insertionOffset, plan.text);

    expect(plan.insertionOffset).toBe(0);
    expect(removeInsertion(updated, plan.insertionOffset, plan.text)).toBe(source);
    expect(parseReviewComments(updated, { languageId }).comments).toHaveLength(1);
  });

  it.each(['script', 'style', 'textarea', 'title'])(
    'relocates before an HTML <%s> raw-text element',
    (tagName) => {
      const source = `<${tagName}>\n  const text = "hello";\n</${tagName}>\n`;
      const plan = planCommentInsertion({
        ...BASE_OPTIONS,
        languageId: 'html',
        documentText: source,
        cursorOffset: source.indexOf('hello') + 1,
      });
      const updated = insert(source, plan.insertionOffset, plan.text);

      expect(plan.insertionOffset).toBe(0);
      expect(removeInsertion(updated, plan.insertionOffset, plan.text)).toBe(source);
      expect(parseReviewComments(updated, { languageId: 'html' }).comments).toHaveLength(1);
    },
  );

  it('relocates before XML CDATA and an existing HTML comment', () => {
    for (const example of [
      { languageId: 'xml', source: '<![CDATA[\nhello\n]]>\n', cursor: 'hello' },
      {
        languageId: 'html',
        source: '<!--\nexisting comment\n-->\n',
        cursor: 'existing',
      },
    ]) {
      const plan = planCommentInsertion({
        ...BASE_OPTIONS,
        languageId: example.languageId,
        documentText: example.source,
        cursorOffset: example.source.indexOf(example.cursor),
      });
      const updated = insert(example.source, plan.insertionOffset, plan.text);

      expect(plan.insertionOffset).toBe(0);
      expect(removeInsertion(updated, plan.insertionOffset, plan.text)).toBe(example.source);
      expect(
        parseReviewComments(updated, { languageId: example.languageId }).comments,
      ).toHaveLength(1);
    }
  });

  it.each(['markdown', 'mdx'])(
    'relocates a $languageId insertion before its containing fenced code block',
    (languageId) => {
      const source = '# Example\n\n```ts\nconst text = "hello";\n```\n';
      const fenceStart = source.indexOf('```ts');
      const plan = planCommentInsertion({
        ...BASE_OPTIONS,
        languageId,
        documentText: source,
        cursorOffset: source.indexOf('hello') + 1,
      });
      const updated = insert(source, plan.insertionOffset, plan.text);

      expect(plan.insertionOffset).toBe(fenceStart);
      expect(
        languageId === 'mdx' ? plan.text.startsWith('{/*') : plan.text.startsWith('<!--'),
      ).toBe(true);
      expect(removeInsertion(updated, plan.insertionOffset, plan.text)).toBe(source);
      expect(parseReviewComments(updated, { languageId }).comments).toHaveLength(1);
    },
  );

  it.each(['markdown', 'mdx'])(
    'relocates a $languageId insertion before a line containing inline code',
    (languageId) => {
      const source = 'Use `const text = "hello"` in this example.\n';
      const plan = planCommentInsertion({
        ...BASE_OPTIONS,
        languageId,
        documentText: source,
        cursorOffset: source.indexOf('hello') + 1,
      });

      expect(plan.insertionOffset).toBe(0);
      expect(removeInsertion(insert(source, 0, plan.text), 0, plan.text)).toBe(source);
    },
  );

  it.each([
    { languageId: 'html', source: '<p>Hello world</p>\n', cursor: 'world' },
    { languageId: 'markdown', source: 'Hello ordinary text.\n', cursor: 'ordinary' },
    { languageId: 'mdx', source: 'Hello ordinary text.\n', cursor: 'ordinary' },
  ])(
    'keeps a safe mid-text $languageId insertion at the cursor',
    ({ languageId, source, cursor }) => {
      const cursorOffset = source.indexOf(cursor);
      const plan = planCommentInsertion({
        ...BASE_OPTIONS,
        languageId,
        documentText: source,
        cursorOffset,
      });
      const updated = insert(source, plan.insertionOffset, plan.text);

      expect(plan.insertionOffset).toBe(cursorOffset);
      expect(removeInsertion(updated, plan.insertionOffset, plan.text)).toBe(source);
      expect(parseReviewComments(updated, { languageId }).comments).toHaveLength(1);
    },
  );
});

describe('line-comment insertion planning', () => {
  it.each(['python', 'yaml', 'shellscript', 'powershell'])(
    'moves a mid-line %s comment above the source line without swallowing its suffix',
    (languageId) => {
      const source = 'value = 42\n';
      const cursorOffset = source.indexOf('42');
      const plan = planCommentInsertion({
        ...BASE_OPTIONS,
        languageId,
        documentText: source,
        cursorOffset,
      });
      const updated = insert(source, plan.insertionOffset, plan.text);

      expect(plan.insertionOffset).toBe(0);
      expect(plan.text).toMatch(/^# CODING-NOTE-START/);
      expect(plan.text.endsWith('\n')).toBe(true);
      expect(updated.endsWith(source)).toBe(true);
      expect(updated[plan.cursorOffset]).toBe('\n');
      expect(parseReviewComments(updated, { languageId }).comments).toHaveLength(1);
    },
  );

  it('preserves indentation when moving a Python comment above a nested statement', () => {
    const source = 'if enabled:\n    value = 42\n';
    const originalLineStart = source.indexOf('    value');
    const plan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId: 'python',
      documentText: source,
      cursorOffset: source.indexOf('42'),
    });
    const updated = insert(source, plan.insertionOffset, plan.text);

    expect(plan.insertionOffset).toBe(originalLineStart);
    expect(plan.text).toMatch(/^ {4}# CODING-NOTE-START/);
    expect(updated.endsWith('    value = 42\n')).toBe(true);
  });

  it.each([
    {
      languageId: 'python',
      source: 'value = """first\nsecond\nthird"""\n',
      cursor: 'second',
    },
    {
      languageId: 'yaml',
      source: 'message: |\n  first\n  second\nnext: value\n',
      cursor: 'second',
    },
    {
      languageId: 'shellscript',
      source: "cat <<'EOF'\nfirst\nsecond\nEOF\necho done\n",
      cursor: 'second',
    },
    {
      languageId: 'shellscript',
      source: 'value="first\nsecond"\necho done\n',
      cursor: 'second',
    },
    {
      languageId: 'powershell',
      source: '$value = @"\nfirst\nsecond\n"@\nWrite-Host done\n',
      cursor: 'second',
    },
    {
      languageId: 'powershell',
      source: '<#\nexisting block comment\n#>\nWrite-Host done\n',
      cursor: 'block comment',
    },
  ])(
    'relocates a $languageId insertion before its containing multiline literal/comment',
    ({ languageId, source, cursor }) => {
      const plan = planCommentInsertion({
        ...BASE_OPTIONS,
        languageId,
        documentText: source,
        cursorOffset: source.indexOf(cursor),
      });
      const updated = insert(source, plan.insertionOffset, plan.text);

      expect(plan.insertionOffset).toBe(0);
      expect(removeInsertion(updated, plan.insertionOffset, plan.text)).toBe(source);
      expect(parseReviewComments(updated, { languageId }).comments).toHaveLength(1);
    },
  );

  it('keeps a shebang and Python encoding cookie ahead of an inserted review block', () => {
    const source = '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nprint("hello")\n';
    const headerEnd = source.indexOf('print');
    const plan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId: 'python',
      documentText: source,
      cursorOffset: 0,
    });
    const updated = insert(source, plan.insertionOffset, plan.text);

    expect(plan.insertionOffset).toBe(headerEnd);
    expect(
      updated.startsWith('#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n# CODING-NOTE-START'),
    ).toBe(true);
    expect(removeInsertion(updated, plan.insertionOffset, plan.text)).toBe(source);
    expect(parseReviewComments(updated, { languageId: 'python' }).comments).toHaveLength(1);
  });

  it('inserts after a shell shebang even when it has no final newline', () => {
    const source = '#!/usr/bin/env bash';
    const plan = planCommentInsertion({
      ...BASE_OPTIONS,
      languageId: 'shellscript',
      documentText: source,
      cursorOffset: 0,
    });
    const updated = insert(source, plan.insertionOffset, plan.text);

    expect(plan.insertionOffset).toBe(source.length);
    expect(plan.text.startsWith('\n# CODING-NOTE-START')).toBe(true);
    expect(updated[plan.cursorOffset]).toBe('\n');
    expect(removeInsertion(updated, plan.insertionOffset, plan.text)).toBe(source);
    expect(parseReviewComments(updated, { languageId: 'shellscript' }).comments).toHaveLength(1);
  });
});

function insert(source: string, offset: number, text: string): string {
  return source.slice(0, offset) + text + source.slice(offset);
}

function removeInsertion(source: string, offset: number, inserted: string): string {
  return source.slice(0, offset) + source.slice(offset + inserted.length);
}

function lineStartOffset(source: string, offset: number): number {
  const newline = source.lastIndexOf('\n', Math.max(0, offset - 1));
  return newline < 0 ? 0 : newline + 1;
}
