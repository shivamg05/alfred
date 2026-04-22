import { config } from "../config.js";

const BASE = "https://api.firecrawl.dev/v2";

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${config().FIRECRAWL_API_KEY}`,
    "Content-Type": "application/json",
  };
}

/** Search the web via Firecrawl. Returns clean markdown excerpts. */
export async function searchWeb(query: string): Promise<string> {
  const res = await fetch(`${BASE}/search`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      query,
      limit: 5,
      scrapeOptions: { formats: ["markdown"] },
    }),
  });

  if (!res.ok) throw new Error(`Firecrawl search failed: ${res.status}`);

  const data = (await res.json()) as {
    success: boolean;
    data?: Array<{
      url: string;
      title?: string;
      description?: string;
      markdown?: string;
    }>;
  };

  if (!data.success || !data.data?.length) return "No results found.";

  return data.data
    .slice(0, 5)
    .map((r) => {
      const header = `**${r.title ?? r.url}**\n${r.url}`;
      const body = r.markdown?.slice(0, 600) ?? r.description ?? "";
      return `${header}\n${body}`;
    })
    .join("\n\n---\n\n");
}

/** Rewrite Twitter/X URLs to fxtwitter.com so Firecrawl can actually read them. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "x.com" || u.hostname === "twitter.com" || u.hostname === "www.x.com" || u.hostname === "www.twitter.com") {
      u.hostname = "fxtwitter.com";
      return u.toString();
    }
  } catch {
    // not a valid URL, pass through
  }
  return url;
}

/** Fetch and return cleaned markdown from a URL via Firecrawl. */
export async function scrapeUrl(url: string): Promise<string> {
  const normalized = normalizeUrl(url);
  if (normalized !== url) console.log(`[tools/web] rewrote ${url} → ${normalized}`);

  const res = await fetch(`${BASE}/scrape`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ url: normalized, formats: ["markdown"] }),
  });

  if (!res.ok) throw new Error(`Firecrawl scrape failed: ${res.status}`);

  const data = (await res.json()) as {
    success: boolean;
    data?: { markdown?: string; metadata?: { title?: string } };
  };

  if (!data.success || !data.data?.markdown) return "Could not read that URL.";

  const md = data.data.markdown;
  const title = data.data.metadata?.title ? `# ${data.data.metadata.title}\n\n` : "";
  const truncated = md.length > 4000 ? md.slice(0, 4000) + "\n\n[truncated]" : md;
  return `${title}${truncated}`;
}

export async function executeWebTool(
  name: string,
  args: Record<string, string>,
): Promise<string> {
  try {
    if (name === "search_web") return await searchWeb(args.query);
    if (name === "scrape_url") return await scrapeUrl(args.url);
    return `Unknown web tool: ${name}`;
  } catch (err) {
    console.error(`[tools/web] ${name} failed:`, err);
    return `Error running ${name}: ${String(err)}`;
  }
}
