import { describe, expect, it } from 'vitest';

import { BUILT_IN_CATEGORIES } from '../../../src/core';
import { addCustomCategory, getSelectableCategories } from '../../../src/services/categoryOptions';

describe('selectable note categories', () => {
  it('merges a configured array with built-in, default, and current categories', () => {
    const categories = getSelectableCategories(
      [' Zulu ', 'Alpha', '', 42, 'Backend', 'Backend', null],
      ' Default ',
      ' Current ',
    );

    expect(categories.slice(0, 2)).toEqual(['Current', 'Default']);
    expect(categories).toEqual(
      expect.arrayContaining([...BUILT_IN_CATEGORIES, 'Alpha', 'Backend', 'Zulu']),
    );
  });

  it('falls back to the built-in categories when the configured value is not an array', () => {
    const categories = getSelectableCategories({ category: 'Custom' }, 'General');

    expect(categories).toHaveLength(BUILT_IN_CATEGORIES.length);
    expect(categories).toEqual([
      'General',
      'Accessibility',
      'Bug',
      'Documentation',
      'Improvement',
      'Other',
      'Performance',
      'Question',
      'Security',
      'Testing',
    ]);
  });

  it('keeps built-in categories available for an explicitly empty configured list', () => {
    const categories = getSelectableCategories([], ' General ', ' Architecture ');

    expect(categories[0]).toBe('Architecture');
    expect(categories).toEqual(expect.arrayContaining([...BUILT_IN_CATEGORIES]));
    expect(getSelectableCategories([], '   ')).toEqual(
      [...BUILT_IN_CATEGORIES].sort((left, right) => left.localeCompare(right)),
    );
  });

  it('deduplicates cleaned current and default categories while preserving priority', () => {
    const categories = getSelectableCategories(
      ['Testing', ' General ', 'Bug'],
      'General',
      ' General ',
    );

    expect(categories[0]).toBe('General');
    expect(categories.filter((category) => category === 'General')).toHaveLength(1);
  });

  it('appends a clean custom category to the persisted configured list', () => {
    expect(addCustomCategory(['Code Review', ' Code Review ', '', 42], ' Architecture ')).toEqual([
      'Code Review',
      'Architecture',
    ]);
    expect(addCustomCategory(undefined, 'Architecture')).toEqual([
      ...BUILT_IN_CATEGORIES,
      'Architecture',
    ]);
  });
});
