import { describe, expect, it } from 'vitest';

import {
  MAX_CONTEXT_LINES,
  generateMarkdownReport,
  generateReviewPrompt,
  type ReviewComment,
} from '../../../src/core';

const REVIEW: ReviewComment = {
  workspaceFolder: 'sample-workspace',
  relativePath: 'src/example.ts',
  startLine: 4,
  endLine: 5,
  id: '11111111-1111-4111-8111-111111111111',
  category: 'Accessibility',
  status: 'open',
  comment: 'First line\nSecond line',
};

describe('generateMarkdownReport', () => {
  it('includes metadata, counts, file groups, line ranges, and full comments', () => {
    const report = generateMarkdownReport(
      [
        REVIEW,
        {
          ...REVIEW,
          id: 'second',
          status: 'resolved',
          category: 'Unit Tests',
          startLine: 20,
          endLine: 20,
        },
      ],
      {
        workspaceName: 'Demo',
        generatedAt: new Date('2025-01-02T03:04:05.000Z'),
        storePaths: ['CODING_NOTES_FOR_AI.json'],
      },
    );

    expect(report).toContain('# Coding Notes for AI Report');
    expect(report).toContain('2025-01-02T03:04:05.000Z');
    expect(report).toContain('**Workspace:** Demo');
    expect(report).toContain('**Coding note store:** `CODING_NOTES_FOR_AI.json`');
    expect(report).toContain('**Total notes:** 2');
    expect(report).toContain('## Instructions for the AI coding agent');
    expect(report).toContain('use the coding note store path listed above');
    expect(report).toContain('| open | 1 |');
    expect(report).toContain('| resolved | 1 |');
    expect(report).toContain('| Accessibility | 1 |');
    expect(report).toContain('| Unit Tests | 1 |');
    expect(report).toContain('### `src/example.ts`');
    expect(report).toContain('#### Lines 4–5');
    expect(report).toContain('#### Line 20');
    expect(report).toContain(REVIEW.id);
    expect(report).toContain('First line\nSecond line');
  });

  it('renders an explicit empty report', () => {
    const report = generateMarkdownReport([], {
      workspaceName: 'Empty',
      generatedAt: '2025-01-02T03:04:05Z',
    });

    expect(report).toContain('**Total notes:** 0');
    expect(report).toContain('_No notes found._');
  });

  it('keeps same-named files in different workspace folders separate', () => {
    const report = generateMarkdownReport(
      [REVIEW, { ...REVIEW, workspaceFolder: 'other-workspace', id: 'second' }],
      { generatedAt: '2025-01-02T03:04:05Z' },
    );

    expect(report).toContain('`other-workspace — src/example.ts`');
    expect(report).toContain('`sample-workspace — src/example.ts`');
  });

  it('lists each referenced JSON store once in a multi-root report', () => {
    const report = generateMarkdownReport([REVIEW], {
      generatedAt: '2025-01-02T03:04:05Z',
      storePaths: [
        'frontend/CODING_NOTES_FOR_AI.json',
        'backend/CODING_NOTES_FOR_AI.json',
        'frontend/CODING_NOTES_FOR_AI.json',
      ],
    });

    expect(report).toContain('**Coding note stores:**');
    expect(report.match(/frontend\/CODING_NOTES_FOR_AI\.json/gu)).toHaveLength(1);
    expect(report).toContain('`backend/CODING_NOTES_FOR_AI.json`');
  });
});

describe('generateReviewPrompt', () => {
  const source = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\r\n');

  it('includes all finding metadata and the requested task', () => {
    const prompt = generateReviewPrompt(REVIEW, source, { workspaceName: 'Demo', contextLines: 1 });

    expect(prompt).toContain('Workspace: Demo');
    expect(prompt).toContain('File: src/example.ts');
    expect(prompt).toContain('Line range: 4-5');
    expect(prompt).toContain(`Note ID: ${REVIEW.id}`);
    expect(prompt).toContain('Category: Accessibility');
    expect(prompt).toContain('Status: open');
    expect(prompt).toContain('First line\nSecond line');
    expect(prompt).toContain('Determine whether the finding is valid');
    expect(prompt).toContain('Do not modify unrelated code');
  });

  it('identifies the canonical external note store when supplied', () => {
    const prompt = generateReviewPrompt(REVIEW, source, {
      contextLines: 0,
      storePath: 'CODING_NOTES_FOR_AI.json',
    });

    expect(prompt).toContain('Coding note store: CODING_NOTES_FOR_AI.json');
  });

  it('limits context on both sides and handles CRLF', () => {
    const prompt = generateReviewPrompt(REVIEW, source, { contextLines: 1 });

    expect(prompt).toContain(
      'Surrounding source code (lines 3-6; 1 context line requested on each side)',
    );
    expect(prompt).toContain('3 | three');
    expect(prompt).toContain('6 | six');
    expect(prompt).not.toContain('2 | two');
    expect(prompt).not.toContain('7 | seven');
    expect(prompt).not.toContain('\r');
  });

  it('accepts zero context lines', () => {
    const prompt = generateReviewPrompt(REVIEW, source, { contextLines: 0 });

    expect(prompt).toContain(
      'Surrounding source code (lines 4-5; 0 context lines requested on each side)',
    );
    expect(prompt).not.toContain('3 | three');
    expect(prompt).not.toContain('6 | six');
  });

  it('clamps excessive context to a finite hard maximum', () => {
    const longSource = Array.from({ length: 500 }, (_, index) => `source line ${index + 1}`).join(
      '\n',
    );
    const prompt = generateReviewPrompt({ ...REVIEW, startLine: 250, endLine: 250 }, longSource, {
      contextLines: MAX_CONTEXT_LINES + 1_000,
    });

    expect(prompt).toContain(
      `Surrounding source code (lines 50-450; ${MAX_CONTEXT_LINES} context lines requested on each side)`,
    );
    expect(prompt).toContain(' 50 | source line 50');
    expect(prompt).toContain('450 | source line 450');
    expect(prompt).not.toContain(' 49 | source line 49');
    expect(prompt).not.toContain('451 | source line 451');
  });

  it('uses a longer Markdown fence when source contains backtick fences', () => {
    const prompt = generateReviewPrompt(REVIEW, 'before\n```\nafter', { contextLines: 1 });

    expect(prompt).toContain('````text');
  });
});
