import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../auth/api.ts';

export function useFetch<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (path === null) return;
    const mine = ++seq.current;
    try {
      const d = await api<T>(path);
      if (mine === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setData(null);
    setLoading(path !== null);
    void reload();
  }, [path, reload]);

  return { data, setData, error, loading, reload };
}
