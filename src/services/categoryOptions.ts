import { BUILT_IN_CATEGORIES } from '../core';

/**
 * Build the categories shown by a note picker.
 *
 * Built-in categories always remain available. Configured, default, and
 * current categories are merged in so a narrow or stale setting cannot reduce
 * the picker to a single existing note category.
 */
export function getSelectableCategories(
  configuredValue: unknown,
  defaultCategory: string,
  currentCategory?: string,
): string[] {
  const configuredCategories = Array.isArray(configuredValue) ? configuredValue : [];
  const cleanedDefault = cleanCategory(defaultCategory);
  const cleanedCurrent = cleanCategory(currentCategory);
  const categories = uniqueCategories([
    ...BUILT_IN_CATEGORIES,
    ...configuredCategories,
    cleanedDefault,
    cleanedCurrent,
  ]);

  return categories.sort((left, right) => {
    const priority = (category: string): number => {
      if (category === cleanedCurrent) {
        return 0;
      }
      return category === cleanedDefault ? 1 : 2;
    };

    return priority(left) - priority(right) || left.localeCompare(right);
  });
}

/** Append a custom category to the configured value that will be persisted. */
export function addCustomCategory(configuredValue: unknown, customCategory: string): string[] {
  const configuredCategories = Array.isArray(configuredValue)
    ? configuredValue
    : BUILT_IN_CATEGORIES;
  return uniqueCategories([...configuredCategories, customCategory]);
}

function cleanCategory(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.trim() || undefined;
}

function uniqueCategories(values: readonly unknown[]): string[] {
  const categories: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const category = cleanCategory(value);
    if (category !== undefined && !seen.has(category)) {
      seen.add(category);
      categories.push(category);
    }
  }

  return categories;
}
