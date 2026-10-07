/**
 * SSRF guard for the server-side preview fetch. Mirrors `_check_url` / `_is_public` in
 * src/autotinker/data/fetch.py: https only, no credentials, and every address the host resolves to must be public.
 *
 * Known gap (same as the engine): fetch() resolves the host again when it connects, so a DNS-rebinding attacker could
 * swap answers between our check and the connect (TOCTOU). The preview only reads ≤ 2 MB and returns parsed text, and
 * redirects are re-checked hop by hop; pinning the checked IP in a custom dispatcher would close the gap.
 */

export type Resolver = (host: string) => Promise<string[]>;

export type PreviewErrorCode =
  | "invalid_url"
  | "not_https"
  | "credentials"
  | "blocked_host"
  | "dns"
  | "too_many_redirects"
  | "not_found"
  | "http_error"
  | "timeout"
  | "too_big"
  | "html"
  | "not_csv"
  | "empty"
  | "network";

export class PreviewError extends Error {
  constructor(
    readonly code: PreviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PreviewError";
  }
}

// ------------------------------------------------------------------------------------------------ IPv4

function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** [network, prefix] pairs that are not public internet. */
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local (cloud metadata lives here)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

const v4num = (o: number[]) => ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];

function isPublicV4(o: number[]): boolean {
  const n = v4num(o);
  for (const [net, prefix] of V4_BLOCKED) {
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    if (((n & mask) >>> 0) === ((v4num(parseIPv4(net)!) & mask) >>> 0)) return false;
  }
  return true;
}

// ------------------------------------------------------------------------------------------------ IPv6

/** Expand an IPv6 literal to 16 bytes (handles ::, and an embedded dotted IPv4 tail). Null if invalid. */
function parseIPv6(input: string): number[] | null {
  let s = input.split("%", 1)[0].toLowerCase();
  if (!s.includes(":")) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return null;
    tail = v4;
    s = s.slice(0, lastColon + 1) + "0:0"; // placeholder groups, replaced below
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = parseGroups(halves[0]);
  const rest = halves.length === 2 ? parseGroups(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const groups = halves.length === 2 ? [...head, ...Array(fill).fill("0"), ...rest] : head;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

const startsWith = (b: number[], prefix: number[], bits: number) => {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const bit = 7 - (i & 7);
    if (((b[byte] >> bit) & 1) !== ((prefix[byte] >> bit) & 1)) return false;
  }
  return true;
};

function isPublicV6(b: number[]): boolean {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d (IPv4-mapped) -> judge the IPv4 address
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPublicV4(b.slice(12));
  // ::/96 (unspecified, loopback, deprecated IPv4-compatible) -> never public
  if (zero(0, 12)) return false;
  // 2002::/16 (6to4) -> judge the embedded IPv4 address
  if (b[0] === 0x20 && b[1] === 0x02) return isPublicV4(b.slice(2, 6));
  // 64:ff9b::/96 (NAT64) and 64:ff9b:1::/48 -> could reach anything; block
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return false;
  // Only global unicast (2000::/3) can be public at all; that excludes fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64.
  if ((b[0] & 0xe0) !== 0x20) return false;
  // Inside 2000::/3: 2001::/23 (IETF protocol assignments incl. Teredo 2001::/32) and 2001:db8::/32 (documentation)
  if (startsWith(b, [0x20, 0x01, 0x00, 0x00], 23)) return false;
  if (startsWith(b, [0x20, 0x01, 0x0d, 0xb8], 32)) return false;
  return true;
}

/** True only for addresses on the public internet. Unparseable input is not public. */
export function isPublicIp(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(a);
  if (v4) return isPublicV4(v4);
  const v6 = parseIPv6(a);
  if (v6) return isPublicV6(v6);
  return false;
}

export const isIpLiteral = (host: string) => {
  const h = host.replace(/^\[|\]$/g, "");
  return parseIPv4(h) !== null || parseIPv6(h) !== null;
};

/** Reject anything that is not an https URL to a host whose every address is public. Returns the parsed URL. */
export async function checkUrl(raw: string, resolve: Resolver): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PreviewError("invalid_url", "That isn't a valid link. Paste the full address, starting with https://");
  }
  if (u.protocol === "http:") throw new PreviewError("not_https", "Only https:// links are supported. Try the same link with https://");
  if (u.protocol !== "https:") throw new PreviewError("not_https", `Only https:// links are supported (this one starts with ${u.protocol}).`);
  if (u.username || u.password) throw new PreviewError("credentials", "Links with a user name or password in them aren't allowed.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new PreviewError("invalid_url", "The link has no host name.");

  let addresses: string[];
  if (isIpLiteral(host)) addresses = [host];
  else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new PreviewError("dns", `Couldn't find the server "${host}". Check the link for typos.`);
    }
    if (!addresses.length) throw new PreviewError("dns", `Couldn't find the server "${host}". Check the link for typos.`);
  }
  for (const a of addresses)
    if (!isPublicIp(a))
      throw new PreviewError("blocked_host", `"${host}" points at a private or reserved network address. Only public internet hosts are allowed.`);
  return u;
}
