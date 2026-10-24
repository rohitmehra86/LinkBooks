"use client";

import { useEffect, useRef, useState } from "react";
import { isCurrentRequest, lookupCacheKey } from "@/lib/lookup/search";

export type LookupPage<T> = {
  rows: T[];
  hasMore: boolean;
};

export type LookupQueryArgs = {
  companyId: string;
  query: string;
  page: number;
  pageSize: number;
  signal: AbortSignal;
};

/**
 * Debounced, organisation-scoped lookup fetch. A newer request or a company change
 * discards the previous response. Successful pages are cached for the session.
 */
export function useLookupQuery<T>({
  companyId,
  kind,
  fetchPage,
  pageSize = 50,
  enabled = true,
  debounceMs = 250,
}: {
  companyId: string | null | undefined;
  kind: string;
  fetchPage: (args: LookupQueryArgs) => Promise<LookupPage<T>>;
  pageSize?: number;
  enabled?: boolean;
  debounceMs?: number;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<T[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const requestId = useRef(0);
  const cache = useRef(new Map<string, LookupPage<T>>());
  const bypassCache = useRef(false);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), debounceMs);
    return () => window.clearTimeout(timer);
  }, [query, debounceMs]);

  useEffect(() => {
    cache.current.clear();
    setPage(0);
    setRows([]);
    setHasMore(false);
    setError(null);
  }, [companyId]);

  useEffect(() => {
    setPage(0);
  }, [debounced, kind]);

  useEffect(() => {
    if (!enabled || !companyId) return;
    const key = lookupCacheKey(companyId, kind, debounced, page);
    const skipCache = bypassCache.current;
    bypassCache.current = false;
    if (!skipCache) {
      const cached = cache.current.get(key);
      if (cached) {
        setRows((current) => (page === 0 ? cached.rows : current));
        setHasMore(cached.hasMore);
        setError(null);
        setLoading(false);
        return;
      }
    }
    const id = ++requestId.current;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchRef
      .current({ companyId, query: debounced, page, pageSize, signal: controller.signal })
      .then((result) => {
        if (!isCurrentRequest(id, requestId.current)) return;
        cache.current.set(key, result);
        setRows((current) => (page === 0 ? result.rows : [...current, ...result.rows]));
        setHasMore(result.hasMore);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        if (!isCurrentRequest(id, requestId.current)) return;
        setError(reason instanceof Error ? reason.message : "Could not load records");
        setLoading(false);
      });
    return () => controller.abort();
  }, [companyId, kind, debounced, page, pageSize, enabled, retryToken]);

  return {
    query,
    setQuery,
    rows,
    loading,
    error,
    hasMore,
    loadMore: () => setPage((current) => current + 1),
    retry: () => {
      bypassCache.current = true;
      setRetryToken((current) => current + 1);
    },
  };
}
