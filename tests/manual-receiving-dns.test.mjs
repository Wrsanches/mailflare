import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { SourceTextModule, SyntheticModule } from "node:vm";
import test from "node:test";

async function load({ answers = [], failure = false, managed = [] } = {}) {
  let cloudflareReads = 0;
  const imports = {
    "@/lib/cloudflare-dns": {
      createDnsRecord: async () => {},
      deleteDnsRecord: async () => {},
      listMxRecords: async () => { cloudflareReads++; return managed; },
    },
    "@/lib/domains/provision": { isManualZone: (id) => id === "manual" },
    "@/lib/dns-query": {
      queryDns: async (hostname, type) => {
        assert.equal(hostname, "example.com");
        assert.equal(type, "MX");
        if (failure) throw new Error("DNS unavailable");
        return answers;
      },
    },
  };
  const source = readFileSync(new URL("../src/lib/domains/receiving-dns.ts", import.meta.url), "utf8");
  const module = new SourceTextModule(stripTypeScriptTypes(source, { mode: "transform" }));
  await module.link((name) => {
    assert.ok(imports[name], `Unexpected import: ${name}`);
    const values = imports[name];
    return new SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    });
  });
  await module.evaluate();
  return { hasMx: module.namespace.hasMx, cloudflareReads: () => cloudflareReads };
}

const domain = { hostname: "example.com", zoneId: "manual" };
const expected = "inbound-smtp.us-east-1.amazonaws.com";

test("manual domains verify the public receiving MX without Cloudflare credentials", async () => {
  const dns = await load({ answers: [`10 ${expected.toUpperCase()}.`] });
  assert.equal(await dns.hasMx({}, domain, expected), true);
  assert.equal(dns.cloudflareReads(), 0);
});

test("missing MX, null MX and another provider cannot report receiving ready", async () => {
  for (const answers of [[], ["0 ."], ["10 smtp.google.com."], ["alias.example.com."]]) {
    const dns = await load({ answers });
    assert.equal(await dns.hasMx({}, domain, expected), false);
  }
});

test("mixed providers cannot report receiving ready even when the expected MX exists", async () => {
  const dns = await load({ answers: [`10 ${expected}.`, "1 smtp.google.com."] });
  assert.equal(await dns.hasMx({}, domain, expected), false);
});

test("a failed DNS lookup remains unknown", async () => {
  const dns = await load({ failure: true });
  assert.equal(await dns.hasMx({}, domain, expected), null);
});

test("managed domains retain their Cloudflare lookup", async () => {
  const dns = await load({ failure: true, managed: [{ content: `${expected}.` }] });
  assert.equal(await dns.hasMx({}, { ...domain, zoneId: "zone" }, expected), true);
  assert.equal(dns.cloudflareReads(), 1);
});
