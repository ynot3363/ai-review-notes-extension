import { describe, expect, it } from 'vitest';

import { getReviewCommentTreeContext } from '../../../src/views/reviewCommentContext';

describe('note tree context', () => {
  it.each([
    ['attached', 'open', 'codingNotesForAi.comment'],
    ['attached', 'resolved', 'codingNotesForAi.resolvedComment'],
    ['orphaned', 'open', 'codingNotesForAi.detachedComment'],
    ['ambiguous', ' Resolved ', 'codingNotesForAi.resolvedDetachedComment'],
  ] as const)('maps an %s, %s note to %s', (anchorState, status, expectedContext) => {
    expect(getReviewCommentTreeContext({ anchorState, status })).toBe(expectedContext);
  });
});
