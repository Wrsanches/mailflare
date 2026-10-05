import { summariseDns, type DnsStatusSummary } from "@/lib/dns-status";
import { auditDomainDns, type DomainDnsAudit } from "@/lib/domains/dns-audit";
import { getDomainDns, type DomainDnsView } from "@/lib/domains/service";
import type { DomainRow } from "@/lib/domains/types";
import { getResendDomainView } from "@/lib/domains/resend-domain";

async function auditForDomain(env: CloudflareEnv, domain: DomainRow, dns: DomainDnsView) {
	if (domain.sendingProvider !== "resend") return auditDomainDns(domain.hostname, dns);
	// A Google SPF at the apex says nothing about Resend's return-path. Audit
	// the selected sender's own requirements, and leave them unknown if its
	// key cannot read domains instead of silently checking another provider.
	const resend = await getResendDomainView(env, domain).catch(() => null);
	return auditDomainDns(domain.hostname, { ...dns, resendSending: resend?.records ?? [] });
}

export type DomainDnsViewWithAudit = DomainDnsView & { audit: DomainDnsAudit };

/** The DNS page's view: zone records plus an independent public-DNS audit. */
export async function getDomainDnsView(
	env: CloudflareEnv,
	domain: DomainRow,
): Promise<DomainDnsViewWithAudit> {
	const dns = await getDomainDns(env, domain);
	const audit = await auditForDomain(env, domain, dns);
	return { ...dns, audit };
}

/** The compact per-domain status the list endpoint returns. */
export async function summariseDomainDns(
	env: CloudflareEnv,
	domain: DomainRow,
): Promise<{ summary: DnsStatusSummary; sendingEnabled: boolean }> {
	const view = await getDomainDns(env, domain);
	const audit = await auditForDomain(env, domain, view);
	return {
		summary: summariseDns(
			view.routing.records,
			view.routing.missing,
			view.sending,
			domain.routingEnabled,
			view.sendingEnabled,
			audit,
		),
		sendingEnabled: view.sendingEnabled,
	};
}
