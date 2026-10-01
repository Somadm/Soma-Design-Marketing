import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * Reads a public web page (a Pinterest pin, an Instagram post, any article) the way a chat
 * app builds a link preview: its title, description and main image. Only public internet
 * addresses are fetched, never the server's own network.
 */

export class LinkError extends Error {}

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) blocked.addSubnet(net, bits, "ipv6");

export function isPublicAddress(address: string): boolean {
  // IPv4 written as IPv6 (::ffff:10.0.0.1) is judged as the IPv4 address it is.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPublicAddress(mapped[1]);
  if (/^::ffff:/i.test(address)) return false;
  const family = isIP(address);
  if (!family) return false;
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** DNS lookup that refuses private, loopback and link-local addresses (checked at connect time). */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as unknown as { address: string; family: number }[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad || !list.length) return callback(new LinkError("That link points to a private address."), "", 0);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new LinkError("That doesn't look like a web link.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new LinkError("Only http and https links work.");
  if (u.username || u.password) throw new LinkError("Links with a username or password aren't accepted.");
  if (u.port && !["80", "443"].includes(u.port)) throw new LinkError("Links on unusual ports aren't accepted.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new LinkError("That link points to a private address.");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new LinkError("That link points to a private address.");
  return u;
}

const UA = "Mozilla/5.0 (compatible; SagalLinkPreview/1.0; +https://sagal.onrender.com)";

/** GET with redirects re-checked at every hop, a time limit and a size limit. */
export async function safeGet(raw: string, maxBytes: number, accept: string, timeoutMs = 8000): Promise<{ url: string; contentType: string; body: Buffer }> {
  let url = checkUrl(raw);
  for (let hop = 0; hop < 5; hop++) {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.get(url, { lookup: safeLookup, headers: { "user-agent": UA, accept, "accept-encoding": "identity", "accept-language": "en" }, timeout: timeoutMs }, resolve);
      req.on("timeout", () => req.destroy(new LinkError("The page took too long to answer.")));
      req.on("error", reject);
    });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      url = checkUrl(new URL(res.headers.location, url).toString());
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new LinkError(`The page answered with an error (${status}).`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => res.destroy(new LinkError("The page took too long to answer.")), timeoutMs);
    try {
      for await (const c of res) {
        size += (c as Buffer).length;
        if (size > maxBytes) {
          res.destroy();
          break;
        }
        chunks.push(c as Buffer);
      }
    } finally {
      clearTimeout(timer);
    }
    return { url: url.toString(), contentType: String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase(), body: Buffer.concat(chunks) };
  }
  throw new LinkError("The link redirected too many times.");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z0-9#]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();

export interface PageInfo {
  title: string;
  description: string;
  image: string | null;
  site: string;
}

/** Open Graph / Twitter card tags, falling back to <title>. */
export function parsePage(html: string, pageUrl: string): PageInfo {
  const meta: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
    const key = attr("property") ?? attr("name");
    const content = attr("content");
    if (!key || !content) continue;
    const k = (key[2] ?? key[3]).toLowerCase();
    if (!(k in meta)) meta[k] = decode(content[2] ?? content[3]);
  }
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  let image = meta["og:image:secure_url"] || meta["og:image"] || meta["twitter:image"] || meta["twitter:image:src"] || null;
  if (image) {
    try {
      image = new URL(image, pageUrl).toString();
    } catch {
      image = null;
    }
  }
  return {
    title: (meta["og:title"] || meta["twitter:title"] || (titleTag ? decode(titleTag) : "")).slice(0, 160),
    description: (meta["og:description"] || meta["twitter:description"] || meta["description"] || "").slice(0, 600),
    image,
    site: (meta["og:site_name"] || new URL(pageUrl).hostname.replace(/^www\./, "")).slice(0, 80),
  };
}

const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/;

export interface Preview extends PageInfo {
  url: string;
  imageBytes: { data: Buffer; contentType: string; filename: string } | null;
}

/** Page info plus its main image (if it's a normal picture under 8 MB). */
export async function fetchPreview(raw: string): Promise<Preview> {
  const page = await safeGet(raw, 1_500_000, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5");
  // A direct link to a picture: the picture is the preview.
  if (IMAGE_TYPES.test(page.contentType)) {
    const name = new URL(page.url).pathname.split("/").pop() || "reference";
    return { url: page.url, title: name, description: "", image: page.url, site: new URL(page.url).hostname.replace(/^www\./, ""), imageBytes: { data: page.body, contentType: page.contentType, filename: name } };
  }
  const info = parsePage(page.body.toString("utf8"), page.url);
  let imageBytes: Preview["imageBytes"] = null;
  if (info.image) {
    try {
      const img = await safeGet(info.image, 8 * 1024 * 1024, "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5");
      if (IMAGE_TYPES.test(img.contentType) && img.body.length < 8 * 1024 * 1024) {
        const ext = img.contentType.split("/")[1].replace("jpeg", "jpg");
        imageBytes = { data: img.body, contentType: img.contentType, filename: `${info.site || "reference"}.${ext}` };
      }
    } catch {
      // The page still counts as a reference without its picture.
    }
  }
  return { ...info, url: raw.trim(), imageBytes };
}
