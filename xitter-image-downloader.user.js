// ==UserScript==
// @name         X / Twitter Image Downloader (4096x4096)
// @namespace    local.x-image-downloader
// @version      1.1.0
// @description  Download tweet photos with author/status filenames, without changing X's image layout.
// @match        https://x.com/*
// @match        https://www.x.com/*
// @match        https://twitter.com/*
// @match        https://www.twitter.com/*
// @match        https://mobile.twitter.com/*
// @grant        GM_xmlhttpRequest
// @connect      pbs.twimg.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const IMAGE_SIZE = '4096x4096';
  const PHOTO = 'a[href*="/photo/"]';
  const cache = new Map();
  const rows = new Map();
  const BUSY = new WeakSet();

  // All UI lives outside X's React tree. Never restyle or append to a photo.
  const host = document.createElement('div');
  host.id = 'x-image-downloader-ui';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const ui = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { font: 12px/1.4 system-ui, sans-serif; color-scheme: dark; }
    .tools { position:absolute; display:flex; flex-wrap:wrap; gap:5px;
      justify-content:flex-end; pointer-events:none; }
    button { all:initial; box-sizing:border-box; font:600 12px/1.4 system-ui,sans-serif;
      color:#fff; background:#14202ef2; border:1px solid #ffffff80; border-radius:20px;
      padding:6px 10px; cursor:pointer; pointer-events:auto; }
    button:hover { background:#155e89; }
    button:focus-visible { outline:3px solid #1d9bf0; }
    button:disabled { opacity:.65; cursor:wait; }
    #viewer { bottom:24px; left:50%; transform:translateX(-50%);
      width:min(600px,95vw); justify-content:center; }
    #notice { position:absolute; top:18px; left:50%; transform:translateX(-50%);
      max-width:90vw; padding:12px 16px; background:#14202e; color:white;
      border:1px solid #1d9bf0; border-radius:10px; pointer-events:none; }
  `;
  ui.append(style);
  document.body.append(host);
  function status(raw) {
    try {
      const url = new URL(raw, location.href);
      if (!/^(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)$/.test(url.hostname)) return null;
      const m = url.pathname.match(/^\/([\w]+)\/status\/(\d+)(?:\/photo\/(\d+))?\/?$/);
      if (!m || m[1] === 'i') return null;
      return { author: m[1], id: m[2], index: Number(m[3] || 0) };
    } catch { return null; }
  }

  function media(raw) {
    try {
      const u = new URL(raw);
      if (u.hostname !== 'pbs.twimg.com' || !u.pathname.startsWith('/media/')) return null;
      // Accept both modern ?format=jpg&name=small and older .jpg:small URLs.
      const m = u.pathname.match(/^\/media\/([\w-]+)(?:\.(jpe?g|png|webp|gif|avif))?(?::[\w]+)?$/i);
      if (!m) return null;
      let ext = (u.searchParams.get('format') || m[2] || 'jpg').toLowerCase();
      if (ext === 'jpeg') ext = 'jpg';
      if (!['jpg', 'png', 'webp', 'gif', 'avif'].includes(ext)) return null;
      const url = new URL(`https://pbs.twimg.com/media/${m[1]}`);
      url.searchParams.set('format', ext);
      url.searchParams.set('name', IMAGE_SIZE);
      return { key: m[1], url: url.href, ext };
    } catch { return null; }
  }

  function imageMedia(img) {
    return media(img.currentSrc) || media(img.src);
  }

  function filename(tweet, image, multiple) {
    return `${tweet.author}_status_${tweet.id}${multiple ? `_${image.index}` : ''}.${image.ext}`;
  }


  let toastTimer;
  function toast(message) {
    let el = ui.getElementById('notice');
    if (!el) {
      el = document.createElement('div'); el.id = 'notice';
      el.setAttribute('role', 'status'); ui.append(el);
    }
    el.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 9000);
  }

  function download(url, name) {
    // Fetch bytes through the userscript manager, then save a local blob.
    // This avoids GM_download's separate extension/download whitelist.
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob', timeout: 60000,
        anonymous: true,
        onload: response => {
          try {
            if (response.status < 200 || response.status >= 300)
              throw new Error(`Image server returned HTTP ${response.status}`);
            const blob = response.response;
            if (!blob || !blob.size) throw new Error('Image server returned an empty file');
            const type = blob.type || response.responseHeaders?.match(/content-type:\s*([^;\r\n]+)/i)?.[1] || '';
            if (type && !/^(image\/|application\/octet-stream)/i.test(type))
              throw new Error(`Expected an image, received ${type}`);
            const localURL = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = localURL; a.download = name;
            ui.append(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(localURL), 60000);
            resolve();
          } catch (error) { reject(error); }
        },
        onerror: () => reject(new Error('Image request failed; allow pbs.twimg.com in the userscript permission prompt')),
        ontimeout: () => reject(new Error('Image request timed out after 60 seconds')),
        onabort: () => reject(new Error('Image request was cancelled')),
      });
    });
  }

  async function save(button, tweet, images, multiple) {
    if (BUSY.has(button)) return;
    BUSY.add(button); button.disabled = true;
    const original = button.textContent;
    const errors = [];
    toast(`Fetching ${images.length} image${images.length > 1 ? 's' : ''}…`);
    try {
      for (const [i, image] of images.entries()) {
        button.textContent = `${i + 1}/${images.length}…`;
        try { await download(image.url, filename(tweet, image, multiple)); }
        catch (error) { errors.push(error.message); console.error('[X image downloader]', error); }
      }
      toast(errors.length
        ? `${errors.length} download(s) failed: ${errors[0]}`
        : `Save requested for ${images.length} image(s). If prompted, allow multiple downloads.`);
    } finally {
      button.textContent = original; button.disabled = false; BUSY.delete(button);
    }
  }

  function button(label, handler) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    b.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation(); handler(b);
    });
    return b;
  }
  function collect(article) {
    // A tweet's own timestamp gives its author, including on reposts.
    const permalink = [...article.querySelectorAll('time')]
      .filter(t => t.closest('article') === article)
      .map(t => status(t.closest('a')?.href)).find(Boolean);
    if (!permalink) return null;
    const images = [];
    const seen = new Set();
    for (const a of article.querySelectorAll(PHOTO)) {
      const owner = status(a.href);
      // Excludes avatars, video thumbnails, and photos in quoted tweets.
      if (!owner?.index || owner.id !== permalink.id || a.closest('article') !== article) continue;
      const img = [...a.querySelectorAll('img')].find(i => imageMedia(i));
      if (!img) continue;
      const image = imageMedia(img);
      if (seen.has(image.key)) continue;
      seen.add(image.key);
      images.push({ ...image, index: owner.index, host: img });
    }
    images.sort((a, b) => a.index - b.index);
    return images.length ? { ...permalink, images } : null;
  }


  function scanTweet(article) {
    const tweet = collect(article);
    const old = rows.get(article);
    if (!tweet) { old?.tools.remove(); rows.delete(article); return; }
    const images = tweet.images.map(({host, ...image}) => image);
    cache.delete(tweet.id); cache.set(tweet.id, { ...tweet, images });
    if (cache.size > 150) cache.delete(cache.keys().next().value);
    const signature = `${tweet.id}:${images.map(i => `${i.index}-${i.key}`).join(',')}`;
    if (old?.signature === signature) { old.anchors = tweet.images.map(i => i.host); return; }
    old?.tools.remove();
    const tools = document.createElement('div'); tools.className = 'tools';
    const multiple = images.length > 1 || images.some(i => i.index > 1);
    tools.append(button(`↓ Download all (${images.length})`, b => save(b, tweet, images, multiple)));
    if (multiple) for (const image of images)
      tools.append(button(`↓ ${image.index}`, b => save(b, tweet, [image], true)));
    ui.append(tools);
    rows.set(article, { tools, signature, anchors: tweet.images.map(i => i.host) });
  }

  function viewer() {
    const owner = status(location.href);
    const existing = ui.getElementById('viewer');
    if (!owner?.index) { existing?.remove(); return; }
    const known = cache.get(owner.id);
    const candidates = [...document.querySelectorAll('img')].filter(img =>
      !img.closest('article') && imageMedia(img) && img.getClientRects().length);
    candidates.sort((a,b) => {
      const area = img => { const r = img.getBoundingClientRect(); return r.width*r.height; };
      return area(b)-area(a);
    });
    const visible = candidates[0] && imageMedia(candidates[0]);
    const cached = known?.images.find(i => i.index === owner.index);
    const image = cached || (visible && {...visible, index:owner.index});
    if (!image || (cached && visible && cached.key !== visible.key)) { existing?.remove(); return; }
    const signature = `${owner.id}:${owner.index}:${image.key}:${known?.images.length || 0}`;
    if (existing?.dataset.signature === signature) return;
    existing?.remove();
    const tools = document.createElement('div'); tools.id = 'viewer'; tools.className = 'tools';
    tools.dataset.signature = signature;
    const multiple = !known || known.images.length > 1 || owner.index > 1;
    tools.append(button('↓ Save this image', b => save(b, owner, [image], multiple)));
    if (known) tools.append(button(`↓ Download all (${known.images.length})`, b => save(b, known, known.images, multiple)));
    else tools.append(button('Open tweet for all images', () => {
      location.href = `https://${location.hostname}/${owner.author}/status/${owner.id}`;
    }));
    ui.append(tools);
  }

  function position() {
    const inViewer = !!status(location.href)?.index;
    for (const [article, row] of rows) {
      if (!article.isConnected) { row.tools.remove(); rows.delete(article); continue; }
      const rects = row.anchors.filter(img => img.isConnected).map(img => img.getBoundingClientRect())
        .filter(r => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight);
      row.tools.hidden = inViewer || !rects.length;
      row.tools.style.display = row.tools.hidden ? 'none' : 'flex';
      if (row.tools.hidden) continue;
      const r = rects[0];
      row.tools.style.top = `${Math.max(6, r.top + 6)}px`;
      row.tools.style.left = `${Math.max(4, r.left + 6)}px`;
      row.tools.style.width = `${Math.max(0, Math.min(r.width - 12, innerWidth - r.left - 12))}px`;
    }
  }
  function scan() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach(scanTweet);
    viewer(); position();
  }
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; scan(); }, 180);
  }
  new MutationObserver(records => {
    if (records.some(r => r.target !== host && !host.contains(r.target))) schedule();
  }).observe(document.body, {childList:true, subtree:true, attributes:true,
    attributeFilter:['src','srcset','href']});
  let frame;
  const reposition = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; position(); });
  };
  window.addEventListener('scroll', reposition, {passive:true, capture:true});
  window.addEventListener('resize', reposition, {passive:true});
  window.addEventListener('popstate', schedule);
  let lastURL = location.href;
  setInterval(() => {
    if (location.href !== lastURL) { lastURL = location.href; schedule(); }
  }, 750);
  scan();
})();
