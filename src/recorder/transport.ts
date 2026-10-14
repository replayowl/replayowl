import { PROTOCOL_VERSION, type IngestBatch, type ReplayEvent } from "../shared/protocol.ts";

// Every flush becomes one stored object, so batches are kept fairly large.
const FLUSH_INTERVAL_MS = 4000;
const MAX_BATCH_EVENTS = 400;
const KEEPALIVE_LIMIT = 60 * 1024;
const MAX_RETRIES = 6;

/**
 * Ordered, batched upload. Batches go out one at a time so the server sees them in order;
 * failed batches are retried with backoff before anything newer is sent.
 */
export class Transport {
  private queue: ReplayEvent[] = [];
  /** Batches not sent yet. The one pump() is sending is taken out and kept in `inflight`. */
  private outbox: IngestBatch[] = [];
  private inflight: IngestBatch | null = null;
  private sending = false;
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private endpoint: string;
  private sid: string;
  private view: string;

  constructor(endpoint: string, sid: string, view: string) {
    this.endpoint = endpoint;
    this.sid = sid;
    this.view = view;
  }

  start() {
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flushNow();
  }

  push(ev: ReplayEvent) {
    this.queue.push(ev);
    if (this.queue.length >= MAX_BATCH_EVENTS) this.flush();
  }

  flush() {
    if (this.queue.length) {
      this.outbox.push(this.batch(this.queue));
      this.queue = [];
    }
    void this.pump();
  }

  private batch(events: ReplayEvent[]): IngestBatch {
    return { v: PROTOCOL_VERSION, sid: this.sid, view: this.view, seq: this.seq++, events };
  }

  private async pump() {
    if (this.sending) return;
    this.sending = true;
    try {
      for (let batch = this.outbox.shift(); batch; batch = this.outbox.shift()) {
        this.inflight = batch;
        let ok = false;
        // Give up on a batch that keeps failing so the session can continue.
        for (let attempt = 0; attempt < MAX_RETRIES && !ok; attempt++) {
          if (attempt) await sleep(Math.min(30000, 1000 * 2 ** attempt));
          ok = await this.send(batch);
        }
        this.inflight = null;
      }
    } finally {
      this.inflight = null;
      this.sending = false;
    }
  }

  private async send(batch: IngestBatch): Promise<boolean> {
    const json = JSON.stringify(batch);
    try {
      const packed = json.length > 2048 ? await gzip(json) : null;
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: packed ? { "Content-Type": "application/json", "Content-Encoding": "gzip" } : { "Content-Type": "application/json" },
        body: packed || json,
        credentials: "omit",
      });
      // 4xx other than 429 will not get better by retrying.
      return res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429);
    } catch {
      return false;
    }
  }

  /**
   * Page is going away: send everything synchronously with keepalive, uncompressed.
   * The batch pump() is sending may already have arrived, so it is resent once as it is: the server
   * ignores a repeated seq of a page view. Only batches never sent are split into pieces with new seqs.
   */
  flushNow() {
    const pending = this.outbox.splice(0);
    if (this.queue.length) pending.push(this.batch(this.queue));
    this.queue = [];
    const parts = this.inflight ? [this.inflight] : [];
    for (const batch of pending) parts.push(...splitForKeepalive(batch, () => this.seq++));
    for (const part of parts) {
      const body = JSON.stringify(part);
      try {
        void fetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: body.length <= KEEPALIVE_LIMIT,
          credentials: "omit",
        }).catch(() => {});
      } catch {
        /* nothing else to do while unloading */
      }
    }
  }
}

function splitForKeepalive(batch: IngestBatch, nextSeq: () => number): IngestBatch[] {
  if (JSON.stringify(batch).length <= KEEPALIVE_LIMIT || batch.events.length < 2) return [batch];
  const half = Math.ceil(batch.events.length / 2);
  return [
    ...splitForKeepalive({ ...batch, events: batch.events.slice(0, half) }, nextSeq),
    ...splitForKeepalive({ ...batch, seq: nextSeq(), events: batch.events.slice(half) }, nextSeq),
  ];
}

async function gzip(text: string): Promise<ArrayBuffer | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return await new Response(stream).arrayBuffer();
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
