import { describe, expect, it } from 'vitest';

import {
  createPathFilter,
  findContainingWorkspaceRoot,
  globToRegExp,
  inferLanguageIdFromPath,
  isPathInside,
  isProbablyBinary,
  matchesGlob,
  normalizeRelativePath,
  shouldIncludePath,
  toWorkspaceRelativePath,
} from '../../../src/services/pathUtils';

describe('workspace path filtering', () => {
  it('matches root and nested files with double-star globs', () => {
    expect(matchesGlob('index.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('src/deep/index.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('src/deep/index.js', '**/*.ts')).toBe(false);
  });

  it('supports brace choices, question marks, and character classes', () => {
    const expression = globToRegExp('src/**/file?.[tj]s');
    expect(expression.test('src/file1.ts')).toBe(true);
    expect(expression.test('src/nested/fileA.js')).toBe(true);
    expect(expression.test('src/nested/file-long.ts')).toBe(false);
    expect(matchesGlob('component.tsx', '**/*.{ts,tsx}')).toBe(true);
  });

  it('applies exclusions after includes', () => {
    const filter = createPathFilter({
      include: ['**/*.{ts,tsx}'],
      exclude: ['**/node_modules/**', '**/*.generated.ts'],
      caseSensitive: true,
    });

    expect(filter('src/app.ts')).toBe(true);
    expect(filter('src/app.tsx')).toBe(true);
    expect(filter('src/app.js')).toBe(false);
    expect(filter('node_modules/pkg/index.ts')).toBe(false);
    expect(filter('src/models.generated.ts')).toBe(false);
  });

  it('treats an explicitly empty include list as scanning no files', () => {
    expect(createPathFilter({ include: [], exclude: [] })('src/app.ts')).toBe(false);
  });

  it('uses secure default exclusions for build and cache directories', () => {
    expect(shouldIncludePath('src/index.ts')).toBe(true);
    for (const relativePath of [
      '.git/config.ts',
      'node_modules/pkg/index.ts',
      'dist/index.js',
      'build/output.js',
      'coverage/report.js',
      'storybook-static/runtime.js',
      '.cache/generated.js',
      '.next/server/app.js',
      '.parcel-cache/data.js',
    ]) {
      expect(shouldIncludePath(relativePath), relativePath).toBe(false);
    }
  });

  it('normalizes Windows separators for glob matching and reports', () => {
    expect(normalizeRelativePath('.\\src\\components\\Button.tsx')).toBe(
      'src/components/Button.tsx',
    );
    expect(matchesGlob('src\\components\\Button.tsx', '**/*.tsx')).toBe(true);
  });

  it('can make path matching case-insensitive', () => {
    expect(matchesGlob('SRC/App.TS', 'src/**/*.ts', false)).toBe(true);
    expect(matchesGlob('SRC/App.TS', 'src/**/*.ts', true)).toBe(false);
  });
});

describe('multi-root path handling', () => {
  const roots = [
    { name: 'repository', fsPath: '/work/repository' },
    { name: 'application', fsPath: '/work/repository/packages/application' },
    { name: 'other', fsPath: '/work/other' },
  ] as const;

  it('selects the most specific containing workspace folder', () => {
    expect(
      findContainingWorkspaceRoot('/work/repository/packages/application/src/App.tsx', roots)?.name,
    ).toBe('application');
    expect(findContainingWorkspaceRoot('/work/repository/README.md', roots)?.name).toBe(
      'repository',
    );
    expect(findContainingWorkspaceRoot('/elsewhere/file.ts', roots)).toBeUndefined();
  });

  it('does not confuse sibling paths with descendants', () => {
    expect(isPathInside('/work/repository-copy/file.ts', '/work/repository')).toBe(false);
    expect(isPathInside('/work/repository/file.ts', '/work/repository')).toBe(true);
    expect(isPathInside('/work/repository', '/work/repository')).toBe(true);
  });

  it('creates stable workspace-relative slash paths and rejects escaping files', () => {
    expect(
      toWorkspaceRelativePath(
        '/work/repository/packages/application/src/App.tsx',
        '/work/repository/packages/application',
      ),
    ).toBe('src/App.tsx');
    expect(toWorkspaceRelativePath('/work/secret.ts', '/work/repository')).toBeUndefined();
  });
});

describe('file sniffing', () => {
  it('distinguishes ordinary UTF-8 source from likely binary data', () => {
    expect(isProbablyBinary(new TextEncoder().encode('const café = true;\n'))).toBe(false);
    expect(isProbablyBinary(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))).toBe(true);
    expect(isProbablyBinary(new Uint8Array())).toBe(false);
  });

  it.each([
    ['file.ts', 'typescript'],
    ['file.tsx', 'typescriptreact'],
    ['file.jsx', 'javascriptreact'],
    ['file.mdx', 'mdx'],
    ['file.yaml', 'yaml'],
    ['file.ps1', 'powershell'],
    ['file.jsonc', 'jsonc'],
  ])('infers %s as %s', (filePath, languageId) => {
    expect(inferLanguageIdFromPath(filePath)).toBe(languageId);
  });
});
