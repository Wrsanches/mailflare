import type { CfDnsRecord } from "@/lib/cloudflare-api.types";
import { queryDns, type DnsQueryType } from "@/lib/dns-query";
import type { ResendDomainView } from "@/lib/domains/resend-domain-types";

export type DnsAuthRecord = "mx" | "spf" | "dkim" | "dmarc";
export type DnsAuthStatus = "ok" | "missing" | "unknown";

export type DnsAuthCheck = {
	record: DnsAuthRecord;
	label: string;
	name: string;
	status: DnsAuthStatus;
	found: string[];
};

export type DomainDnsAudit = {
	mx: DnsAuthCheck;
	spf: DnsAuthCheck;
	dkim: DnsAuthCheck;
	dmarc: DnsAuthCheck;
};

type AuditInput = {
	routing: { records: CfDnsRecord[]; missing: CfDnsRecord[] };
	sending: CfDnsRecord[];
	dkimSelector?: string;
	/** The selected Resend sender's required records, including its return-path SPF. */
	resendSending?: ResendDomainView["records"];
};

function isTxt(record: CfDnsRecord) {
	return record.type?.toUpperCase() === "TXT";
}

async function checkResendRecords(
	hostname: string,
	record: "spf" | "dkim",
	records: ResendDomainView["records"],
): Promise<DnsAuthCheck> {
	const label = record.toUpperCase();
	const expected = records.filter((item) => item.record.toUpperCase() === label);
	const absoluteName = (name: string) => {
		const normalized = name.trim().replace(/\.$/, "").toLowerCase();
		return !normalized || normalized === "@" ? hostname
			: normalized === hostname || normalized.endsWith(`.${hostname}`) ? normalized : `${normalized}.${hostname}`;
	};
	const normalize = (value: string) => value.replace(/^"|"$/g, "").trim().replace(/\.$/, "");
	const results = await Promise.all(expected.map(async (item) => {
		const name = absoluteName(item.name);
		try {
			const answers = await queryDns(name, item.type);
			const wanted = item.type === "MX" ? `${item.priority ?? 10} ${item.value}` : item.value;
			const found = answers.filter((answer) => item.type === "TXT"
				? normalize(answer) === normalize(wanted)
				: normalize(answer).toLowerCase() === normalize(wanted).toLowerCase());
			return { name, found, status: found.length ? "ok" as const : "missing" as const };
		} catch { return { name, found: [], status: "unknown" as const }; }
	}));
	return {
		record, label,
		name: [...new Set(results.map((item) => item.name))].join(", ") || hostname,
		status: results.some((item) => item.status === "missing") ? "missing"
			: !results.length || results.some((item) => item.status === "unknown") ? "unknown" : "ok",
		found: results.flatMap((item) => item.found),
	};
}

async function check(
	record: DnsAuthRecord,
	label: string,
	name: string,
	type: DnsQueryType,
	matches: (value: string) => boolean,
): Promise<DnsAuthCheck> {
	try {
		const answers = await queryDns(name, type);
		const found = answers.filter(matches);
		return { record, label, name, status: found.length > 0 ? "ok" : "missing", found };
	} catch {
		return { record, label, name, status: "unknown", found: [] };
	}
}

/**
 * Independently verifies the public DNS a domain needs, rather than trusting
 * the zone records the Cloudflare API reports. MX, SPF and DMARC are checked at
 * their canonical names; DKIM uses the selector the sending subdomain was
 * provisioned with. A name that resolves is "ok", one that answers NXDOMAIN is
 * "missing", and a lookup that fails outright is "unknown".
 */
export async function auditDomainDns(
	hostname: string,
	view: AuditInput,
): Promise<DomainDnsAudit> {
	const expected = [...view.routing.records, ...view.routing.missing, ...view.sending];
	// Cloudflare reports the selector it signs with, which is more reliable than
	// guessing from the subdomain's DNS records (whose names may be relative).
	const dkimName =
		(view.dkimSelector
			? `${view.dkimSelector}._domainkey.${hostname}`
			: undefined) ??
		expected.find((record) => isTxt(record) && /_domainkey/i.test(record.name ?? ""))?.name;

	const [mx, spf, dmarc] = await Promise.all([
		check("mx", "MX", hostname, "MX", (value) => !/^0\s*\.?$/.test(value.trim())),
		view.resendSending !== undefined
			? checkResendRecords(hostname, "spf", view.resendSending)
			: check("spf", "SPF", hostname, "TXT", (value) => /v=spf1/i.test(value)),
		check("dmarc", "DMARC", `_dmarc.${hostname}`, "TXT", (value) => /v=DMARC1/i.test(value)),
	]);

	const dkim: DnsAuthCheck = view.resendSending !== undefined
		? await checkResendRecords(hostname, "dkim", view.resendSending)
		: dkimName
		? await check("dkim", "DKIM", dkimName, "TXT", () => true)
		: {
				record: "dkim",
				label: "DKIM",
				name: `*._domainkey.${hostname}`,
				status: "unknown",
				found: [],
			};

	return { mx, spf, dkim, dmarc };
}
