import type { ReviewComment, ReviewThread } from "./types.js";

/**
 * True when the PR author is the only participant in the thread. Threads where a reviewer also
 * commented stay in scope even if the author opened them, since they still expect a reply.
 */
export function isAuthorOnlyThread(thread: ReviewThread, prAuthor: string | null): boolean {
  if (!prAuthor) return false;
  return thread.comments.length > 0 && thread.comments.every((comment) => comment.author === prAuthor);
}

export function isAuthorComment(comment: ReviewComment, prAuthor: string | null): boolean {
  return Boolean(prAuthor) && comment.author === prAuthor;
}

export interface AuthorFilterResult {
  threads: ReviewThread[];
  reviews: ReviewComment[];
  /** Number of threads and top-level reviews dropped because the PR author wrote them. */
  skipped: number;
}

export function filterAuthorComments(
  threads: ReviewThread[],
  reviews: ReviewComment[],
  prAuthor: string | null,
): AuthorFilterResult {
  const keptThreads = threads.filter((thread) => !isAuthorOnlyThread(thread, prAuthor));
  const keptReviews = reviews.filter((review) => !isAuthorComment(review, prAuthor));
  return {
    threads: keptThreads,
    reviews: keptReviews,
    skipped: threads.length - keptThreads.length + (reviews.length - keptReviews.length),
  };
}
