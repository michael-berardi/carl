import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySignature } from "../src/hooks.ts";

test("webhook signatures: GitHub-style sha256 HMAC, constant-time, exact", () => {
  const body = Buffer.from('{"action":"opened"}');
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.ok(verifySignature(body, sig, "s3cret"));
  assert.ok(!verifySignature(body, sig, "other"));
  assert.ok(!verifySignature(Buffer.from('{"action":"closed"}'), sig, "s3cret"));
  assert.ok(!verifySignature(body, undefined, "s3cret"));
  assert.ok(!verifySignature(body, sig.replace("sha256=", "sha1="), "s3cret"));
});
