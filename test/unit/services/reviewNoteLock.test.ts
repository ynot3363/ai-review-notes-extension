import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { withReviewNoteStoreLock } from '../../../src/services/reviewNoteLock';

let directory: string;
let uri: vscode.Uri;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'coding-notes-lock-'));
  uri = { scheme: 'file', fsPath: join(directory, 'notes.json') } as vscode.Uri;
});

afterEach(() => rm(directory, { recursive: true, force: true }));

describe('note store locks', () => {
  it('releases ownership when the transaction fails', async () => {
    await expect(
      withReviewNoteStoreLock(uri, async () => {
        throw new Error('write failed');
      }),
    ).rejects.toThrow('write failed');
    await expect(withReviewNoteStoreLock(uri, async () => 'next write', 0)).resolves.toBe(
      'next write',
    );
    expect(await readdir(directory)).toEqual([]);
  });

  it('does not steal a held lock on timeout', async () => {
    const contender = vi.fn(async () => undefined);
    await withReviewNoteStoreLock(uri, async () => {
      await expect(withReviewNoteStoreLock(uri, contender, 0)).rejects.toThrow(/storage is locked/);
      expect(await readdir(directory)).toEqual(['.notes.json.lock']);
    });
    expect(contender).not.toHaveBeenCalled();
  });

  it('allows independent stores to be written at the same time', async () => {
    const other = { scheme: 'file', fsPath: join(directory, 'other.json') } as vscode.Uri;
    await withReviewNoteStoreLock(uri, async () => {
      await expect(withReviewNoteStoreLock(other, async () => 'other write', 0)).resolves.toBe(
        'other write',
      );
    });
  });

  it('refuses an unsafe write on a virtual filesystem', async () => {
    const operation = vi.fn(async () => undefined);
    await expect(
      withReviewNoteStoreLock({ scheme: 'virtual' } as vscode.Uri, operation),
    ).rejects.toThrow(/Use private note storage/);
    expect(operation).not.toHaveBeenCalled();
  });

  it('excludes a writer in a separate Node process and releases for the next writer', async () => {
    const bundle = join(directory, 'lock.cjs');
    await build({
      entryPoints: [resolve('src/services/reviewNoteLock.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node16',
    });
    const worker = join(directory, 'worker.cjs');
    await writeFile(
      worker,
      `
      const { withReviewNoteStoreLock } = require('./lock.cjs');
      withReviewNoteStoreLock({ scheme: 'file', fsPath: process.argv[2] }, async () => {
        const released = new Promise(resolve => process.once('message', resolve));
        process.send('locked');
        await released;
      }).then(() => process.disconnect(), error => {
        console.error(error);
        process.exit(1);
      });
    `,
    );
    const child = fork(worker, [uri.fsPath], {
      execArgv: [],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const exited = once(child, 'exit');
    try {
      const first = await Promise.race([
        once(child, 'message'),
        exited.then(() => {
          throw new Error('Lock worker exited before acquiring the lock');
        }),
      ]);
      expect(first[0]).toBe('locked');
      const contender = vi.fn(async () => undefined);
      await expect(withReviewNoteStoreLock(uri, contender, 0)).rejects.toThrow(/storage is locked/);
      expect(contender).not.toHaveBeenCalled();
      child.send('release');
      expect((await exited)[0]).toBe(0);
      await expect(withReviewNoteStoreLock(uri, async () => 'acquired', 0)).resolves.toBe(
        'acquired',
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
    }
  });
});
