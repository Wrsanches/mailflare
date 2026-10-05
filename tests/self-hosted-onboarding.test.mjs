import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { SourceTextModule, SyntheticModule } from "node:vm";
import test from "node:test";

// Execute the real TypeScript modules; replace only their remote API imports.
async function load(path, imports) {
  const source = readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
  const module = new SourceTextModule(stripTypeScriptTypes(source));
  await module.link((name) => {
    assert.ok(imports[name], `Unexpected import: ${name}`);
    const values = imports[name];
    return new SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    });
  });
  await module.evaluate();
  return module.namespace;
}

const runtime = await load("src/lib/runtime.ts", {});
const configuration = await load("src/lib/setup/configuration.ts", {
  "@/lib/runtime": runtime,
});

test("self-hosted registration can precede provider credentials but requires a database", () => {
  const checks = configuration.getSetupRequirementChecks({ MAILFLARE_RUNTIME: "node", DB: {} });
  assert.ok(checks.every((check) => check.configured));
  const missingDatabase = configuration.getSetupRequirementChecks({ MAILFLARE_RUNTIME: "node" });
  assert.ok(missingDatabase.some((check) => !check.configured));
});

test("Workers setup still requires Cloudflare credentials", () => {
  const checks = configuration.getSetupRequirementChecks({ DB: {} });
  assert.ok(checks.some((check) => !check.configured));
  assert.ok(configuration.getSetupRequirementChecks({ DB: {}, CF_TOKEN: "test-token" }).every((check) => check.configured));
});

test("manual self-hosted domain preflight avoids Cloudflare, while managed domains still query it", async () => {
  let requests = 0;
  const preflight = await load("src/lib/domains/preflight.ts", {
    "@/lib/runtime": runtime,
    "@/lib/cloudflare-api": {
      findZoneByHostname: async () => { requests += 1; return { id: "zone", name: "example.com" }; },
    },
  });
  const manual = await preflight.preflightDomain({ MAILFLARE_RUNTIME: "node" }, "Example.COM");
  assert.equal(manual.hostname, "example.com");
  assert.equal(manual.zone.id, "manual");
  assert.equal(requests, 0);
  assert.equal((await preflight.preflightDomain({ MAILFLARE_RUNTIME: "node", CF_TOKEN: "test-token" }, "example.com")).zone.id, "zone");
  assert.equal((await preflight.preflightDomain({}, "example.com")).zone.id, "zone");
  assert.equal(requests, 2);
});

test("a missing Cloudflare zone still rejects managed domain preflight", async () => {
  const preflight = await load("src/lib/domains/preflight.ts", {
    "@/lib/runtime": runtime,
    "@/lib/cloudflare-api": { findZoneByHostname: async () => null },
  });
  await assert.rejects(preflight.preflightDomain({ CF_TOKEN: "test-token" }, "example.com"), /Zone not found/);
});

test("manual registration skips DNS replacement checks; managed MX conflicts remain protected", async () => {
  let requests = 0;
  const mx = await load("src/lib/domains/mx-records.ts", {
    "@/lib/cloudflare-dns": {
      createDnsRecord: async () => {},
      deleteDnsRecord: async () => {},
      listMxRecords: async () => { requests += 1; return [{ content: "mx.previous-provider.example" }]; },
    },
  });
  assert.equal(await mx.hasConflictingMxRecords({}, "manual", "example.com"), false);
  assert.equal(requests, 0);
  assert.equal(await mx.hasConflictingMxRecords({}, "zone", "example.com"), true);
  assert.equal(requests, 1);
});
