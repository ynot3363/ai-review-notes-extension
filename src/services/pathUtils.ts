import * as path from 'node:path';

export const DEFAULT_SCAN_INCLUDES = Object.freeze(['**/*']);

export const DEFAULT_SCAN_EXCLUDES = Object.freeze([
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/storybook-static/**',
  '**/.cache/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.parcel-cache/**',
  '**/.turbo/**',
  '**/.yarn/**',
  '**/.pnpm-store/**',
  '**/.vscode-test/**',
  '**/out/**',
]);

export interface PathFilterOptions {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly caseSensitive?: boolean;
}

export interface WorkspaceRootLike {
  readonly fsPath: string;
  readonly name?: string;
}

/** Normalize a workspace-relative path to slash separators for stable reports/globs. */
export function normalizeRelativePath(value: string): string {
  const slashes = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const normalized = path.posix.normalize(slashes);
  return normalized === '.' ? '' : normalized;
}

/**
 * Compile the small, conventional glob subset used by VS Code scan settings.
 * Supports `*`, `**`, `?`, character classes and comma-separated brace choices.
 */
export function globToRegExp(glob: string, caseSensitive = true): RegExp {
  const normalized = normalizeGlob(glob);
  const alternatives = expandBraces(normalized);
  const sources = alternatives.map(globAlternativeToRegExpSource);
  return new RegExp(`^(?:${sources.join('|')})$`, caseSensitive ? '' : 'i');
}

export function matchesGlob(relativePath: string, glob: string, caseSensitive = true): boolean {
  return globToRegExp(glob, caseSensitive).test(normalizeRelativePath(relativePath));
}

export function matchesAnyGlob(
  relativePath: string,
  globs: readonly string[],
  caseSensitive = true,
): boolean {
  return globs.some((glob) => matchesGlob(relativePath, glob, caseSensitive));
}

export function shouldIncludePath(relativePath: string, options: PathFilterOptions = {}): boolean {
  const include = options.include ?? DEFAULT_SCAN_INCLUDES;
  const exclude = options.exclude ?? DEFAULT_SCAN_EXCLUDES;
  const caseSensitive = options.caseSensitive ?? process.platform !== 'win32';
  const normalized = normalizeRelativePath(relativePath);

  const included = matchesAnyGlob(normalized, include, caseSensitive);
  return included && !matchesAnyGlob(normalized, exclude, caseSensitive);
}

export function createPathFilter(
  options: PathFilterOptions = {},
): (relativePath: string) => boolean {
  const include = options.include ?? DEFAULT_SCAN_INCLUDES;
  const exclude = options.exclude ?? DEFAULT_SCAN_EXCLUDES;
  const caseSensitive = options.caseSensitive ?? process.platform !== 'win32';
  const includeExpressions = include.map((glob) => globToRegExp(glob, caseSensitive));
  const excludeExpressions = exclude.map((glob) => globToRegExp(glob, caseSensitive));

  return (relativePath: string): boolean => {
    const normalized = normalizeRelativePath(relativePath);
    const included = includeExpressions.some((expression) => expression.test(normalized));
    return included && !excludeExpressions.some((expression) => expression.test(normalized));
  };
}

/** True only when `candidatePath` is the root itself or a descendant of it. */
export function isPathInside(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** Select the most-specific containing root, which is important for nested/multi-root workspaces. */
export function findContainingWorkspaceRoot<T extends WorkspaceRootLike>(
  candidatePath: string,
  roots: readonly T[],
): T | undefined {
  return roots
    .filter((root) => isPathInside(candidatePath, root.fsPath))
    .sort((left, right) => path.resolve(right.fsPath).length - path.resolve(left.fsPath).length)[0];
}

export function toWorkspaceRelativePath(
  candidatePath: string,
  rootPath: string,
): string | undefined {
  if (!isPathInside(candidatePath, rootPath)) {
    return undefined;
  }
  return normalizeRelativePath(path.relative(path.resolve(rootPath), path.resolve(candidatePath)));
}

/** A fast conservative binary sniff suitable for a bounded prefix or complete small file. */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  if (bytes.length === 0) {
    return false;
  }

  const sampleLength = Math.min(bytes.length, 8_192);
  let suspicious = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = bytes[index]!;
    if (byte === 0) {
      return true;
    }
    const allowedControl = byte === 8 || byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if (byte < 32 && !allowedControl) {
      suspicious += 1;
    }
  }
  return suspicious / sampleLength > 0.1;
}

const EXTENSION_LANGUAGE_IDS: Readonly<Record<string, string>> = Object.freeze({
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
  '.ps1': 'powershell',
  '.psd1': 'powershell',
  '.psm1': 'powershell',
  '.json': 'json',
  '.jsonc': 'jsonc',
});

export function inferLanguageIdFromPath(filePath: string): string | undefined {
  const basename = path.basename(filePath).toLowerCase();
  if (basename === 'dockerfile') {
    return 'dockerfile';
  }
  return EXTENSION_LANGUAGE_IDS[path.extname(basename)];
}

function normalizeGlob(glob: string): string {
  return glob.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function expandBraces(glob: string): string[] {
  const opening = glob.indexOf('{');
  if (opening < 0) {
    return [glob];
  }
  const closing = glob.indexOf('}', opening + 1);
  if (closing < 0) {
    return [glob];
  }
  const choices = glob.slice(opening + 1, closing).split(',');
  if (choices.length < 2) {
    return [glob];
  }
  const before = glob.slice(0, opening);
  const after = glob.slice(closing + 1);
  return choices.flatMap((choice) => expandBraces(`${before}${choice}${after}`));
}

function globAlternativeToRegExpSource(glob: string): string {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    const next = glob[index + 1];

    if (character === '*' && next === '*') {
      const following = glob[index + 2];
      if (following === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else if (character === '[') {
      const closing = glob.indexOf(']', index + 1);
      if (closing > index + 1) {
        const content = glob.slice(index + 1, closing).replace(/^!/, '^');
        source += `[${content}]`;
        index = closing;
      } else {
        source += '\\[';
      }
    } else {
      source += escapeRegExp(character);
    }
  }
  return source;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.-]/g, '\\$&');
}
