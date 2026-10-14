// Minimal object storage used by the session store. Implementations: S3 (any S3-compatible service,
// works on Workers and Node) and the local filesystem (Node only, for development).

export interface ListResult {
  keys: string[];
  /** Pass as `startAfter` to continue, null when the listing is complete. */
  next: string | null;
}

export interface ObjectStorage {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys under `prefix` in lexicographic order. */
  list(prefix: string, opts?: { startAfter?: string; limit?: number }): Promise<ListResult>;
}

export async function listAll(storage: ObjectStorage, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list(prefix, { startAfter, limit: 1000 });
    out.push(...page.keys);
    if (!page.next) return out;
    startAfter = page.next;
  }
}

/** Runs `fn` over items with at most `limit` in flight. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
