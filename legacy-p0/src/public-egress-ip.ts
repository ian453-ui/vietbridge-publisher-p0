import { isIP } from "node:net";

const IP_ECHO_ENDPOINTS = ["https://api.ipify.org", "https://checkip.amazonaws.com"] as const;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function ipv4Number(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  return ip.split(".").reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function inRange(ip: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

/** True only for an IPv4 address suitable for a public allowlist. */
export function isPublicIpv4(value: string): boolean {
  const ip = ipv4Number(value.trim());
  if (ip === null) return false;
  const reserved: Array<[number, number]> = [
    [0x00000000, 8], // this network
    [0x0a000000, 8], // private
    [0x64400000, 10], // shared address space / CGNAT
    [0x7f000000, 8], // loopback
    [0xa9fe0000, 16], // link-local
    [0xac100000, 12], // private
    [0xc0000000, 24], // protocol assignments
    [0xc0000200, 24], // documentation
    [0xc0586300, 24], // 6to4 relay anycast
    [0xc0a80000, 16], // private
    [0xc6120000, 15], // benchmarking
    [0xc6336400, 24], // documentation
    [0xcb007100, 24], // documentation
    [0xe0000000, 4], // multicast and reserved
    [0xf0000000, 4], // reserved and limited broadcast
  ];
  return !reserved.some(([base, bits]) => inRange(ip, base, bits));
}

/** Resolve the IPv4 address used by this Publisher process for outbound internet requests. */
export async function resolvePublicEgressIpv4(fetcher: FetchLike = fetch): Promise<string> {
  for (const endpoint of IP_ECHO_ENDPOINTS) {
    try {
      const response = await fetcher(endpoint, { signal: AbortSignal.timeout(4500), redirect: "error" });
      if (!response.ok) continue;
      const value = (await response.text()).trim();
      if (isPublicIpv4(value)) return value;
    } catch {
      // Try the independent provider; never return unvalidated provider content or errors.
    }
  }
  throw new Error("PUBLIC_EGRESS_IPV4_UNAVAILABLE");
}
