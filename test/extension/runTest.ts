import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runTests } from '@vscode/test-electron';

const FIXTURE_SOURCE = `export const value = 1;
export const reviewed = value + 1;
`;

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'airn-'));
  const workspacePath = path.join(testRoot, 'workspace');
  const userDataPath = path.join(testRoot, 'user-data');
  const extensionsPath = path.join(testRoot, 'extensions');

  try {
    await fs.mkdir(workspacePath);
    await fs.writeFile(path.join(workspacePath, 'coding-note-fixture.ts'), FIXTURE_SOURCE, 'utf8');

    // A parent VS Code extension host sets this for its own child processes.
    // The downloaded application must run as Electron, not as Node.js.
    delete process.env.ELECTRON_RUN_AS_NODE;

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      version: '1.74.3',
      launchArgs: [
        workspacePath,
        '--disable-extensions',
        '--disable-gpu',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${userDataPath}`,
        `--extensions-dir=${extensionsPath}`,
      ],
    });
  } finally {
    await fs.rm(testRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}

void main().catch((error: unknown) => {
  console.error('Failed to run Coding Notes for AI Extension Host tests.');
  console.error(error);
  process.exitCode = 1;
});
