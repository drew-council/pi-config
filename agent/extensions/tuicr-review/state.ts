import type { TuicrComment, TuicrReview } from "./parser.js";

/** Comments in a review that have not been marked addressed, in review order. */
export function remainingComments(review: TuicrReview, addressedIds: readonly string[]): TuicrComment[] {
  const addressed = new Set(addressedIds);
  return review.comments.filter((comment) => !addressed.has(comment.id));
}
