import { findZoneByHostname } from "@/lib/cloudflare-api";
import type { DomainPreflightResult } from "@/lib/domains/types";
import { hasCloudflareCredentials, isNodeRuntime } from "@/lib/runtime";

export async function preflightDomain(
	env: CloudflareEnv,
	hostname: string,
): Promise<DomainPreflightResult> {
	const normalized = hostname.toLowerCase().trim();
	// Self-hosted installs can manage provider DNS manually without a Cloudflare token.
	if (isNodeRuntime(env) && !hasCloudflareCredentials(env)) {
		return { hostname: normalized, zone: { id: "manual", name: normalized } };
	}
	const zone = await findZoneByHostname(env, normalized);
	if (!zone) {
		throw new Error(
			`Zone not found for "${normalized}". The domain must use Cloudflare DNS on this account.`,
		);
	}

	return { hostname: normalized, zone };
}
