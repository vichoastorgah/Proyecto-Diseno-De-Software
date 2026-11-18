import { useCallback, useEffect, useState } from "react";

/**
 * Loads data with an async `fetcher(signal)`, tracking loading and error state.
 *
 * - The request is aborted when the component unmounts or `fetcher` changes.
 * - `reload()` fetches again while the current data stays on screen.
 * - State is only updated from the promise callbacks (never synchronously inside the
 *   effect), and "loading" is derived: the stored result belongs to an older request.
 *
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} fetcher - Must be memoized (useCallback).
 * @returns {{ data: T | null, error: unknown, loading: boolean, reload: () => void, setData: (data: T) => void }}
 */
export function useResource(fetcher) {
  const [reloadCount, setReloadCount] = useState(0);
  const [result, setResult] = useState({ data: null, error: null, fetcher: null, reloadCount: -1 });

  useEffect(() => {
    const controller = new AbortController();
    fetcher(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ data, error: null, fetcher, reloadCount });
      },
      (error) => {
        if (controller.signal.aborted || error?.name === "AbortError") return;
        setResult((previous) => ({ data: previous.data, error, fetcher, reloadCount }));
      }
    );
    return () => controller.abort();
  }, [fetcher, reloadCount]);

  const reload = useCallback(() => setReloadCount((count) => count + 1), []);
  const setData = useCallback((data) => setResult((previous) => ({ ...previous, data, error: null })), []);
  const loading = result.fetcher !== fetcher || result.reloadCount !== reloadCount;

  return { data: result.data, error: result.error, loading, reload, setData };
}
