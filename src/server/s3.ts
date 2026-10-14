// S3-compatible storage over plain fetch with SigV4 signing (aws4fetch). Works with AWS S3,
// Cloudflare R2, MinIO and others, in Workers and in Node.

import { AwsClient } from "aws4fetch";
import type { ListResult, ObjectStorage } from "./storage.ts";

export interface S3Config {
  /** Service endpoint, e.g. https://s3.us-east-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** "auto" for R2. */
  region?: string;
  /** Optional key prefix so several deployments can share a bucket. */
  prefix?: string;
  /** Path-style URLs (endpoint/bucket/key). Default true; set false for virtual-hosted (bucket.endpoint/key). */
  pathStyle?: boolean;
}

export class S3Storage implements ObjectStorage {
  private client: AwsClient;
  private base: string;
  private prefix: string;

  constructor(cfg: S3Config) {
    if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
      throw new Error("S3 storage needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
    }
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: "s3",
      region: cfg.region || "auto",
      retries: 3,
    });
    const endpoint = cfg.endpoint.replace(/\/+$/, "");
    if (cfg.pathStyle === false) {
      const u = new URL(endpoint);
      this.base = u.protocol + "//" + cfg.bucket + "." + u.host;
    } else {
      this.base = endpoint + "/" + cfg.bucket;
    }
    this.prefix = cfg.prefix ? cfg.prefix.replace(/^\/+|\/+$/g, "") + "/" : "";
  }

  private url(key: string): string {
    return this.base + "/" + encodeKey(this.prefix + key);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.client.fetch(this.url(key), { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("S3 GET " + key + " failed: " + res.status + " " + (await res.text()).slice(0, 200));
    return new Uint8Array(await res.arrayBuffer());
  }

  async put(key: string, body: Uint8Array | string, contentType = "application/octet-stream"): Promise<void> {
    const res = await this.client.fetch(this.url(key), { method: "PUT", body: body as BodyInit, headers: { "Content-Type": contentType } });
    if (!res.ok) throw new Error("S3 PUT " + key + " failed: " + res.status + " " + (await res.text()).slice(0, 200));
  }

  async delete(key: string): Promise<void> {
    const res = await this.client.fetch(this.url(key), { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error("S3 DELETE " + key + " failed: " + res.status);
  }

  async list(prefix: string, opts: { startAfter?: string; limit?: number } = {}): Promise<ListResult> {
    const q = new URLSearchParams({ "list-type": "2", prefix: this.prefix + prefix, "max-keys": String(opts.limit || 1000) });
    if (opts.startAfter) q.set("start-after", this.prefix + opts.startAfter);
    const res = await this.client.fetch(this.base + "/?" + q.toString(), { method: "GET" });
    if (!res.ok) throw new Error("S3 LIST " + prefix + " failed: " + res.status + " " + (await res.text()).slice(0, 200));
    const xml = await res.text();
    const keys = Array.from(xml.matchAll(/<Key>([^<]*)<\/Key>/g), (m) => decodeXml(m[1]).slice(this.prefix.length));
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    return { keys, next: truncated && keys.length ? keys[keys.length - 1] : null };
  }
}

/** Encodes each path segment but keeps the slashes, as S3 expects. */
function encodeKey(key: string): string {
  return key.split("/").map((s) => encodeURIComponent(s)).join("/");
}

function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+);/g, (_m, e: string) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCharCode(Number(e.slice(1))),
  );
}

/** Reads the S3 settings from an env-like object (Worker env or process.env). */
export function s3ConfigFromEnv(env: Record<string, unknown>): S3Config | null {
  const s = (k: string) => (typeof env[k] === "string" ? (env[k] as string) : "");
  if (!s("S3_BUCKET")) return null;
  return {
    endpoint: s("S3_ENDPOINT"),
    bucket: s("S3_BUCKET"),
    accessKeyId: s("S3_ACCESS_KEY_ID"),
    secretAccessKey: s("S3_SECRET_ACCESS_KEY"),
    region: s("S3_REGION") || "auto",
    prefix: s("S3_PREFIX"),
    pathStyle: s("S3_PATH_STYLE") !== "false",
  };
}
