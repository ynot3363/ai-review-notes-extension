import { mkdir, realpath, rmdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type * as vscode from 'vscode';

/**
 * An exclusive directory serializes transactions across extension hosts.
 * workspace.fs has no exclusive-create primitive, so virtual providers cannot
 * safely participate. Remote workspace extension hosts use file: URIs too.
 * Locks are never stolen on a timer: a slow writer must not lose ownership.
 */
export async function withReviewNoteStoreLock<T>(
  uri: vscode.Uri,
  operation: () => Promise<T>,
  timeoutMs = 5_000,
): Promise<T> {
  if (uri.scheme !== 'file') {
    throw new Error(
      `Safe note writes are unavailable for the ${uri.scheme} filesystem. Use private note storage or open the folder in a workspace extension host.`,
    );
  }

  await mkdir(dirname(uri.fsPath), { recursive: true });
  const directory = await realpath(dirname(uri.fsPath));
  const lockPath = join(directory, `.${basename(uri.fsPath)}.lock`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Note storage is locked: ${lockPath}. Retry after the other writer finishes. If a writer crashed, close all writers before removing this lock directory.`,
        );
      }
      await delay(25);
    }
  }

  try {
    return await operation();
  } finally {
    await rmdir(lockPath);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
