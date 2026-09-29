// ITFLIXHD — Addon Stremio v2 (Node 18+, sem dependências)
// Fontes: pastas públicas do Koofr (canais M3U, filmes, séries, animes) + metadados do TMDB
const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 7000;
const TMDB_KEY = process.env.TMDB_KEY || "";
const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";
const KOOFR = "https://app.koofr.net";
const PAGE = 30;

// IDs dos links públicos do Koofr (podem ser trocados por variáveis de ambiente)
const SRC = {
  canais: process.env.KOOFR_CANAIS || "75457de5-6f3e-468f-b4b0-04ed69795441",
  filmes: process.env.KOOFR_FILMES || "4640c985-cda4-4f31-bfb0-06bd1422a662",
  series: process.env.KOOFR_SERIES || "d19bca50-e164-4eaf-a66a-dd6045f95843",
  animes: process.env.KOOFR_ANIMES || "f7fe37b7-edb4-49e1-904a-9a466a158856"
};

// ---------- utilitários ----------
const cache = new Map();
async function cached(url, ttl, parse, ms = 20000) {
  const c = cache.get(url);
  if (c && c.exp > Date.now()) return c.data;
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const data = await parse(r);
  if (cache.size > 1500) cache.clear();
  cache.set(url, { data, exp: Date.now() + ttl });
  return data;
}
const getJSON = (u, ttl = 600000) => cached(u, ttl, (r) => r.json());
const getText = (u, ttl = 600000) => cached(u, ttl, (r) => r.text(), 40000);

async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        res[k] = await fn(items[k], k);
      }
    })
  );
  return res;
}

const lim = {};
function limited(key, fn, max = 8) {
  const st = lim[key] || (lim[key] = { active: 0, q: [] });
  return new Promise((resolve, reject) => {
    const run = () => {
      st.active++;
      fn().then(resolve, reject).finally(() => {
        st.active--;
        if (st.q.length) st.q.shift()();
      });
    };
    st.active < max ? run() : st.q.push(run);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const race = (p, fallback, ms = 28000) => Promise.race([p, sleep(ms).then(() => fallback)]);

const h = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
const norm = (s) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const year = (s) => (s || "").slice(0, 4);

function tmdb(path, q = {}, ttl = 6 * 3600e3) {
  const u = new URL(TMDB + path);
  u.searchParams.set("api_key", TMDB_KEY);
  u.searchParams.set("language", "pt-BR");
  for (const k in q) u.searchParams.set(k, q[k]);
  return getJSON(u.toString(), ttl);
}
const kindOf = (type) => (type === "movie" ? "movie" : "tv");

// ---------- Koofr ----------
const prog = {};
async function koofrList(id, path) {
  const enc = encodeURIComponent(path);
  const base = `${KOOFR}/api/v2/public/links/${id}`;
  return limited(id, async () => {
    let lastErr;
    for (let a = 0; a < 2; a++) {
      for (const u of [`${base}/bundle?path=${enc}`, `${base}/files/list?path=${enc}`]) {
        try {
          const d = await getJSON(u, 10 * 60e3);
          prog[id] = (prog[id] || 0) + 1;
          return d.files || d.items || [];
        } catch (e) {
          lastErr = e;
        }
      }
    }
    throw lastErr;
  });
}

async function walk(id, path = "/", segs = [], depth = 0) {
  const items = await koofrList(id, path);
  const prefix = path === "/" ? "" : path;
  const out = [];
  const dirs = [];
  for (const it of items) {
    if (it.type === "dir") dirs.push(it);
    else out.push({ name: it.name, path: prefix + "/" + it.name, segs, linkId: id, label: segs.join(" / ") });
  }
  if (depth < 6) {
    const subs = await pool(dirs, 20, (d) =>
      walk(id, prefix + "/" + d.name, [...segs, d.name], depth + 1).catch(() => [])
    );
    subs.forEach((s) => out.push(...s));
  }
  return out;
}

const koofrContent = (f) =>
  `${KOOFR}/content/links/${f.linkId}/files/get/${encodeURIComponent(f.name)}?path=${encodeURIComponent(f.path)}`;

// Lê texto de um arquivo do Koofr tentando várias formas de URL (o Koofr às vezes responde 400 numa delas)
const strmCache = new Map();
async function koofrText(f) {
  const key = f.linkId + "|" + f.path;
  const c = strmCache.get(key);
  if (c && c.exp > Date.now()) return c.text;
  const b = `${KOOFR}/content/links/${f.linkId}/files/get`;
  const pe = encodeURIComponent(f.path);
  const ne = encodeURIComponent(f.name);
  const ca = `${KOOFR}/content/api/v2/public/links/${f.linkId}/files`;
  const urls = [
    `${b}/${ne}?path=${pe}&force`,
    `${b}/${ne}?path=${pe}`,
    `${b}?path=${pe}`,
    `${ca}/get?path=${pe}`
  ];
  const tried = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, {
        signal: AbortSignal.timeout(40000),
        headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36", Accept: "*/*", Referer: `${KOOFR}/links/${f.linkId}`, Origin: KOOFR },
        redirect: "follow"
      });
      if (r.ok) {
        const text = await r.text();
        strmCache.set(key, { text, exp: Date.now() + 10 * 60e3 });
        if (strmCache.size > 3000) strmCache.clear();
        return text;
      }
      let body = "";
      try {
        body = (await r.text()).replace(/\s+/g, " ").slice(0, 120);
      } catch {}
      tried.push(r.status + " [" + body + "] <- " + u.replace(KOOFR, ""));
    } catch (e) {
      tried.push("erro " + e.message + " <- " + u.replace(KOOFR, ""));
    }
  }
  throw new Error("Koofr recusou todas as variantes: " + tried.join(" | "));
}

function b32hex(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.toUpperCase()) {
    const v = A.indexOf(c);
    if (v < 0) return null;
    bits += v.toString(2).padStart(5, "0");
  }
  let hex = "";
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.slice(0, 40);
}

// Lê o conteúdo de um .strm: link http(s) direto, ou magnet (também dentro de plugin://...uri=magnet...)
function fromText(text) {
  const line = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith("#")) || "";
  if (/^https?:\/\//i.test(line)) return { url: line };
  let dec = line;
  try {
    dec = decodeURIComponent(line);
  } catch {}
  const m = dec.match(/magnet:\?[^\s]*?xt=urn:btih:([a-zA-Z0-9]{32,40})/i);
  if (m) {
    let ih = m[1];
    if (ih.length === 32) ih = b32hex(ih);
    if (!ih) return null;
    const trackers = [...dec.matchAll(/[?&]tr=([^&\s]+)/g)].map((x) => {
      try {
        return decodeURIComponent(x[1]);
      } catch {
        return x[1];
      }
    });
    return { infoHash: ih.toLowerCase(), trackers };
  }
  const bare = dec.match(/(?:^|[^a-zA-Z0-9])([a-fA-F0-9]{40})(?:[^a-zA-Z0-9]|$)/);
  if (bare) return { infoHash: bare[1].toLowerCase(), trackers: [] };
  return null;
}

const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.tracker.cl:1337/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://open.stealth.si:80/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.moeking.me:6969/announce"
];

async function playable(f) {
  if (!/\.strm$/i.test(f.name)) return { url: koofrContent(f) };
  return fromText(await koofrText(f));
}

// ---------- leitura de nomes ----------
const MEDIA = /\.(strm|mp4|mkv|avi|mov|m4v|ts|m3u8)$/i;
const EXT = /\.(strm|mp4|mkv|avi|mov|m4v|ts|m3u8?|txt)$/i;
const SEASON_DIR = /^(season|temporada|temp|s)\s*\.?\s*\d+$/i;

function parseName(raw) {
  let n = raw.replace(EXT, "");
  const idm = n.match(/tmdb[-_=: ]?(\d+)/i);
  n = n.replace(/\[[^\]]*\]|\{[^}]*\}/g, " ");
  const ym = n.match(/\((\d{4})\)/) || n.match(/[ ._-]((?:19|20)\d{2})\s*$/);
  let title = ym ? n.slice(0, ym.index) : n;
  title = title.replace(/[._]+/g, " ").replace(/\s+/g, " ").replace(/[-\s]+$/, "").trim();
  return { title, year: ym ? +ym[1] : null, tmdbId: idm ? idm[1] : null };
}

function epInfo(name) {
  const m = name.match(/[sS](\d{1,2})[ ._-]*[eE](\d{1,3})/) || name.match(/\b(\d{1,2})x(\d{2,3})\b/);
  return m ? { s: +m[1], e: +m[2], idx: m.index } : null;
}

function parseM3U(text, fallbackGroup) {
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const attr = (k) => {
        const m = line.match(new RegExp(k + '="([^"]*)"', "i"));
        return m ? m[1] : "";
      };
      const name = line.slice(line.lastIndexOf(",") + 1).trim();
      cur = { name: name || attr("tvg-name"), logo: attr("tvg-logo"), group: attr("group-title") || fallbackGroup || "Canais" };
    } else if (!line.startsWith("#") && cur) {
      cur.url = line;
      cur.hash = h("tv|" + cur.name + "|" + cur.url);
      out.push(cur);
      cur = null;
    }
  }
  return out;
}

// ---------- índices (montados a partir do Koofr) ----------
const hashMap = new Map();
const byTitle = (a, b) => a.title.localeCompare(b.title, "pt");

const BUILD = {
  async filmes() {
    const files = await walk(SRC.filmes);
    const groups = new Map();
    for (const f of files) {
      if (!MEDIA.test(f.name)) continue;
      const p = parseName(f.name);
      if (!p.title) continue;
      const k = norm(p.title) + "|" + (p.year || "");
      let g = groups.get(k);
      if (!g) {
        g = { title: p.title, year: p.year, tmdbId: p.tmdbId, files: [], hash: h("m|" + k) };
        groups.set(k, g);
        hashMap.set(g.hash, { kind: "movie", g });
      }
      g.files.push(f);
    }
    return { list: [...groups.values()].sort(byTitle) };
  },
  series: () => buildShows(SRC.series),
  animes: () => buildShows(SRC.animes),
  async canais() {
    const files = await walk(SRC.canais);
    const chans = [];
    await pool(files, 4, async (f) => {
      const ext = (f.name.match(/\.([^.]+)$/) || [])[1];
      if (!["m3u", "m3u8", "txt", "strm"].includes((ext || "").toLowerCase())) return;
      try {
        let text = await koofrText(f);
        const single = () => {
          const u = text.split(/\r?\n/).map((s) => s.trim()).find((s) => /^https?:\/\//i.test(s));
          return u ? [{ name: f.name.replace(EXT, ""), url: u, group: f.label || "Canais", logo: "", hash: h("tv|" + f.name + "|" + u) }] : [];
        };
        if (!/#EXTINF/i.test(text)) {
          const u = text.split(/\r?\n/).map((s) => s.trim()).find((s) => /^https?:\/\//i.test(s));
          if (!u) return;
          try {
            text = await getText(u);
          } catch {
            chans.push(...single());
            return;
          }
          if (!/#EXTINF/i.test(text) || /#EXT-X-/.test(text)) {
            text = u;
            chans.push({ name: f.name.replace(EXT, ""), url: u, group: f.label || "Canais", logo: "", hash: h("tv|" + f.name + "|" + u) });
            return;
          }
        }
        chans.push(...parseM3U(text, f.label));
      } catch (e) {
        console.error("canais erro", f.name, e.message);
      }
    });
    const seen = new Set();
    const list = chans.filter((c) => !seen.has(c.hash) && seen.add(c.hash));
    list.forEach((c) => hashMap.set(c.hash, { kind: "tv", c }));
    const groups = [...new Set(list.map((c) => c.group))].sort();
    return { list, groups };
  }
};

async function buildShows(linkId) {
  const files = await walk(linkId);
  const shows = new Map();
  for (const f of files) {
    if (!MEDIA.test(f.name)) continue;
    const ep = epInfo(f.name);
    if (!ep) continue;
    const prefix = f.name.slice(0, ep.idx).replace(/[._-]+/g, " ").trim();
    const folders = f.segs.filter((sg) => !SEASON_DIR.test(sg));
    const src = prefix.length >= 2 ? prefix : folders[folders.length - 1] || "";
    const p = parseName(src);
    if (!p.title) continue;
    const idm = f.segs.join("/").match(/tmdb[-_=: ]?(\d+)/i);
    const k = norm(p.title);
    let g = shows.get(k);
    if (!g) {
      g = { title: p.title, year: p.year, tmdbId: p.tmdbId || (idm && idm[1]) || null, eps: new Map(), hash: h("s|" + k) };
      shows.set(k, g);
      hashMap.set(g.hash, { kind: "show", g });
    }
    const key = `${ep.s}:${ep.e}`;
    if (!g.eps.has(key)) g.eps.set(key, []);
    g.eps.get(key).push(f);
  }
  return { list: [...shows.values()].sort(byTitle) };
}

const IDX = {};
function getIndex(name) {
  const c = IDX[name] || (IDX[name] = {});
  if (c.data && c.exp > Date.now()) return Promise.resolve(c.data);
  if (!c.p) {
    c.t0 = Date.now();
    c.p = BUILD[name]()
      .then((d) => {
        c.data = d;
        c.ms = Date.now() - c.t0;
        c.exp = Date.now() + 12 * 60e3;
        c.err = null;
        return d;
      })
      .catch((e) => {
        c.err = String(e.message || e);
        throw e;
      })
      .finally(() => {
        c.p = null;
      });
  }
  return c.data ? Promise.resolve(c.data) : c.p;
}

const soon = (p, ms = 25000) => race(p.catch(() => ({ list: [] })), { list: [] }, ms);

// ---------- TMDB ----------
const resolved = new Map();
async function findTmdb(kind, g) {
  if (resolved.has(g.hash)) return resolved.get(g.hash);
  let r = null;
  try {
    if (g.tmdbId) r = await tmdb(`/${kind}/${g.tmdbId}`);
    else {
      const yk = kind === "movie" ? "year" : "first_air_date_year";
      let d = await tmdb(`/search/${kind}`, g.year ? { query: g.title, [yk]: g.year } : { query: g.title });
      if (!d.results.length && g.year) d = await tmdb(`/search/${kind}`, { query: g.title });
      r = d.results[0] || null;
    }
  } catch {}
  if (r) resolved.set(g.hash, r);
  return r;
}

async function resolve(type, id) {
  if (id.startsWith("tmdb:")) return id.split(":")[1];
  const f = await tmdb(`/find/${id}`, { external_source: "imdb_id" });
  const r = (type === "movie" ? f.movie_results : f.tv_results)[0];
  return r ? String(r.id) : null;
}

const posterOf = (x) => (x.poster_path ? IMG + "/w500" + x.poster_path : undefined);
const brief = (type, id, x) => ({
  id,
  type,
  name: x.title || x.name,
  poster: posterOf(x),
  background: x.backdrop_path ? IMG + "/w1280" + x.backdrop_path : undefined,
  description: x.overview,
  releaseInfo: year(x.release_date || x.first_air_date)
});
const chanMeta = (c) => ({
  id: "itflix:tv:" + c.hash,
  type: "tv",
  name: c.name,
  poster: c.logo || undefined,
  logo: c.logo || undefined,
  posterShape: "square",
  genres: [c.group]
});

// ---------- catálogo ----------
async function catalog(type, catId, extra) {
  const key = catId.replace("koofr-", "");
  if (!BUILD[key]) return { metas: [] };
  const skip = parseInt(extra.skip) || 0;
  const idx = await soon(getIndex(key));
  const q = extra.search ? norm(extra.search) : "";

  if (key === "canais") {
    let l = idx.list;
    if (extra.genre) l = l.filter((c) => c.group === extra.genre);
    if (q) l = l.filter((c) => norm(c.name).includes(q));
    return { metas: l.slice(skip, skip + 100).map(chanMeta) };
  }

  const list = q ? idx.list.filter((g) => norm(g.title).includes(q)) : idx.list;
  const kind = key === "filmes" ? "movie" : "tv";
  const metas = await pool(list.slice(skip, skip + PAGE), 10, async (g) => {
    const r = await findTmdb(kind, g);
    if (r) {
      g.tmdbId = String(r.id);
      return brief(type, "tmdb:" + r.id, r);
    }
    return { id: "kf:" + g.hash, type, name: g.title, releaseInfo: g.year ? String(g.year) : undefined };
  });
  const seen = new Set();
  return { metas: metas.filter((m) => !seen.has(m.id) && seen.add(m.id)) };
}

// ---------- meta ----------
async function meta(type, id) {
  if (id.startsWith("itflix:tv:")) {
    const e = hashMap.get(id.split(":")[2]);
    return { meta: e ? chanMeta(e.c) : null };
  }
  if (id.startsWith("kf:")) {
    const e = hashMap.get(id.split(":")[1]);
    if (!e) return { meta: null };
    const m = { id, type, name: e.g.title, releaseInfo: e.g.year ? String(e.g.year) : undefined };
    if (e.kind === "show") {
      m.videos = [...e.g.eps.keys()]
        .map((k) => k.split(":").map(Number))
        .sort((a, b) => a[0] - b[0] || a[1] - b[1])
        .map(([s, ep]) => ({ id: `${id}:${s}:${ep}`, title: `Episódio ${ep}`, season: s, episode: ep, released: new Date(0).toISOString() }));
    }
    return { meta: m };
  }

  const tid = await resolve(type, id);
  if (!tid) return { meta: null };
  const kind = kindOf(type);
  const d = await tmdb(`/${kind}/${tid}`, { append_to_response: "credits,external_ids" });
  const m = {
    ...brief(type, id, d),
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
            released: ep.air_date ? new Date(ep.air_date).toISOString() : new Date(0).toISOString(),
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
async function unrestrict(link, key) {
  try {
    const r = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ link })
    });
    if (!r.ok) return null;
    return (await r.json()).download || null;
  } catch {
    return null;
  }
}

async function matchFiles(type, p) {
  const isTmdb = p[0] === "tmdb";
  const tid = await resolve(type, isTmdb ? "tmdb:" + p[1] : p[0]);
  if (!tid) return [];
  const gid = (g) => g.tmdbId || (resolved.get(g.hash) || {}).id;
  const same = (g) => gid(g) && String(gid(g)) === String(tid);
  if (type === "movie") {
    const [d, idx] = await Promise.all([tmdb(`/movie/${tid}`), soon(getIndex("filmes"))]);
    const names = new Set([norm(d.title), norm(d.original_title)]);
    const y = +year(d.release_date);
    const okYear = (g) => !g.year || !y || Math.abs(g.year - y) <= 1;
    let found = idx.list.filter((g) => same(g) || (names.has(norm(g.title)) && okYear(g)));
    if (!found.length) {
      // fallback: título do arquivo contido no título do TMDB (ou vice-versa)
      const arr = [...names].filter((n) => n.length > 3);
      found = idx.list.filter(
        (g) => okYear(g) && norm(g.title).length > 3 && arr.some((n) => n.includes(norm(g.title)) || norm(g.title).includes(n))
      );
    }
    return found.flatMap((g) => g.files);
  }
  const s = p[isTmdb ? 2 : 1];
  const e = p[isTmdb ? 3 : 2];
  const d = await tmdb(`/tv/${tid}`);
  const names = new Set([norm(d.name), norm(d.original_name)]);
  const idxs = await Promise.all([soon(getIndex("series")), soon(getIndex("animes"))]);
  return idxs
    .flatMap((ix) => ix.list)
    .filter((g) => same(g) || names.has(norm(g.title)))
    .flatMap((g) => g.eps.get(`${s}:${e}`) || []);
}

async function streams(type, rawId, rdKey) {
  const p = rawId.split(":");
  if (p[0] === "itflix" && p[1] === "tv") {
    const e = hashMap.get(p[2]);
    return { streams: e ? [{ name: "ITFLIXHD", title: e.c.group, url: e.c.url }] : [] };
  }
  let files = [];
  if (p[0] === "kf") {
    const e = hashMap.get(p[1]);
    if (e) files = e.kind === "movie" ? e.g.files : e.g.eps.get(`${p[2]}:${p[3]}`) || [];
  } else {
    files = await matchFiles(type, p);
  }
  const out = [];
  await pool(files, 5, async (f) => {
    try {
      const t = await playable(f);
      if (!t) return;
      const title = (f.label ? f.label + "\n" : "") + f.name;
      if (t.infoHash) {
        out.push({
          name: "ITFLIXHD\nTorrent",
          title,
          infoHash: t.infoHash,
          sources: ["dht:" + t.infoHash, ...[...new Set([...t.trackers, ...TRACKERS])].map((x) => "tracker:" + x)]
        });
        return;
      }
      let url = t.url;
      if (/real-debrid\.com\/d\//.test(url) && rdKey) url = (await unrestrict(url, rdKey)) || url;
      out.push({ name: "ITFLIXHD", title, url });
    } catch (e) {
      console.error("stream erro", f.name, e.message);
    }
  });
  console.log("streams", type, rawId, "arquivos:", files.length, "streams:", out.length);
  return { streams: out };
}

// ---------- manifest ----------
function buildManifest() {
  const groups = (IDX.canais && IDX.canais.data && IDX.canais.data.groups) || [];
  const std = [{ name: "search" }, { name: "skip" }];
  const tvExtra = groups.length ? [{ name: "genre", options: groups.slice(0, 80) }, ...std] : std;
  return {
    id: "com.itflixhd.addon",
    version: "2.0.0",
    name: "ITFLIXHD",
    description: "ITFLIXHD — canais, filmes, séries e animes em português (Koofr + TMDB)",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series", "tv"],
    idPrefixes: ["tmdb:", "tt", "kf:", "itflix:"],
    catalogs: [
      { type: "movie", id: "koofr-filmes", name: "ITFLIXHD Filmes", extra: std },
      { type: "series", id: "koofr-series", name: "ITFLIXHD Séries", extra: std },
      { type: "series", id: "koofr-animes", name: "ITFLIXHD Animes", extra: std },
      { type: "tv", id: "koofr-canais", name: "ITFLIXHD Canais", extra: tvExtra }
    ],
    behaviorHints: { configurable: false }
  };
}

// ---------- servidor ----------
function parseExtra(seg) {
  const extra = {};
  if (!seg) return extra;
  for (const part of seg.split("&")) {
    const i = part.indexOf("=");
    if (i > 0) extra[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
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
<p style="margin-top:24px"><a href="/status" style="color:#aaa">Ver status das pastas</a></p>
<script>
const h=${JSON.stringify(host)},k=document.getElementById('k'),b=document.getElementById('b'),u=document.getElementById('u');
function up(){const p=(k.value.trim()?'/'+encodeURIComponent(k.value.trim()):'')+'/manifest.json';b.href='stremio://'+h+p;u.value='https://'+h+p}
k.oninput=up;up();
document.getElementById('c').onclick=()=>{u.select();navigator.clipboard&&navigator.clipboard.writeText(u.value)};
</script>`;

const server = http.createServer(async (req, res) => {
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

    let rdKey = "";
    if (!["manifest.json", "catalog", "meta", "stream", "status", "debug", "why"].includes(seg[0])) rdKey = seg.shift();

    const last = seg.length - 1;
    if (seg[last]) seg[last] = seg[last].replace(/\.json$/, "");

    if (seg[0] === "manifest") return send(200, buildManifest());
    if (seg[0] === "catalog") return send(200, await race(catalog(seg[1], seg[2], parseExtra(seg[3])), { metas: [] }));
    if (seg[0] === "meta") return send(200, await meta(seg[1], seg[2]));
    if (seg[0] === "stream") return send(200, await race(streams(seg[1], seg[2], rdKey), { streams: [] }));
    if (seg[0] === "status") {
      const r = {};
      for (const k of Object.keys(BUILD)) {
        getIndex(k).catch(() => {});
        const c = IDX[k] || {};
        r[k] = {
          itens: c.data ? c.data.list.length : 0,
          pronto: !!c.data,
          montando: !!c.p,
          segundos: c.ms ? Math.round(c.ms / 1000) : null,
          erro: c.err || null
        };
      }
      r.pastas_lidas = prog;
      return send(200, r);
    }
    if (seg[0] === "why") {
      const q = norm(seg.slice(1).join(" "));
      const idxs = ["filmes", "series", "animes"].map((k) => IDX[k] && IDX[k].data).filter(Boolean);
      if (!idxs.length) return send(200, { erro: "os índices ainda estão sendo montados, veja /status" });
      const groups = idxs.flatMap((ix) => ix.list).filter((g) => norm(g.title).includes(q)).slice(0, 5);
      const out = [];
      for (const g of groups) {
        const files = g.files || [...g.eps.values()].flat().slice(0, 3);
        for (const f of files.slice(0, 4)) {
          const isStrm = /\.strm$/i.test(f.name);
          let conteudo = "(arquivo de vídeo)";
          let ok = true;
          if (isStrm) {
            try {
              conteudo = (await koofrText(f)).slice(0, 300);
              ok = !!fromText(conteudo);
            } catch (e) {
              conteudo = "erro: " + e.message;
              ok = false;
            }
          }
          out.push({ titulo: g.title, arquivo: (f.label ? f.label + "/" : "") + f.name, conteudo, toca_no_stremio: ok });
        }
      }
      return send(200, out.length ? out : { erro: "nenhum item com esse nome nas pastas: " + q });
    }
    if (seg[0] === "debug" && SRC[seg[1]]) {
      const items = await koofrList(SRC[seg[1]], "/" + seg.slice(2).join("/"));
      return send(200, items.slice(0, 15));
    }
    send(404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(500, { error: String(e.message || e) });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log("ITFLIXHD addon na porta " + PORT));
  const warm = async () => {
    for (const k of ["filmes", "series", "animes", "canais"]) await getIndex(k).catch((e) => console.error(k, e.message));
  };
  warm();
  setInterval(warm, 14 * 60e3);
}

module.exports = { fromText, parseName, epInfo, parseM3U, catalog, meta, streams, buildManifest, getIndex, SRC };
