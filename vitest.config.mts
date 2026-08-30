import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    coverage: {
      include: ['src/core/**/*.ts', 'src/services/commentSyntax.ts', 'src/services/pathUtils.ts'],
    },
  },
});
