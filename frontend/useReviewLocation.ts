import { onUnmounted, shallowRef } from 'vue';
import { readReviewLocation, reviewUrl, type ReviewLocation } from './review-records';

export function useReviewLocation() {
  const location = shallowRef(readReviewLocation(new URL(window.location.href)));
  function restore() {
    location.value = readReviewLocation(new URL(window.location.href));
  }
  window.addEventListener('popstate', restore);
  onUnmounted(() => window.removeEventListener('popstate', restore));

  function navigate(next: ReviewLocation, replace = false) {
    const url = reviewUrl(next);
    if (replace) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    location.value = next;
  }
  function filter(next: Partial<Pick<ReviewLocation, 'from' | 'to' | 'symbol'>>) {
    navigate({ ...location.value, ...next, page: 1 }, true);
  }
  return {
    location,
    filter,
    paginate: (page: number) => navigate({ ...location.value, page }, true),
    show: (tradeId: string) => navigate({ ...location.value, tradeId }),
    back: () => navigate({ ...location.value, tradeId: null }),
    view: (view?: 'cycles') => navigate({ ...location.value, view, tradeId: null, page: 1 }),
  };
}
