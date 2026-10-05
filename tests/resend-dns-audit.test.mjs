import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { SourceTextModule, SyntheticModule } from "node:vm";
import test from "node:test";

async function audit(records, answers, failures = []) {
  const calls = [];
  const source = readFileSync(new URL("../src/lib/domains/dns-audit.ts", import.meta.url), "utf8");
  const module = new SourceTextModule(stripTypeScriptTypes(source, { mode: "transform" }));
  await module.link(() => new SyntheticModule(["queryDns"], function () {
    this.setExport("queryDns", async (name, type) => {
      const key = `${name} ${type}`;
      calls.push(key);
      if (failures.includes(key)) throw new Error("DNS unavailable");
      return answers[key] ?? [];
    });
  }));
  await module.evaluate();
  const result = await module.namespace.auditDomainDns("example.com", {
    routing: { records: [], missing: [] }, sending: [], resendSending: records,
  });
  return { result, calls };
}

const modern = [
  { record: "SPF", name: "send", type: "CNAME", value: "send.forge.rmta.net" },
  { record: "SPF", name: "rsend", type: "CNAME", value: "rsend-sae1.forge.rmta.net" },
  { record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=publicKey" },
];
const answers = {
  "send.example.com CNAME": ["send.forge.rmta.net."],
  "rsend.example.com CNAME": ["RSEND-SAE1.FORGE.RMTA.NET."],
  "resend._domainkey.example.com TXT": ["p=publicKey"],
  "example.com MX": ["9 inbound-smtp.sa-east-1.amazonaws.com."],
  "_dmarc.example.com TXT": ["v=DMARC1; p=none"],
};

test("Resend CNAME SPF and its DKIM selector pass without apex SPF", async () => {
  const { result, calls } = await audit(modern, answers);
  assert.deepEqual([result.mx.status, result.spf.status, result.dkim.status, result.dmarc.status], ["ok", "ok", "ok", "ok"]);
  assert.ok(!calls.includes("example.com TXT"));
});

test("an old Google SPF cannot hide a missing Resend fallback CNAME", async () => {
  const { result } = await audit(modern, { ...answers, "rsend.example.com CNAME": [], "example.com TXT": ["v=spf1 include:_spf.google.com ~all"] });
  assert.equal(result.spf.status, "missing");
});

test("legacy Resend SPF requires both its return-path MX and TXT", async () => {
  const records = [
    { record: "SPF", name: "send", type: "MX", value: "feedback-smtp.sa-east-1.amazonses.com", priority: 10 },
    { record: "SPF", name: "send", type: "TXT", value: "v=spf1 include:amazonses.com ~all" },
  ];
  const legacy = { "send.example.com MX": ["10 feedback-smtp.sa-east-1.amazonses.com."], "send.example.com TXT": ["v=spf1 include:amazonses.com ~all"] };
  assert.equal((await audit(records, legacy)).result.spf.status, "ok");
  assert.equal((await audit(records, { ...legacy, "send.example.com MX": [] })).result.spf.status, "missing");
});

test("another DKIM key at the right selector remains missing", async () => {
  assert.equal((await audit(modern, { ...answers, "resend._domainkey.example.com TXT": ["p=otherKey"] })).result.dkim.status, "missing");
});

test("absolute names are not appended and DNS failures remain unknown", async () => {
  const records = modern.map(item => ({ ...item, name: `${item.name}.example.com.` }));
  const { result, calls } = await audit(records, answers, ["send.example.com CNAME"]);
  assert.equal(result.spf.status, "unknown");
  assert.equal(result.dkim.status, "ok");
  assert.ok(!calls.some(name => name.includes("example.com.example.com")));
});

test("unavailable Resend requirements cannot fall back to another provider", async () => {
  const { result } = await audit([], { ...answers, "example.com TXT": ["v=spf1 include:_spf.google.com ~all"] });
  assert.equal(result.spf.status, "unknown");
  assert.equal(result.dkim.status, "unknown");
});
