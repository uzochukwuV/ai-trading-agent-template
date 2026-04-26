/**
 * News & sentiment feed via PRISM API.
 *
 * Pulls:
 *   - /news/crypto              latest crypto news
 *   - /market/fear-greed        market sentiment 0-100
 *   - /crypto/trending          top trending coins
 *
 * Cached in memory for `cacheTtlMs` (default 30 min) to keep API usage cheap.
 * If PRISM_API_KEY is missing, returns empty feed gracefully.
 */

const PRISM_BASE = "https://api.prismapi.ai";

export interface NewsArticle {
  title: string;
  source?: string;
  url?: string;
  publishedAt?: number;
  summary?: string;
  symbols?: string[];
  sentiment?: number;             // -1..1 if available
}

export interface MarketSentiment {
  fearGreed?: { value: number; label: string; ts: number } | null;
  trending?: Array<{ symbol: string; name?: string; rank?: number }>;
}

export interface NewsSnapshot {
  fetchedAt: number;
  cacheUntil: number;
  articles: NewsArticle[];
  sentiment: MarketSentiment;
  errors: string[];
}

export class NewsFeed {
  private snap: NewsSnapshot | null = null;
  private inflight: Promise<NewsSnapshot> | null = null;

  constructor(
    private apiKey: string | undefined,
    private cacheTtlMs = 30 * 60 * 1000,
    private timeoutMs = 8000,
  ) {}

  isConfigured(): boolean { return !!this.apiKey; }

  async get(force = false): Promise<NewsSnapshot> {
    if (!force && this.snap && Date.now() < this.snap.cacheUntil) return this.snap;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchAll().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  cached(): NewsSnapshot | null { return this.snap; }

  private async fetchAll(): Promise<NewsSnapshot> {
    const errors: string[] = [];
    if (!this.apiKey) {
      this.snap = {
        fetchedAt: Date.now(),
        cacheUntil: Date.now() + this.cacheTtlMs,
        articles: [],
        sentiment: { fearGreed: null, trending: [] },
        errors: ["PRISM_API_KEY not configured"],
      };
      return this.snap;
    }
    const [news, fg, trending] = await Promise.all([
      this.safeGet<any>("/news/crypto?limit=20").catch(e => { errors.push("news: " + e.message); return null; }),
      this.safeGet<any>("/market/fear-greed").catch(e => { errors.push("fear-greed: " + e.message); return null; }),
      this.safeGet<any>("/crypto/trending?limit=10").catch(e => { errors.push("trending: " + e.message); return null; }),
    ]);

    const articles: NewsArticle[] = [];
    if (news) {
      const list = Array.isArray(news) ? news : (news.data ?? news.articles ?? news.items ?? news.results ?? []);
      for (const a of (Array.isArray(list) ? list : [])) {
        if (!a || typeof a !== "object") continue;
        articles.push({
          title: String(a.title ?? a.headline ?? a.name ?? "").slice(0, 280),
          source: a.source ?? a.publisher ?? a.outlet,
          url: a.url ?? a.link,
          publishedAt: parseTime(a.published_at ?? a.publishedAt ?? a.created_at ?? a.date),
          summary: typeof a.summary === "string" ? a.summary.slice(0, 320) : (typeof a.description === "string" ? a.description.slice(0, 320) : undefined),
          symbols: Array.isArray(a.symbols) ? a.symbols : (Array.isArray(a.tickers) ? a.tickers : undefined),
          sentiment: typeof a.sentiment === "number" ? a.sentiment : (typeof a.sentiment_score === "number" ? a.sentiment_score : undefined),
        });
      }
    }

    let fearGreed: MarketSentiment["fearGreed"] = null;
    if (fg) {
      const v = Number(fg.value ?? fg.score ?? fg.fear_greed ?? fg.fearGreed ?? fg.data?.value);
      if (Number.isFinite(v)) {
        fearGreed = {
          value: v,
          label: fg.label ?? fg.classification ?? fg.data?.classification ?? labelForFG(v),
          ts: parseTime(fg.timestamp ?? fg.updated_at ?? fg.ts) ?? Date.now(),
        };
      }
    }

    const trendingArr: MarketSentiment["trending"] = [];
    if (trending) {
      const list = Array.isArray(trending) ? trending : (trending.data ?? trending.items ?? trending.results ?? []);
      for (const t of (Array.isArray(list) ? list : [])) {
        if (!t || typeof t !== "object") continue;
        trendingArr.push({
          symbol: String(t.symbol ?? t.ticker ?? t.id ?? "").toUpperCase().slice(0, 12),
          name: t.name,
          rank: t.rank ?? t.market_cap_rank,
        });
      }
    }

    this.snap = {
      fetchedAt: Date.now(),
      cacheUntil: Date.now() + this.cacheTtlMs,
      articles: articles.slice(0, 20),
      sentiment: { fearGreed, trending: trendingArr.slice(0, 10) },
      errors,
    };
    return this.snap;
  }

  private async safeGet<T>(p: string): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await fetch(PRISM_BASE + p, {
        signal: ctrl.signal,
        headers: { "X-API-Key": this.apiKey!, "Accept": "application/json" },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as T;
    } finally {
      clearTimeout(t);
    }
  }
}

function parseTime(v: unknown): number | undefined {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!isNaN(t)) return t;
  }
  return undefined;
}

function labelForFG(v: number): string {
  if (v < 25) return "extreme fear";
  if (v < 45) return "fear";
  if (v < 55) return "neutral";
  if (v < 75) return "greed";
  return "extreme greed";
}
