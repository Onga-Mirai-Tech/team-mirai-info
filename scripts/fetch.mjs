// scripts/fetch.mjs
// GitHub Actions 上で各情報源を取得し、data/items.json に書き出す。
// 外部パッケージは使わない（Node 20 以降の組み込み fetch のみ）。
//
//   node scripts/fetch.mjs              … 通常（直近7日分の報道を検索）
//   GN_WINDOW=1y node scripts/fetch.mjs … 初回など、さかのぼって集めたいとき

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const CONFIG_PATH = 'config/sources.json';
const OUTPUT_PATH = 'data/items.json';
const MAX_ITEMS = 5000;
const MIN_DATE = new Date('2025-05-01T00:00:00+09:00'); // 結党前の同名記事などを除外
const GN_WINDOW = process.env.GN_WINDOW || '7d';
const UA = 'Mozilla/5.0 (compatible; TeamMiraiUnofficialWatch/1.0; +https://github.com/Onga-Mirai-Tech)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 取得・解析の小道具 ----------

async function fetchText(url, { retries = 1 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'ja' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i === retries) throw err;
      await sleep(2000);
    }
  }
}

function decode(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}

const stripTags = (s = '') => decode(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : '';
}

function attr(block, name, attrName) {
  const m = block.match(new RegExp(`<${name}\\s[^>]*${attrName}="([^"]*)"`));
  return m ? decode(m[1]) : '';
}

// RSS 2.0 と Atom（YouTube）の両方に対応する最小限のパーサ
function parseFeed(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  return blocks.map((b) => {
    const isAtom = b.startsWith('<entry');
    return {
      title: stripTags(tag(b, 'title')),
      link: isAtom ? attr(b, 'link', 'href') : decode(tag(b, 'link')),
      date: decode(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated')),
      sourceName: stripTags(tag(b, 'source')),
      sourceUrl: attr(b, 'source', 'url'),
      thumb: attr(b, 'media:thumbnail', 'url') || decode(tag(b, 'media:thumbnail')),
      description: stripTags(tag(b, 'description') || tag(b, 'media:description')).slice(0, 120),
    };
  });
}

function toISO(dateStr) {
  const d = new Date(dateStr);
  return isNaN(d) ? null : d.toISOString();
}

// ---------- 議員の自動タグ付け ----------

function makeTagger(members) {
  const table = members.map((m) => ({ id: m.id, words: [m.name, ...(m.aliases || [])] }));
  return (text) => {
    const t = (text || '').replace(/[\s　]/g, '');
    return table.filter((m) => m.words.some((w) => t.includes(w))).map((m) => m.id);
  };
}

function linkKey(link) {
  try {
    const u = new URL(link);
    const yt = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v');
    if (/youtube\.com|youtu\.be/.test(u.hostname) && yt) return `yt:${yt}`;
    return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
  } catch {
    return link;
  }
}

function officialKind(link) {
  if (/note\.com\/team_mirai_log/.test(link)) return 'diet';
  if (/youtube\.com|youtu\.be/.test(link)) return 'video';
  if (/note\.com/.test(link)) return 'note';
  if (/x\.com|twitter\.com/.test(link)) return 'sns';
  return 'news';
}

// ---------- 情報源ごとの収集 ----------

// 1) 党公式サイトのニュース一覧（RSSが無いのでHTMLから取り出す）
async function collectOfficialPage(cfg, tagger) {
  const html = await fetchText(cfg.official.newsPage);
  const re = /<a href="([^"]+)" class="news-all-item"[\s\S]*?<time[^>]*datetime="([^"]+)"[\s\S]*?class="news-all-text"[^>]*>([\s\S]*?)<\/span>/g;
  const items = [];
  for (const m of html.matchAll(re)) {
    const link = new URL(decode(m[1]), cfg.official.newsPage).href;
    const title = stripTags(m[3]);
    items.push({
      title, link,
      date: new Date(`${m[2]}T00:00:00+09:00`).toISOString(),
      dateOnly: true,
      type: 'official',
      kind: officialKind(link),
      source: '党公式サイト',
      members: tagger(title),
    });
  }
  if (items.length === 0) throw new Error('ニュース一覧の構造が変わった可能性があります（0件）');
  return items;
}

// 2) note / YouTube（党公式・議員）
async function collectFeed({ url, type, kind, source, memberId }, tagger) {
  const xml = await fetchText(url);
  return parseFeed(xml).map((it) => ({
    title: it.title,
    link: it.link,
    date: toISO(it.date),
    type,
    kind: kind === 'auto' ? officialKind(it.link) : kind,
    source,
    members: [...new Set([...(memberId ? [memberId] : []), ...tagger(it.title + ' ' + it.description)])],
    thumb: it.thumb || undefined,
    description: it.description || undefined,
  }));
}

// 3) Google ニュース（大手媒体のドメインに一致するものだけ残す）
function gnUrl(q) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${GN_WINDOW}`)}&hl=ja&gl=JP&ceid=JP:ja`;
}

async function collectGoogleNews(q, cfg, tagger, forceMember) {
  const hostToMedia = new Map();
  cfg.media.forEach((m) => m.hosts.forEach((h) => hostToMedia.set(h, m)));
  const xml = await fetchText(gnUrl(q));
  return parseFeed(xml).map((it) => {
    let host = '';
    try { host = new URL(it.sourceUrl).hostname; } catch {}
    const media = hostToMedia.get(host);
    if (!media) return null;
    const title = it.title.replace(new RegExp(`\\s+-\\s+${it.sourceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
    return {
      title, link: it.link, date: toISO(it.date),
      type: 'media', kind: 'article',
      source: media.name, mediaId: media.id,
      members: [...new Set([...(forceMember ? [forceMember] : []), ...tagger(title)])],
    };
  }).filter(Boolean);
}

// ---------- 本体 ----------

async function loadJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch { return fallback; }
}

function buildJobs(cfg) {
  const jobs = [];
  jobs.push({ label: '党公式サイト ニュース一覧', run: (t) => collectOfficialPage(cfg, t) });
  for (const acct of cfg.official.note) {
    jobs.push({
      label: `note @${acct}`,
      run: (t) => collectFeed({ url: `https://note.com/${acct}/rss`, type: 'official', kind: 'auto', source: acct === 'team_mirai_log' ? '党公式 note（国会記録）' : '党公式 note' }, t),
    });
  }
  for (const ch of cfg.official.youtube) {
    jobs.push({
      label: `YouTube 党公式`,
      run: (t) => collectFeed({ url: `https://www.youtube.com/feeds/videos.xml?channel_id=${ch}`, type: 'official', kind: 'video', source: '党公式 YouTube' }, t),
    });
  }
  for (const m of cfg.members) {
    if (m.note) jobs.push({
      label: `note ${m.name}`,
      run: (t) => collectFeed({ url: `https://note.com/${m.note}/rss`, type: 'member', kind: 'note', source: `${m.name} note`, memberId: m.id }, t),
    });
    if (m.youtube) jobs.push({
      label: `YouTube ${m.name}`,
      run: (t) => collectFeed({ url: `https://www.youtube.com/feeds/videos.xml?channel_id=${m.youtube}`, type: 'member', kind: 'video', source: `${m.name} YouTube`, memberId: m.id }, t),
    });
  }
  // 報道：党名で全体検索＋媒体ごとの検索（全体検索だけだと大手以外に埋もれるため）
  const party = cfg.partyAliases.map((a) => `"${a}"`).join(' OR ');
  jobs.push({ label: 'ニュース検索 党名', gn: true, run: (t) => collectGoogleNews(`(${party})`, cfg, t) });
  for (const md of cfg.media) {
    const sites = md.hosts.map((h) => `site:${h}`).join(' OR ');
    jobs.push({ label: `ニュース検索 ${md.name}`, gn: true, run: (t) => collectGoogleNews(`(${party}) (${sites})`, cfg, t) });
  }
  for (const m of cfg.members) {
    jobs.push({ label: `ニュース検索 ${m.name}`, gn: true, run: (t) => collectGoogleNews(`"${m.name}"`, cfg, t, m.id) });
  }
  return jobs;
}

function itemKey(it) {
  if (it.type === 'media') return `media:${it.mediaId}:${it.title.replace(/[\s　]/g, '')}`;
  return linkKey(it.link);
}

// 同じ記事が複数の経路で取れたときに情報をまとめる
function mergeItem(a, b) {
  const out = { ...a };
  if (a.dateOnly && b.date && !b.dateOnly) { out.date = b.date; delete out.dateOnly; }
  out.members = [...new Set([...(a.members || []), ...(b.members || [])])];
  out.thumb = a.thumb || b.thumb;
  out.description = a.description || b.description;
  if (b.type === 'official' && a.type !== 'official') { out.type = 'official'; out.source = b.source; out.kind = b.kind; }
  return out;
}

async function main() {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  const tagger = makeTagger(cfg.members);
  const previous = await loadJSON(OUTPUT_PATH, { items: [] });

  const status = [];
  const fresh = [];
  for (const job of buildJobs(cfg)) {
    try {
      const got = (await job.run(tagger)).filter((it) => it.title && it.link && it.date && new Date(it.date) >= MIN_DATE);
      fresh.push(...got);
      status.push({ label: job.label, ok: true, count: got.length });
    } catch (err) {
      console.warn(`[warn] ${job.label}: ${err.message}`);
      status.push({ label: job.label, ok: false, error: err.message });
    }
    if (job.gn) await sleep(1200); // Google ニュースへの連続アクセスを控える
  }

  // 前回分に今回分を重ねる（取得に失敗した情報源の過去記事も消えない）
  const now = new Date().toISOString();
  const map = new Map();
  for (const it of previous.items) map.set(itemKey(it), it);
  for (const it of fresh) {
    const k = itemKey(it);
    const old = map.get(k);
    map.set(k, old ? { ...mergeItem(it, old), firstSeen: old.firstSeen || now } : { ...it, firstSeen: now });
  }

  // 報道は「見出しで言及」か「本文で言及」かを判定する（過去分も毎回判定し直す）
  const titleRe = new RegExp(cfg.titlePattern);
  const excludeRes = (cfg.excludeTitlePatterns || []).map((p) => new RegExp(p));
  const items = [...map.values()]
    .filter((it) => !excludeRes.some((re) => re.test(it.title)))
    .map((it) => {
      if (it.type !== 'media') return it;
      const inTitle = titleRe.test(it.title) || tagger(it.title).length > 0;
      return { ...it, mention: inTitle ? 'title' : 'body' };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_ITEMS)
    .map((it) => Object.fromEntries(Object.entries(it).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0) )));

  const okCount = status.filter((s) => s.ok).length;
  const output = {
    updatedAt: okCount > 0 ? now : previous.updatedAt || null,
    lastAttempt: now,
    fetchOk: okCount > 0,
    failedSources: status.filter((s) => !s.ok).map((s) => s.label),
    items,
  };

  await mkdir('data', { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 1) + '\n', 'utf-8');

  console.log(status.map((s) => `${s.ok ? 'ok ' : 'NG '} ${s.label}: ${s.ok ? s.count : s.error}`).join('\n'));
  console.log(`\n${items.length} 件を ${OUTPUT_PATH} に書き出しました（成功 ${okCount}/${status.length}）`);
}

main().catch((err) => {
  console.error('致命的なエラー:', err);
  process.exit(1);
});
