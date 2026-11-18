// チームみらい ウォッチ（非公式）— 画面側の処理
// data/items.json（GitHub Actions が生成）と config/sources.json を読み込んで表示する。
(() => {
  'use strict';

  const PAGE_SIZE = 60;
  const KIND_LABEL = { news: 'お知らせ', diet: '国会記録', note: 'note', video: '動画', sns: 'SNS', article: '記事' };
  const TYPE_LABEL = { official: '党公式', member: '議員', media: '報道' };
  const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

  const state = { type: 'all', member: '', media: '', body: false, q: '', limit: PAGE_SIZE };
  let config = null;
  let items = [];
  let memberById = new Map();

  const $ = (id) => document.getElementById(id);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');

  // ---------- 日付（閲覧者の端末に関係なく日本時間で表示） ----------
  const jstParts = (d) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value]));
    return p;
  };
  const dayKey = (d) => { const p = jstParts(d); return `${p.year}-${p.month}-${p.day}`; };
  const dayLabel = (d) => {
    const p = jstParts(d);
    const thisYear = jstParts(new Date()).year;
    return `${p.year !== thisYear ? p.year + '年' : ''}${p.month}月${p.day}日（${p.weekday}）`;
  };
  const timeLabel = (d) => { const p = jstParts(d); return `${p.hour}:${p.minute}`; };
  const fullLabel = (d) => { const p = jstParts(d); return `${p.month}月${p.day}日 ${p.hour}:${p.minute}`; };

  // ---------- URL のハッシュに絞り込み条件を残す（共有できるように） ----------
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    state.type = ['official', 'member', 'media'].includes(h.get('type')) ? h.get('type') : 'all';
    state.member = memberById.has(h.get('member')) ? h.get('member') : '';
    state.media = config.media.some((m) => m.id === h.get('media')) ? h.get('media') : '';
    state.body = h.get('body') === '1';
    state.q = h.get('q') || '';
  }
  function writeHash() {
    const h = new URLSearchParams();
    if (state.type !== 'all') h.set('type', state.type);
    if (state.member) h.set('member', state.member);
    if (state.media && state.type === 'media') h.set('media', state.media);
    if (state.body) h.set('body', '1');
    if (state.q) h.set('q', state.q);
    const s = h.toString();
    history.replaceState(null, '', s ? `#${s}` : location.pathname + location.search);
  }

  // ---------- 絞り込み ----------
  function baseFilter(it) {
    if (it.type === 'media' && it.mention === 'body' && !state.body) return false;
    if (state.member && !(it.members || []).includes(state.member)) return false;
    if (state.q) {
      const hay = `${it.title} ${it.description || ''} ${it.source}`.toLowerCase();
      if (!state.q.toLowerCase().split(/[\s　]+/).filter(Boolean).every((w) => hay.includes(w))) return false;
    }
    return true;
  }
  function typeFilter(it) {
    if (state.type === 'all') return true;
    if (it.type !== state.type) return false;
    if (state.type === 'media' && state.media && it.mediaId !== state.media) return false;
    return true;
  }

  // ---------- 描画 ----------
  function renderControls() {
    const base = items.filter(baseFilter);
    const counts = { all: base.length, official: 0, member: 0, media: 0 };
    base.forEach((it) => { counts[it.type]++; });
    if (state.media) counts.media = base.filter((it) => it.type === 'media' && it.mediaId === state.media).length;

    document.querySelectorAll('#type-tabs button').forEach((b) => {
      const t = b.dataset.type;
      b.setAttribute('aria-selected', String(t === state.type));
      b.querySelector('.count').textContent = `${counts[t].toLocaleString()}件`;
    });

    const chipRow = $('member-chips');
    chipRow.querySelectorAll('.chip').forEach((c) => {
      const on = c.dataset.member === state.member;
      c.setAttribute('aria-pressed', String(on));
      // 選んだ議員のボタンが横スクロールの外に隠れないようにする
      if (on) chipRow.scrollLeft = Math.max(0, c.offsetLeft - chipRow.offsetLeft - 40);
    });

    $('media-row').hidden = !(state.type === 'all' || state.type === 'media');
    $('media-select').hidden = state.type !== 'media';
    $('media-select').value = state.media;
    $('body-toggle').checked = state.body;
    if ($('search').value !== state.q) $('search').value = state.q;
  }

  function renderMemberCard() {
    const card = $('member-card');
    const m = memberById.get(state.member);
    if (!m) { card.hidden = true; card.innerHTML = ''; return; }
    const links = [
      ['公式プロフィール', m.profile],
      m.x && ['X', `https://x.com/${m.x}`],
      m.note && ['note', `https://note.com/${m.note}`],
      m.youtube && ['YouTube', `https://www.youtube.com/channel/${m.youtube}`],
    ].filter(Boolean);
    card.innerHTML = `
      <p class="name">${esc(m.name)}${m.role ? ` <small>（${esc(m.role)}）</small>` : ''}</p>
      <p class="meta">${esc(m.chamber)}議員 ／ ${esc(m.district)}</p>
      <div class="links">${links.map(([l, u]) => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${esc(l)} ↗</a>`).join('')}</div>
      <p class="note">見出しや説明文に議員名がある記事と、本人の note・YouTube を表示しています（X の投稿は含みません）。</p>`;
    card.hidden = false;
  }

  function cardHTML(it) {
    const d = new Date(it.date);
    const kind = KIND_LABEL[it.kind] || '';
    const tags = (it.members || []).map((id) => memberById.get(id)).filter(Boolean)
      .map((m) => `<button class="tag" data-member="${esc(m.id)}" title="${esc(m.name)}の記事だけを表示">${esc(m.name)}</button>`).join('');
    const thumb = it.thumb && it.type !== 'media'
      ? `<img class="thumb" src="${esc(safeUrl(it.thumb))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
    return `
      <article class="card t-${esc(it.type)}">
        <div class="body">
          <div class="meta-line">
            <span class="badge t-${esc(it.type)}">${esc(TYPE_LABEL[it.type])}｜${esc(it.source)}</span>
            ${kind && it.kind !== 'article' ? `<span class="kind">${esc(kind)}</span>` : ''}
            ${it.dateOnly ? '' : `<span class="time">${timeLabel(d)}</span>`}
            ${it.mention === 'body' ? '<span class="body-mention">・本文で言及</span>' : ''}
          </div>
          <h3><a href="${esc(safeUrl(it.link))}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a></h3>
          ${tags ? `<div class="tags">${tags}</div>` : ''}
        </div>
        ${thumb}
      </article>`;
  }

  function renderTimeline() {
    const list = items.filter((it) => baseFilter(it) && typeFilter(it));
    const shown = list.slice(0, state.limit);
    const tl = $('timeline');

    const parts = [];
    if (state.member) parts.push(memberById.get(state.member).name);
    if (state.type !== 'all') parts.push(state.type === 'media' && state.media
      ? config.media.find((m) => m.id === state.media).name
      : { official: '党の公式発信', member: '議員の発信', media: '大手メディア報道' }[state.type]);
    if (state.q) parts.push(`「${state.q}」`);
    $('result-summary').textContent = `${parts.length ? parts.join(' ／ ') + '：' : ''}${list.length.toLocaleString()}件`;

    if (list.length === 0) {
      tl.innerHTML = '<p class="empty">該当する記事はありません。条件を変えてみてください。</p>';
      $('more').hidden = true;
      return;
    }

    let html = '';
    let lastDay = '';
    for (const it of shown) {
      const d = new Date(it.date);
      const k = dayKey(d);
      if (k !== lastDay) { html += `<h2 class="day-head">${dayLabel(d)}</h2>`; lastDay = k; }
      html += cardHTML(it);
    }
    tl.innerHTML = html;
    $('more').hidden = list.length <= state.limit;
    $('more').textContent = `もっと見る（残り ${(list.length - state.limit).toLocaleString()}件）`;
  }

  function render({ resetLimit = true } = {}) {
    if (resetLimit) state.limit = PAGE_SIZE;
    renderControls();
    renderMemberCard();
    renderTimeline();
    writeHash();
  }

  // ---------- 初期化 ----------
  function buildStaticParts() {
    const chips = [`<button class="chip" data-member="">全員</button>`]
      .concat(config.members.map((m) => `<button class="chip" data-member="${esc(m.id)}">${esc(m.name)}<small>${m.chamber === '参議院' ? '参' : '衆'}</small></button>`));
    $('member-chips').innerHTML = chips.join('');

    const groups = [...new Set(config.media.map((m) => m.group))];
    $('media-select').innerHTML = `<option value="">すべての媒体</option>` + groups.map((g) =>
      `<optgroup label="${esc(g)}">${config.media.filter((m) => m.group === g).map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</optgroup>`).join('');

    $('media-list').textContent = groups.map((g) => `${g}（${config.media.filter((m) => m.group === g).map((m) => m.name).join('・')}）`).join('、');
  }

  function bindEvents() {
    $('type-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-type]');
      if (!b) return;
      state.type = b.dataset.type;
      if (state.type !== 'media') state.media = '';
      render();
    });
    $('member-chips').addEventListener('click', (e) => {
      const c = e.target.closest('.chip');
      if (!c) return;
      state.member = c.dataset.member === state.member ? '' : c.dataset.member;
      render();
    });
    $('timeline').addEventListener('click', (e) => {
      const t = e.target.closest('.tag');
      if (!t) return;
      state.member = t.dataset.member;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    $('media-select').addEventListener('change', (e) => { state.media = e.target.value; render(); });
    $('body-toggle').addEventListener('change', (e) => { state.body = e.target.checked; render(); });
    let timer;
    $('search').addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => { state.q = e.target.value.trim(); render(); }, 200);
    });
    $('more').addEventListener('click', () => { state.limit += PAGE_SIZE; render({ resetLimit: false }); });
    window.addEventListener('hashchange', () => { readHash(); render(); });
  }

  async function init() {
    try {
      const [cfgRes, dataRes] = await Promise.all([
        fetch('config/sources.json', { cache: 'no-cache' }),
        fetch(`data/items.json?t=${Math.floor(Date.now() / 300000)}`), // 5分単位でキャッシュを切り替える
      ]);
      if (!cfgRes.ok || !dataRes.ok) throw new Error(`HTTP ${cfgRes.status}/${dataRes.status}`);
      config = await cfgRes.json();
      const data = await dataRes.json();
      memberById = new Map(config.members.map((m) => [m.id, m]));
      items = (data.items || []).filter((it) => it.title && it.link && !isNaN(new Date(it.date)));

      $('updated').textContent = data.updatedAt ? `最終更新：${fullLabel(new Date(data.updatedAt))}（1時間ごとに自動更新）` : '';
      const stale = data.updatedAt && Date.now() - new Date(data.updatedAt) > 6 * 3600 * 1000;
      if (data.fetchOk === false || stale) {
        $('notice').textContent = '※ 自動取得がしばらく止まっています。表示は前回取得した内容です。';
        $('notice').hidden = false;
      }

      buildStaticParts();
      bindEvents();
      readHash();
      render();
    } catch (err) {
      console.error(err);
      $('updated').textContent = '';
      $('timeline').innerHTML = '<p class="empty">データの読み込みに失敗しました。時間をおいて再読み込みしてください。</p>';
    }
  }

  init();
})();
