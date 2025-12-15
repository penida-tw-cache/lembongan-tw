// cachewarmer_tw_gsheets.js
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseStringPromise } from "xml2js";
import * as dotenv from "dotenv";

dotenv.config();

/* ================= ENV ================= */
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

/* ================= DOMAIN / PROXY / UA ================= */
const DOMAINS_MAP = {
  tw: "https://divinglembongan.tw",
};

const PROXIES = {
  tw: process.env.BRD_PROXY_TW, // wajib TW / Asia
};

const USER_AGENTS = {
  tw: "DivingLembongan-TW-CacheWarmer/1.0",
};

/* ================= UTIL ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractCfEdge(cfRay) {
  if (typeof cfRay === "string" && cfRay.includes("-")) {
    return cfRay.split("-").pop();
  }
  return "N/A";
}

/* ================= LOGGER → GSHEETS ================= */
class AppsScriptLogger {
  constructor() {
    this.rows = [];
    this.runId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
  }

  log({
    country = "",
    url = "",
    status = "",
    cfCache = "",
    lsCache = "",
    cfRay = "",
    responseMs = "",
    error = 0,
    message = "",
  }) {
    this.rows.push([
      this.runId, // run_id
      this.startedAt, // started_at
      this.finishedAt, // finished_at (diisi nanti)
      country,
      url,
      status,
      cfCache,
      lsCache,
      cfRay,
      typeof responseMs === "number" ? responseMs : "",
      error ? 1 : 0,
      message,
    ]);
  }

  setFinished() {
    this.finishedAt = new Date().toISOString();
    // backfill finished_at untuk semua row
    this.rows = this.rows.map((r) => {
      r[2] = this.finishedAt;
      return r;
    });
  }

  async flush() {
    if (!APPS_SCRIPT_URL || this.rows.length === 0) return;

    console.log(`📝 Logging ${this.rows.length} rows to GSheets…`);

    await axios.post(
      APPS_SCRIPT_URL,
      { rows: this.rows },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 20000,
      }
    );

    console.log("✅ GSheets log sent");
    this.rows = [];
  }
}


/* ================= HTTP (ASIA-ANCHORED) ================= */
function createAsiaAgent(country) {
  const proxy = PROXIES[country];
  if (!proxy) throw new Error(`Missing proxy for ${country}`);
  return new HttpsProxyAgent(proxy);
}

async function fetchWithProxy(url, agent, country, timeout = 15000) {
  const res = await axios.get(url, {
    httpsAgent: agent,
    timeout,
    headers: {
      "User-Agent": USER_AGENTS[country],
      Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    },
  });
  return res.data;
}

/* ================= SITEMAP ================= */
async function fetchIndexSitemaps(domain, agent, country) {
  try {
    const xml = await fetchWithProxy(`${domain}/sitemap.xml`, agent, country);
    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });

    const items = parsed?.sitemapindex?.sitemap;
    if (!items) return [];
    return (Array.isArray(items) ? items : [items]).map((i) => i.loc);
  } catch {
    return [];
  }
}

async function fetchUrlsFromSitemap(sitemapUrl, agent, country) {
  try {
    const xml = await fetchWithProxy(sitemapUrl, agent, country);
    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });

    const urls = parsed?.urlset?.url;
    if (!urls) return [];
    return (Array.isArray(urls) ? urls : [urls]).map((u) => u.loc);
  } catch {
    return [];
  }
}

/* ================= CLOUDFLARE ================= */
async function purgeCloudflareCache(url) {
  if (!CLOUDFLARE_ZONE_ID || !CLOUDFLARE_API_TOKEN) return;

  await axios.post(
    `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`,
    { files: [url] },
    {
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  console.log(`🧹 CF purge triggered: ${url}`);
}

/* ================= WARMER (EDGE + ORIGIN) ================= */
async function warmUrls(urls, agent, country, logger) {
  const BATCH_SIZE = 3;
  const DELAY = 7000;

  const batches = Array.from(
    { length: Math.ceil(urls.length / BATCH_SIZE) },
    (_, i) => urls.slice(i * BATCH_SIZE, i * BATCH_SIZE + BATCH_SIZE)
  );

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (url) => {
        const t0 = Date.now();
        try {
          const res = await axios.get(url, {
            httpsAgent: agent,
            timeout: 30000,
            headers: { "User-Agent": USER_AGENTS[country] },
          });

          const dt = Date.now() - t0;

          /* ===== EDGE (Cloudflare) ===== */
          const cfCache = res.headers["cf-cache-status"] || "N/A";
          const cfRay = res.headers["cf-ray"] || "N/A";
          const edge = extractCfEdge(cfRay);

          /* ===== ORIGIN (LiteSpeed) ===== */
          const lsCache = res.headers["x-litespeed-cache"] || "N/A";

          console.log(
            `[${edge}] ${res.status} cf=${cfCache} ls=${lsCache} - ${url}`
          );

          logger.log({
            country: edge,
            url,
            status: res.status,
            cfCache,
            lsCache,
            cfRay,
            responseMs: dt,
            error: 0,
          });

          /* ===== EDGE DECISION ===== */
          if (cfCache !== "HIT") {
            await purgeCloudflareCache(url);
          }

          /* ===== ORIGIN DECISION (SOFT) ===== */
          if (String(lsCache).toLowerCase() !== "hit") {
            await sleep(3000);
          }
        } catch (e) {
          console.warn(`[${country}] ❌ Failed ${url}`);
          logger.log({
            country,
            url,
            error: 1,
            message: e?.message || "request failed",
          });
        }
      })
    );

    await sleep(DELAY);
  }
}

/* ================= MAIN ================= */
(async () => {
  console.log(`[CacheWarmer-TW] Started ${new Date().toISOString()}`);
  const logger = new AppsScriptLogger();

  try {
    for (const [country, domain] of Object.entries(DOMAINS_MAP)) {
      const agent = createAsiaAgent(country);

      const sitemaps = await fetchIndexSitemaps(domain, agent, country);
      const urls = (
        await Promise.all(
          sitemaps.map((s) => fetchUrlsFromSitemap(s, agent, country))
        )
      ).flat();

      console.log(`[${country}] Found ${urls.length} URLs`);
      await warmUrls(urls, agent, country, logger);
    }
  } finally {
    await logger.flush();
    console.log(`[CacheWarmer-TW] Finished`);
  }
})();
