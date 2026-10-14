// Storage contract tests. The filesystem backend always runs; the S3 backend runs against a real
// S3-compatible server when S3_TEST_ENDPOINT is set, for example:
//   docker run -d -p 19000:9000 -e RUSTFS_ACCESS_KEY=replayowl -e RUSTFS_SECRET_KEY=replayowl-secret-key rustfs/rustfs
//   S3_TEST_ENDPOINT=http://127.0.0.1:19000 S3_TEST_KEY=replayowl S3_TEST_SECRET=replayowl-secret-key node --test tests/unit/

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AwsClient } from "aws4fetch";
import { FsStorage } from "../../src/server/fs-storage.ts";
import { S3Storage } from "../../src/server/s3.ts";
import { listAll, type ObjectStorage } from "../../src/server/storage.ts";

const S3_ENDPOINT = process.env.S3_TEST_ENDPOINT || "";
const S3_KEY = process.env.S3_TEST_KEY || "";
const S3_SECRET = process.env.S3_TEST_SECRET || "";
// With S3_TEST_BUCKET the tests use that existing bucket and work inside a fresh folder (S3_TEST_PREFIX),
// which is removed afterwards. Without it they create a new bucket.
const S3_BUCKET = process.env.S3_TEST_BUCKET || "";
const S3_REGION = process.env.S3_TEST_REGION || "us-east-1";
const S3_PREFIX = process.env.S3_TEST_PREFIX || "replayowl-test-" + Date.now();

async function contract(storage: ObjectStorage) {
  const dec = new TextDecoder();
  assert.equal(await storage.get("missing/key.json"), null);
  await storage.put("a/b/one.json", '{"x":1}', "application/json");
  await storage.put("a/b/two.bin", new Uint8Array([1, 2, 3]));
  assert.equal(dec.decode((await storage.get("a/b/one.json"))!), '{"x":1}');
  assert.deepEqual(Array.from((await storage.get("a/b/two.bin"))!), [1, 2, 3]);
  for (let i = 0; i < 5; i++) await storage.put("list/k" + i, "v");
  const p1 = await storage.list("list/", { limit: 2 });
  assert.deepEqual(p1.keys, ["list/k0", "list/k1"]);
  assert.equal(p1.next, "list/k1");
  const p2 = await storage.list("list/", { startAfter: p1.next!, limit: 10 });
  assert.deepEqual(p2.keys, ["list/k2", "list/k3", "list/k4"]);
  assert.equal(p2.next, null);
  await storage.delete("a/b/one.json");
  await storage.delete("a/b/never-existed");
  assert.equal(await storage.get("a/b/one.json"), null);
}

test("filesystem storage", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ro-fs-"));
  try {
    await contract(new FsStorage(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("s3 storage", { skip: !S3_ENDPOINT && "set S3_TEST_ENDPOINT" }, async () => {
  let bucket = S3_BUCKET;
  if (!bucket) {
    bucket = "ro-test-" + Date.now();
    const client = new AwsClient({ accessKeyId: S3_KEY, secretAccessKey: S3_SECRET, service: "s3", region: S3_REGION });
    const made = await client.fetch(S3_ENDPOINT + "/" + bucket, { method: "PUT" });
    assert.ok(made.ok, "create bucket: " + made.status + " " + (await made.text()));
  }
  const cfg = { endpoint: S3_ENDPOINT, bucket, accessKeyId: S3_KEY, secretAccessKey: S3_SECRET, region: S3_REGION };
  const root = new S3Storage({ ...cfg, prefix: S3_PREFIX });
  try {
    await contract(new S3Storage({ ...cfg, prefix: S3_PREFIX + "/contract" }));
    // A wrong secret must be rejected by the server: proves requests are really signed and checked.
    const bad = new S3Storage({ ...cfg, prefix: S3_PREFIX, secretAccessKey: "wrong-secret" });
    await assert.rejects(() => bad.get("app/anything"), /403/);
  } finally {
    for (const key of await listAll(root, "")) await root.delete(key);
  }
  assert.deepEqual(await listAll(root, ""), []);
});
