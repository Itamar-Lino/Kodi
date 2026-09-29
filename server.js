// ITFLIXHD — Addon Stremio (Node 18+, sem dependências, roteamento manual)
const http = require("http");

const PORT = process.env.PORT || 7000;
const TMDB_KEY = process.env.TMDB_KEY || "";      // chave da API do TMDB
const LINKS_URL = process.env.LINKS_URL || "";    // JSON com os links (ex.: raw do GitHub)
const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";

const manifest = {
  id: "com.itflixhd.addon",
  version: "1.0.0",
  name: "ITFLIXHD",
  description: "ITFLIXHD — filmes e séries em português com metadados do TMDB",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["tmdb:", "tt"],
  catalogs: [
    { type: "movie", id: "itflixhd-filmes", name: "ITFLIXHD Filmes", extra: [{ name: "search" }, { name: "skip" }] },
    { type: "series", id: "itflixhd-series", name: "ITFLIXHD Séries", extra: [{ name: "search" }, { name: "skip" }] }
  ],
  behaviorHints: { configurable: false }
};

// ---------- utilitários ----------
const cache = new Map();
async function getJSON(url, ttl = 10 * 60 * 1000) {
  const c = cache.get(url);
  if (c && c.exp > Date.now()) return c.data;
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  const data = await r.json();
  cache.set(url, { data, exp: Date.now() + ttl });
  return data;
}

function tmdb(path, q = {}) {
  const u = new URL(TMDB + path);
  u.searchParams.set("api_key", TMDB_KEY);
  u.searchParams.set("language", "pt-BR");
  for (const k in q) u.searchParams.set(k, q[k]);
  return getJSON(u.toString());
}

const kindOf = (type) => (type === "movie" ? "movie" : "tv");
const year = (s) => (s || "").slice(0, 4);

async function resolve(type, id) {
  if (id.startsWith("tmdb:")) return id.split(":")[1];
  const f = await tmdb(`/find/${id}`, { external_source: "imdb_id" });
  const r = (type === "movie" ? f.movie_results : f.tv_results)[0];
  return r ? String(r.id) : null;
}

// ---------- catálogo ----------
async function catalog(type, extra) {
  const kind = kindOf(type);
  const page = Math.floor((parseInt(extra.skip) || 0) / 20) + 1;
  const data = extra.search
    ? await tmdb(`/search/${kind}`, { query: extra.search, page })
    : await tmdb(`/${kind}/popular`, { page });
  return {
    metas: data.results.map((x) => ({
      id: "tmdb:" + x.id,
      type,
      name: x.title || x.name,
      poster: x.poster_path ? IMG + "/w500" + x.poster_path : undefined,
      background: x.backdrop_path ? IMG + "/w1280" + x.backdrop_path : undefined,
      description: x.overview,
      releaseInfo: year(x.release_date || x.first_air_date)
    }))
  };
}

// ---------- meta ----------
async function meta(type, id) {
  const tid = await resolve(type, id);
  if (!tid) return { meta: null };
  const kind = kindOf(type);
  const d = await tmdb(`/${kind}/${tid}`, { append_to_response: "credits,external_ids" });
  const m = {
    id,
    type,
    name: d.title || d.name,
    poster: d.poster_path ? IMG + "/w500" + d.poster_path : undefined,
    background: d.backdrop_path ? IMG + "/w1280" + d.backdrop_path : undefined,
    description: d.overview,
    releaseInfo: year(d.release_date || d.first_air_date),
    genres: (d.genres || []).map((g) => g.name),
    runtime: d.runtime ? d.runtime + " min" : undefined,
    imdbRating: d.vote_average ? d.vote_average.toFixed(1) : undefined,
    cast: ((d.credits && d.credits.cast) || []).slice(0, 8).map((c) => c.name)
  };
  if (type === "series") {
    const nums = (d.seasons || []).map((s) => s.season_number).filter((n) => n > 0);
    const videos = [];
    for (let i = 0; i < nums.length; i += 20) {
      const chunk = nums.slice(i, i + 20);
      const s = await tmdb(`/tv/${tid}`, { append_to_response: chunk.map((n) => "season/" + n).join(",") });
      for (const n of chunk) {
        const season = s["season/" + n];
        if (!season) continue;
        for (const ep of season.episodes || []) {
          videos.push({
            id: `${id}:${n}:${ep.episode_number}`,
            title: ep.name || `Episódio ${ep.episode_number}`,
            season: n,
            episode: ep.episode_number,
            released: ep.air_date ? new Date(ep.air_date).toISOString() : undefined,
            thumbnail: ep.still_path ? IMG + "/w300" + ep.still_path : undefined,
            overview: ep.overview
          });
        }
      }
    }
    m.videos = videos;
  }
  return { meta: m };
}

// ---------- streams ----------
async function loadLinks() {
  if (!LINKS_URL) return {};
  try { return await getJSON(LINKS_URL, 5 * 60 * 1000); } catch { return {}; }
}

async function unrestrict(link, key) {
  try {
    const r = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ link })
    });
    if (!r.ok) return null;
    return (await r.json()).download || null;
  } catch { return null; }
}

async function streams(type, rawId, rdKey) {
  const p = rawId.split(":");
  const isTmdb = p[0] === "tmdb";
  const base = isTmdb ? "tmdb:" + p[1] : p[0];
  const rest = isTmdb ? p.slice(2) : p.slice(1);
  const suffix = type === "series" ? ":" + rest.join(":") : "";

  const keys = [base + suffix];
  try {
    if (isTmdb) {
      const ex = await tmdb(`/${kindOf(type)}/${p[1]}/external_ids`);
      if (ex.imdb_id) keys.push(ex.imdb_id + suffix);
    } else {
      const tid = await resolve(type, base);
      if (tid) keys.push("tmdb:" + tid + suffix);
    }
  } catch {}

  const links = await loadLinks();
  const found = keys.map((k) => links[k]).find(Boolean);
  if (!found) return { streams: [] };

  const list = (Array.isArray(found) ? found : [found]).map((x) => (typeof x === "string" ? { url: x } : x));
  const out = [];
  for (const item of list) {
    let url = item.url;
    if (/real-debrid\.com\/d\//.test(url) && rdKey) {
      const dl = await unrestrict(url, rdKey);
      if (dl) url = dl;
    }
    out.push({ name: "ITFLIXHD", title: item.name || "Assistir", url });
  }
  return { streams: out };
}

// ---------- servidor ----------
function parseExtra(seg) {
  const extra = {};
  if (!seg) return extra;
  for (const part of seg.split("&")) {
    const i = part.indexOf("=");
    if (i > 0) extra[part.slice(0, i)] = part.slice(i + 1);
  }
  return extra;
}

const page = (host) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ITFLIXHD</title>
<body style="font-family:sans-serif;background:#0b0b10;color:#fff;text-align:center;padding:24px">
<h1 style="color:#e50914">ITFLIXHD</h1>
<p>Addon Stremio</p>
<input id="k" placeholder="Chave Real-Debrid (opcional)" style="width:90%;max-width:360px;padding:12px;border-radius:8px;border:0"><br><br>
<a id="b" style="display:inline-block;background:#e50914;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none">Instalar no Stremio</a>
<p style="margin-top:24px;font-size:14px;opacity:.8">Ou copie o link e cole no Stremio (Addons → campo de busca):</p>
<input id="u" readonly style="width:90%;max-width:360px;padding:12px;border-radius:8px;border:0"><br><br>
<button id="c" style="padding:12px 20px;border-radius:8px;border:0">Copiar link</button>
<script>
const h=${JSON.stringify(host)},k=document.getElementById('k'),b=document.getElementById('b'),u=document.getElementById('u');
function up(){const p=(k.value.trim()?'/'+encodeURIComponent(k.value.trim()):'')+'/manifest.json';b.href='stremio://'+h+p;u.value='https://'+h+p}
k.oninput=up;up();
document.getElementById('c').onclick=()=>{u.select();navigator.clipboard&&navigator.clipboard.writeText(u.value)};
</script>`;

http.createServer(async (req, res) => {
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, {
      "Content-Type": type + "; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*"
    });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  if (req.method === "OPTIONS") return send(204, "");

  try {
    const { pathname } = new URL(req.url, "http://x");
    const seg = pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
    if (!seg.length) return send(200, page(req.headers.host), "text/html");

    // chave do Real-Debrid opcional como primeiro segmento
    let rdKey = "";
    if (!["manifest.json", "catalog", "meta", "stream"].includes(seg[0])) rdKey = seg.shift();

    const last = seg.length - 1;
    if (seg[last]) seg[last] = seg[last].replace(/\.json$/, "");

    if (seg[0] === "manifest") return send(200, manifest);
    if (seg[0] === "catalog") return send(200, await catalog(seg[1], parseExtra(seg[3])));
    if (seg[0] === "meta") return send(200, await meta(seg[1], seg[2]));
    if (seg[0] === "stream") return send(200, await streams(seg[1], seg[2], rdKey));
    send(404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(500, { error: String(e.message || e) });
  }
}).listen(PORT, () => console.log("ITFLIXHD addon na porta " + PORT));
