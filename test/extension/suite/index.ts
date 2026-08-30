import { runExtensionHostTests } from './extension.test';

export async function run(): Promise<void> {
  await runExtensionHostTests();
}
