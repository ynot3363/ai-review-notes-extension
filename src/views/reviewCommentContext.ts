export type ReviewCommentTreeContext =
  | 'codingNotesForAi.comment'
  | 'codingNotesForAi.resolvedComment'
  | 'codingNotesForAi.detachedComment'
  | 'codingNotesForAi.resolvedDetachedComment';

interface ReviewCommentTreeState {
  readonly anchorState: 'attached' | 'ambiguous' | 'orphaned';
  readonly status: string;
}

/** Returns the stable Explorer context used to select actions for a note. */
export function getReviewCommentTreeContext(
  review: ReviewCommentTreeState,
): ReviewCommentTreeContext {
  const isResolved = review.status.trim().toLowerCase() === 'resolved';

  if (review.anchorState === 'attached') {
    return isResolved ? 'codingNotesForAi.resolvedComment' : 'codingNotesForAi.comment';
  }

  return isResolved
    ? 'codingNotesForAi.resolvedDetachedComment'
    : 'codingNotesForAi.detachedComment';
}
