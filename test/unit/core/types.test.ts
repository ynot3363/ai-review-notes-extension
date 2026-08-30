import { describe, expect, it } from 'vitest';

import { BUILT_IN_CATEGORIES } from '../../../src/core';

describe('note categories', () => {
  it('provides broad defaults that apply across codebases', () => {
    expect(BUILT_IN_CATEGORIES).toEqual([
      'General',
      'Bug',
      'Improvement',
      'Question',
      'Documentation',
      'Testing',
      'Performance',
      'Security',
      'Accessibility',
      'Other',
    ]);
  });
});
