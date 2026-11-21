/*
 * Renders every section from /data/*.json.
 * A section stays hidden until its data file has content.
 * If window.__DATA__ is set (single-file preview), it is used instead of fetching.
 */
(function () {
  "use strict";

  var FILES = {
    site: "data/site.json",
    caseStudies: "data/case-studies.json",
    screens: "data/screens.json",
    experience: "data/experience.json",
    ai: "data/ai.json",
    play: "data/play.json",
    principles: "data/principles.json",
    toolbox: "data/toolbox.json",
    education: "data/education.json"
  };
  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function $(s) { return document.querySelector(s); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null && text !== "") n.textContent = text; return n; }
  function get(o, p) { return p.split(".").reduce(function (a, k) { return a == null ? undefined : a[k]; }, o); }
  function filled(v) {
    if (Array.isArray(v)) return v.length > 0;
    if (v && typeof v === "object") return Object.keys(v).some(function (k) { return k.charAt(0) !== "_" && filled(v[k]); });
    return v != null && v !== "" && v !== false;
  }
  function load() {
    if (window.__DATA__) return Promise.resolve(window.__DATA__);
    var keys = Object.keys(FILES);
    return Promise.all(keys.map(function (k) {
      return fetch(FILES[k], { cache: "no-cache" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    })).then(function (res) { var d = {}; keys.forEach(function (k, i) { d[k] = res[i]; }); return d; });
  }

  /* ---------- theme ---------- */
  function currentTheme() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t) return t;
    return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function setThemeLabel() {
    var b = $("#themeBtn"); if (!b) return;
    b.setAttribute("aria-label", currentTheme() === "dark" ? "Switch to light mode" : "Switch to dark mode");
  }
  function initTheme() {
    var b = $("#themeBtn"); if (!b) return;
    setThemeLabel();
    b.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("theme", next); } catch (e) {}
      setThemeLabel();
    });
  }

  /* ---------- site-wide ---------- */
  function applySite(site) {
    document.querySelectorAll("[data-bind]").forEach(function (n) { var v = get({ site: site }, n.getAttribute("data-bind")); if (filled(v)) n.textContent = v; else if (n.classList.contains("pen")) n.hidden = true; });
    document.querySelectorAll("[data-src]").forEach(function (n) { var v = get({ site: site }, n.getAttribute("data-src")); if (filled(v)) n.src = v; else n.hidden = true; });
    if (site.sample) $("#sampleBar").hidden = false;
    var ctas = $("#heroCtas");
    (site.ctas || []).forEach(function (c) { var a = el("a", "btn" + (c.primary ? " btn-ink" : ""), c.label); a.href = c.href; ctas.appendChild(a); });
    var nav = $("#navLinks");
    (site.nav || []).forEach(function (l) { var li = el("li"), a = el("a", null, l.label); a.href = l.href; li.appendChild(a); nav.appendChild(li); });
  }

  /* ---------- renderers ---------- */
  var render = {
    stats: function (site) {
      var box = $("#stats");
      (site.stats || []).forEach(function (s, i, arr) {
        var d = el("div", /marathon|personal/i.test(s.label) ? "personal" : null);
        d.appendChild(el("b", null, s.value)); d.appendChild(el("span", null, s.label));
        box.appendChild(d);
      });
      var w = $("#workedAt");
      (site.workedAt || []).forEach(function (n) { w.appendChild(el("li", null, n)); });
      if (!filled(site.workedAt) || (site.sections && site.sections.workedAt === false)) $(".worked").hidden = true;
    },

    caseStudies: function (items) {
      var tabs = $("#csTabs"), panel = $("#csPanel");
      function show(i) {
        [].forEach.call(tabs.children, function (t, j) { t.setAttribute("aria-selected", j === i ? "true" : "false"); t.tabIndex = j === i ? 0 : -1; });
        var c = items[i], L = c.labels || {}; panel.innerHTML = "";
        panel.appendChild(el("p", "eyebrow", c.eyebrow));
        panel.appendChild(el("h3", null, c.title));
        panel.appendChild(el("p", "cs-sum", c.summary));
        if (c.locked) {
          var lock = el("div", "lock"), ghost = el("div", "ghost");
          [92, 78, 85, 60, 88, 70].forEach(function (w) { var g = el("i"); g.style.width = w + "%"; ghost.appendChild(g); });
          var msg = el("div", "msg");
          msg.appendChild(el("b", null, "🔒 Confidential"));
          msg.appendChild(el("span", null, "Happy to walk you through this one in person."));
          var a = el("a", "btn btn-ink", "Ask for a walkthrough"); a.href = "#contact"; msg.appendChild(a);
          lock.appendChild(ghost); lock.appendChild(msg); panel.appendChild(lock);
          return;
        }
        if (filled(c.metrics)) {
          var m = el("div", "cs-metrics");
          c.metrics.forEach(function (x) { var d = el("div"); d.appendChild(el("b", null, x.value)); d.appendChild(el("span", null, x.label)); m.appendChild(d); });
          panel.appendChild(m);
        }
        var blocks = el("div", "cs-blocks");
        [[L.problem || "The problem", c.problem], [L.research || "What research showed", c.research], [L.did || "What I did", c.did], [L.owned || "What I owned", c.owned]].forEach(function (b) {
          if (!filled(b[1])) return;
          var d = el("div"); d.appendChild(el("h4", null, b[0]));
          if (Array.isArray(b[1])) { var ul = el("ul"); b[1].forEach(function (t) { ul.appendChild(el("li", null, t)); }); d.appendChild(ul); }
          else d.appendChild(el("p", null, b[1]));
          blocks.appendChild(d);
        });
        panel.appendChild(blocks);
        if (filled(c.differently)) { var df = el("div", "cs-diff"); df.appendChild(el("b", null, L.differently || "What I'd do differently")); df.appendChild(el("p", null, c.differently)); panel.appendChild(df); }
      }
      items.forEach(function (c, i) {
        var b = el("button", "cs-tab"); b.type = "button"; b.setAttribute("role", "tab");
        b.appendChild(el("b", null, (c.locked ? "🔒 " : "") + c.tab)); b.appendChild(el("span", null, c.eyebrow));
        b.addEventListener("click", function () { show(i); });
        b.addEventListener("keydown", function (e) {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault(); var n = (i + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
          show(n); tabs.children[n].focus();
        });
        tabs.appendChild(b);
      });
      show(0);
    },

    screens: function (items) {
      var grid = $("#screenGrid"), filters = $("#screenFilters");
      var tags = ["All"].concat(items.map(function (s) { return s.tag; }).filter(function (t, i, a) { return t && a.indexOf(t) === i; }));
      tags.forEach(function (t, i) {
        var b = el("button", null, t); b.type = "button"; b.setAttribute("aria-pressed", i === 0 ? "true" : "false");
        b.addEventListener("click", function () {
          [].forEach.call(filters.children, function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
          [].forEach.call(grid.children, function (card) { card.hidden = !(t === "All" || card.dataset.tag === t); });
        });
        filters.appendChild(b);
      });
      items.forEach(function (s) {
        var card = el("button", "screen"); card.type = "button"; card.dataset.tag = s.tag || "";
        card.setAttribute("aria-label", "Enlarge: " + s.title);
        card.appendChild(phone(s.ui));
        card.appendChild(el("b", null, s.title)); card.appendChild(el("span", null, s.caption));
        card.addEventListener("click", function () { openLightbox(s); });
        grid.appendChild(card);
      });
    },

    experience: function (items) {
      var box = $("#experienceList");
      items.forEach(function (r) {
        var li = el("li", "role paper");
        li.appendChild(el("span", "role-when", r.period));
        var body = el("div");
        body.appendChild(el("h3", null, r.title));
        body.appendChild(el("span", "role-org", r.org));
        if (filled(r.summary)) body.appendChild(el("p", "role-sum", r.summary));
        if (filled(r.metrics)) { var m = el("div", "role-metrics"); r.metrics.forEach(function (x) { m.appendChild(el("span", "chip", x)); }); body.appendChild(m); }
        if (filled(r.highlights)) { var ul = el("ul", "role-points"); r.highlights.forEach(function (h) { ul.appendChild(el("li", null, h)); }); body.appendChild(ul); }
        li.appendChild(body); box.appendChild(li);
      });
    },

    // AI work: one featured tool (big card) + a shelf of the rest, each with a sketched screen.
    ai: function (ai) {
      if (filled(ai.intro)) $("#aiIntro").textContent = ai.intro;
      if (filled(ai.handNote)) { var hn = $("#aiNote"); hn.textContent = ai.handNote; hn.hidden = false; }
      var box = $("#aiTools"); box.className = "tools-v2";
      var tools = ai.tools || [];
      var feat = tools.filter(function (t) { return t.featured; })[0];
      if (feat) {
        var f = el("article", "feature paper");
        var art = el("div", "feature-art"); art.appendChild(sketch(feat.sketch, true)); f.appendChild(art);
        var body = el("div", "feature-body");
        var meta = el("div", "feature-meta");
        if (filled(feat.status)) meta.appendChild(el("span", "chip", feat.status));
        if (filled(ai.featuredNote)) meta.appendChild(el("span", "pen", ai.featuredNote));
        body.appendChild(meta);
        body.appendChild(el("h3", null, feat.title));
        if (filled(feat.q)) body.appendChild(el("span", "q", feat.q));
        body.appendChild(el("p", null, feat.s || feat.d));
        var fa = actions(feat, true, "btn btn-ink", "btn");
        body.appendChild(fa);
        f.appendChild(body); box.appendChild(f);
      }
      var wrap = el("div", "shelf-wrap");
      var shelf = el("div", "shelf");
      shelf.setAttribute("tabindex", "0");
      shelf.setAttribute("role", "region");
      shelf.setAttribute("aria-label", "More tools, scroll sideways");
      tools.filter(function (t) { return t !== feat; }).forEach(function (t) {
        var d = el("article", "shelf-item");
        var art = el("div", "shelf-art"); art.appendChild(sketch(t.sketch, false)); d.appendChild(art);
        var h = el("h3", null, t.title);
        if (filled(t.status) && !/^live$/i.test(t.status)) h.appendChild(el("span", "chip", t.status));
        d.appendChild(h);
        if (filled(t.q)) d.appendChild(el("span", "q", t.q));
        d.appendChild(el("p", null, t.s || t.d));
        d.appendChild(actions(t, true, "link-strong", "link-soft"));
        shelf.appendChild(d);
      });
      var nav = el("div", "shelf-nav");
      var prev = el("button", "shelf-btn", "←"), next = el("button", "shelf-btn", "→");
      prev.type = next.type = "button";
      prev.setAttribute("aria-label", "Scroll tools left"); next.setAttribute("aria-label", "Scroll tools right");
      var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
      function go(dir) {
        var items = [].slice.call(shelf.children), x = shelf.scrollLeft, base = items[0] ? items[0].offsetLeft : 0, target = x;
        var lefts = items.map(function (it) { return it.offsetLeft - base; });
        if (dir > 0) { for (var i = 0; i < lefts.length; i++) { if (lefts[i] > x + 4) { target = lefts[i]; break; } } }
        else { for (var k = lefts.length - 1; k >= 0; k--) { if (lefts[k] < x - 4) { target = lefts[k]; break; } } }
        shelf.scrollTo({ left: target, behavior: reduce ? "auto" : "smooth" });
      }
      prev.addEventListener("click", function () { go(-1); });
      next.addEventListener("click", function () { go(1); });
      function sync() {
        var max = shelf.scrollWidth - shelf.clientWidth - 2;
        prev.disabled = shelf.scrollLeft <= 2; next.disabled = shelf.scrollLeft >= max;
        nav.hidden = max <= 0;
        wrap.classList.toggle("at-end", shelf.scrollLeft >= max);
        wrap.classList.toggle("scrolled", shelf.scrollLeft > 2);
      }
      shelf.addEventListener("scroll", sync, { passive: true });
      window.addEventListener("resize", sync);
      nav.appendChild(prev); nav.appendChild(next);
      wrap.appendChild(nav); wrap.appendChild(shelf);
      box.appendChild(wrap);
      requestAnimationFrame(sync);
    },

    // Play: the page turns to night; each game gets a picture.
    play: function (p) {
      if (filled(p.intro)) $("#playIntro").textContent = p.intro;
      if (filled(p.handNote)) { var hn = $("#playNote"); hn.textContent = p.handNote; hn.hidden = false; }
      var box = $("#playGames"); box.className = "games";
      (p.games || []).forEach(function (g) {
        var d = el("article", "game");
        var art = el("div", "game-art game-art-" + (g.art || "none")); art.innerHTML = ART[g.art] || ""; art.setAttribute("aria-hidden", "true");
        d.appendChild(art);
        var body = el("div", "game-body");
        var top = el("div", "top"); top.appendChild(el("h3", null, g.title));
        if (filled(g.status)) top.appendChild(el("span", "game-status", g.status));
        body.appendChild(top);
        if (filled(g.q)) body.appendChild(el("span", "q", g.q));
        body.appendChild(actions(g, false, "link-strong", "link-soft"));
        d.appendChild(body); box.appendChild(d);
      });
    },

    cards: function (src, items, introSel, boxSel, external) {
      if (filled(src.intro)) $(introSel).textContent = src.intro;
      var box = $(boxSel);
      (items || []).forEach(function (t) {
        var d = el("article", "proj paper"), top = el("div", "top");
        top.appendChild(el("h3", null, t.title));
        if (filled(t.status)) top.appendChild(el("span", "chip", t.status));
        d.appendChild(top);
        if (filled(t.q)) d.appendChild(el("span", "q", t.q));
        if (filled(t.d)) d.appendChild(el("p", null, t.d));
        if (filled(t.tags)) { var tg = el("div", "tags"); t.tags.forEach(function (x) { tg.appendChild(el("span", "chip", x)); }); d.appendChild(tg); }
        var act = el("div", "proj-actions");
        if (filled(t.url)) {
          var a = el("a", "btn btn-ink", t.linkLabel || "Try it ↗"); a.href = t.url;
          if (external) { a.target = "_blank"; a.rel = "noopener"; }
          var tp = trackPath(t);
          if (tp && tp.event) a.addEventListener("click", function () { countEvent(tp.path, t.title); });
          if (tp) tracked.push({ title: t.title, path: tp.path });
          act.appendChild(a);
        }
        if (filled(t.note)) { var n = el("a", "btn", "Build note →"); n.href = "notes/?n=" + encodeURIComponent(t.note); act.appendChild(n); }
        if (act.children.length) d.appendChild(act);
        box.appendChild(d);
      });
    },

    principles: function (items) {
      // Big statements on plain paper, explanation alongside. No cards.
      var box = $("#principleList"); box.className = "principle-rows";
      items.forEach(function (p) {
        var d = el("article", "principle-row");
        d.appendChild(el("h3", null, p.title));
        var side = el("div", "principle-side");
        side.appendChild(el("p", null, p.body));
        if (filled(p.note)) side.appendChild(el("span", "pen", p.note));
        d.appendChild(side);
        box.appendChild(d);
      });
    },

    // Education folded into one line at the end of How I work.
    eduLine: function (items) {
      var box = $("#eduLine"); if (!box || !filled(items)) return;
      box.appendChild(el("span", "pen", "Engineer first, then business:"));
      items.forEach(function (e, i) {
        if (i) { var ar = el("span", "edu-arrow", "→"); ar.setAttribute("aria-hidden", "true"); box.appendChild(ar); }
        var s = el("span", "edu-item"); s.appendChild(el("b", null, e.school)); s.appendChild(document.createTextNode(", " + e.degree));
        box.appendChild(s);
      });
      box.hidden = false;
    },

    toolbox: function (items) {
      var box = $("#toolboxList");
      items.forEach(function (c) {
        var d = el("div", "tool" + (c.personal ? " personal" : ""));
        d.appendChild(el("h3", null, c.title));
        var ul = el("ul"); (c.items || []).forEach(function (x) { ul.appendChild(el("li", null, x)); }); d.appendChild(ul);
        box.appendChild(d);
      });
    },

    education: function (items) {
      var box = $("#educationList");
      items.forEach(function (e) {
        var d = el("article", "edu-card paper");
        if (filled(e.year)) d.appendChild(el("span", "yr", e.year));
        d.appendChild(el("h3", null, e.school)); d.appendChild(el("span", "deg", e.degree));
        if (filled(e.note)) d.appendChild(el("p", null, e.note));
        box.appendChild(d);
      });
    },

    contact: function (site) {
      var c = site.contact || {}, box = $("#contactCards");
      function card(label, value, btnLabel, href, copy) {
        var d = el("div", "ccard paper"), l = el("div");
        l.appendChild(el("span", "label", label)); l.appendChild(el("b", null, value)); d.appendChild(l);
        if (copy) {
          var b = el("button", "btn", "Copy"); b.type = "button";
          b.addEventListener("click", function () {
            var done = function () { b.textContent = "Copied ✓"; setTimeout(function () { b.textContent = "Copy"; }, 1600); };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(done, function () { selectText(l.lastChild); });
            else selectText(l.lastChild);
          });
          d.appendChild(b);
        } else if (href) { var a = el("a", "btn", btnLabel); a.href = href; if (/^https?:/.test(href)) { a.target = "_blank"; a.rel = "noopener"; } d.appendChild(a); }
        box.appendChild(d);
      }
      if (filled(c.email)) card("Email", c.email, null, null, true);
      if (filled(c.linkedinLabel)) card("LinkedIn", c.linkedinLabel, "Open ↗", c.linkedinUrl);
      if (filled(c.calendarLabel)) card("Book a call", c.calendarLabel, "Book ↗", c.calendarUrl);
    }
  };

  /* ---------- usage metrics (GoatCounter) ---------- */
  // Internal pages (play/, moments/) already log page views, so their opens = views of that path.
  // External tools (Claude artifacts) can't run GoatCounter, so the Try-it click is logged as an event.
  var tracked = [];
  function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
  function trackPath(t) {
    if (filled(t.track)) return { path: t.track, event: !/^\//.test(t.track) };
    if (/^https?:/i.test(t.url)) return { path: "open-" + slug(t.title), event: true };
    var p = "/" + String(t.url).replace(/^\.?\//, "").replace(/index\.html$/, "");
    return { path: p, event: false };
  }
  function countEvent(path, title) {
    try { if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: path, title: "Opened: " + title, event: true }); } catch (e) {}
  }
  function num(v) { var n = parseInt(String(v == null ? "" : v).replace(/[^0-9]/g, ""), 10); return isNaN(n) ? 0 : n; }
  function fmt(n) { return n.toLocaleString("en-US"); }
  function counter(base, path) {
    return fetch(base + "/counter/" + encodeURIComponent(path) + ".json")
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }
  function renderMetrics(site) {
    var m = site.metrics, box = $("#siteMetrics");
    if (!box || !m || !m.enabled || !filled(m.endpoint)) return;
    var base = m.endpoint.replace(/\/+$/, ""), f = m.floors || {};
    Promise.all([counter(base, "TOTAL")].concat(tracked.map(function (t) { return counter(base, t.path); }))).then(function (res) {
      var total = res[0] || {}, parts = [];
      // GoatCounter's public counter reports unique visitors ("count"); there is no separate visits figure.
      var visitors = num(total.count_unique || total.count);
      if (visitors >= (f.visitors || 0) && visitors > 0) parts.push(fmt(visitors) + " visitors");
      var opens = 0, top = null, topN = 0;
      tracked.forEach(function (t, i) { var n = num(res[i + 1] && res[i + 1].count); opens += n; if (n > topN) { topN = n; top = t.title; } });
      if (opens >= (f.opens || 0) && opens > 0) parts.push(fmt(opens) + " tool opens" + (top ? " (most: " + top + ")" : ""));
      if (!parts.length) return;
      box.innerHTML = "";
      if (filled(m.label)) box.appendChild(el("span", "fm-label", m.label + " "));
      box.appendChild(document.createTextNode(parts.join(" · ")));
      box.hidden = false;
    });
  }

  function selectText(node) { var r = document.createRange(); r.selectNodeContents(node); var s = getSelection(); s.removeAllRanges(); s.addRange(r); }

  /* ---------- tool cards: links, sketched screens, game art ---------- */
  function actions(t, external, primaryCls, noteCls) {
    var act = el("div", "proj-actions");
    if (filled(t.url)) {
      var a = el("a", primaryCls, t.linkLabel || "Try it ↗"); a.href = t.url;
      if (external && /^https?:/i.test(t.url)) { a.target = "_blank"; a.rel = "noopener"; }
      var tp = trackPath(t);
      if (tp && tp.event) a.addEventListener("click", function () { countEvent(tp.path, t.title); });
      if (tp) tracked.push({ title: t.title, path: tp.path });
      act.appendChild(a);
    }
    if (filled(t.note)) { var n = el("a", noteCls, "Build note →"); n.href = "notes/?n=" + encodeURIComponent(t.note); act.appendChild(n); }
    return act;
  }

  // Hand-drawn style screens. Illustrations only, not real output.
  var SKETCH = {
    storytime: '<b class="sk-t">Tonight\'s story</b><div class="sk-pic"></div><div class="bar"></div><div class="bar m"></div><em class="sk-hand">refrain to chant…</em><div class="bar s"></div><div class="sk-cta">Read aloud</div>',
    chanakya: '<b class="sk-t">Your note</b><b>The players</b><div class="bar m"></div><b>One move</b><div class="bar hi"></div><b>Pre-mortem</b><div class="bar s"></div>',
    moments: '<b class="sk-t">Today</b><div class="sk-grid"><i></i><i></i><i></i><i></i><i></i><i></i></div><b>On this day</b><div class="bar m"></div>',
    mixlingo: '<b class="sk-t">Auto driver</b><span class="sk-msg">Elli hogbeku, saar?</span><span class="sk-msg me">Indiranagar, swalpa fast</span><span class="sk-msg">Sari, hogona!</span>',
    hisaab: '<b class="sk-t">Weekend trip</b><span class="sk-msg me">Rohan paid 600 for the cab</span><b>Settle up</b><div class="sk-row"><span>2 payments</span><span class="sk-pill">done</span></div>',
    pulseBig: '<div class="sk-bars"><i class="on"></i><i class="on"></i><i></i><i></i></div><div class="sk-row"><span class="sk-real">Claim</span><span>Evening</span></div><b>Two maths claims, both unverified</b><div class="bar"></div><div class="bar m"></div><b>Why it matters</b><div class="bar hi"></div><div class="bar s"></div><b>Try this</b><div class="bar m"></div><em class="sk-hand">how real is it?</em><div class="sk-cta">One-pager ↑</div>',
    pulse: '<div class="sk-bars"><i class="on"></i><i class="on"></i><i></i><i></i></div><div class="sk-row"><span class="sk-real">Claim</span><span>Evening</span></div><b>Two maths claims, both unverified</b><div class="bar m"></div><b>Why it matters</b><div class="bar hi"></div><div class="sk-cta">One-pager ↑</div>'
  };
  function sketch(kind, big) {
    var s = el("div", "sk" + (big ? " sk-big" : "")); s.setAttribute("aria-hidden", "true");
    s.innerHTML = (big && SKETCH[kind + "Big"]) || SKETCH[kind] || '<div class="bar"></div><div class="bar m"></div><div class="bar s"></div>';
    return s;
  }
  var ART = {
    road: '<i class="lane l1"></i><i class="lane l2"></i><i class="hole h1"></i><i class="hole h2"></i><i class="hole h3"></i><i class="scooter"></i><span class="sign">MG ROAD</span>',
    aunty: '<span class="bub office">"Let\'s circle back on this."</span><span class="bub aunty">"Matlab beta, abhi nahi. Baad mein dekhenge."</span>'
  };

  /* ---------- sample phone screens ---------- */
  function phone(kind) {
    var p = el("div", "phone"), u = el("div", "ui");
    var H = {
      home: '<span class="t">Hi there 👋</span><div class="bar m"></div><div class="box on"><b>Protect what matters</b><span>Health · Motor · Loan cover</span><span class="pill">New</span></div><div class="box"><div class="bar s"></div><div class="bar"></div></div><div class="box"><div class="bar m"></div></div>',
      quote: '<span class="t">Get a quote</span><div class="box"><span>Age</span><div class="bar s"></div></div><div class="box"><span>City tier</span><div class="bar s"></div></div><div class="box"><span>Members</span><div class="bar s"></div></div><div class="box on"><span>Your price</span><span class="big">₹X,XXX/yr</span></div><div class="cta">See plans</div>',
      plans: '<span class="t">Compare plans</span><div class="box"><div class="row"><b>Basic</b><b>₹X</b></div><div class="bar m"></div></div><div class="box on"><div class="row"><b>Plus</b><b>₹Y</b></div><span class="pill">Most picked</span><div class="bar"></div></div><div class="box"><div class="row"><b>Max</b><b>₹Z</b></div><div class="bar s"></div></div><div class="cta">Continue</div>',
      checkout: '<span class="t">Review &amp; pay</span><div class="box"><div class="row"><span>Plan</span><b>Plus</b></div><div class="row"><span>Cover</span><b>₹X L</b></div><div class="row"><span>Premium</span><b>₹Y</b></div></div><div class="box"><span>What\'s covered?</span><div class="bar m"></div></div><div class="cta">Pay ₹Y</div>',
      policy: '<span class="t">My policies</span><div class="box on"><span class="pill">Active</span><b>Health · Plus</b><span>Valid till DD MMM YYYY</span><div class="bar s"></div></div><div class="box"><b>Motor</b><span>Renew in 28 days</span></div><div class="cta">Download policy</div>',
      renew: '<span class="t">Renew in 30 days</span><div class="box on"><span>Same cover, same price</span><span class="big">₹X,XXX</span></div><div class="box"><span>No claims bonus kept</span><div class="bar s"></div></div><div class="cta">Renew in one tap</div>',
      claim: '<span class="t">File a claim</span><div class="box"><span>1 · What happened?</span><div class="bar m"></div></div><div class="box"><span>2 · Upload bills</span><div class="bar s"></div></div><div class="box"><span>3 · Bank account</span><div class="bar s"></div></div><div class="cta">Submit</div>',
      chat: '<span class="t">Need help?</span><span class="msg">Is my parent\'s surgery covered?</span><span class="msg me">Yes, after a 2-year wait. Here\'s why…</span><span class="msg">Can I talk to someone?</span><span class="msg me">Calling you in 2 min.</span>'
    };
    u.innerHTML = (H[kind] || H.home);
    p.appendChild(u); p.appendChild(el("span", "sample-tag", "sample screen"));
    return p;
  }

  /* ---------- lightbox ---------- */
  var lastFocus = null;
  function openLightbox(s) {
    lastFocus = document.activeElement;
    var body = $("#lbBody"); body.innerHTML = "";
    body.appendChild(phone(s.ui));
    var cap = el("div", "cap"); cap.appendChild(el("b", null, s.title)); cap.appendChild(document.createElement("br")); cap.appendChild(document.createTextNode(s.caption)); body.appendChild(cap);
    $("#lightbox").hidden = false; $("#lbClose").focus();
  }
  function closeLightbox() { $("#lightbox").hidden = true; if (lastFocus) lastFocus.focus(); }

  /* ---------- nav highlight ---------- */
  function spy() {
    if (!("IntersectionObserver" in window)) return;
    var links = {}; document.querySelectorAll("#navLinks a").forEach(function (a) { links[a.getAttribute("href").slice(1)] = a; });
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting && links[e.target.id]) Object.keys(links).forEach(function (k) { links[k].classList.toggle("on", k === e.target.id); }); }); }, { rootMargin: "-45% 0px -50% 0px" });
    Object.keys(links).forEach(function (id) { var s = document.getElementById(id); if (s) io.observe(s); });
  }

  /* ---------- boot ---------- */
  initTheme();
  $("#lbClose").addEventListener("click", closeLightbox);
  $("#lightbox").addEventListener("click", function (e) { if (e.target.id === "lightbox") closeLightbox(); });
  addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("#lightbox").hidden) closeLightbox(); });

  load().then(function (d) {
    var site = d.site || {};
    applySite(site);
    document.querySelectorAll("[data-section]").forEach(function (s) {
      var key = s.getAttribute("data-section");
      var data = key === "hero" ? site.tagline : key === "stats" ? site.stats : key === "contact" ? site.contact : key === "ai" ? (d.ai && d.ai.tools) : key === "play" ? (d.play && d.play.games) : d[key];
      var off = site.sections && site.sections[key] === false;
      s.hidden = off || !filled(data);
      if (s.hidden) return;
      if (key === "stats") render.stats(site);
      else if (key === "contact") render.contact(site);
      else if (key === "ai") render.ai(d.ai);
      else if (key === "play") render.play(d.play);
      else if (render[key]) render[key](data);
      if (key === "principles") render.eduLine(d.education);
    });
    // hide nav links for hidden sections
    document.querySelectorAll("#navLinks a").forEach(function (a) { var t = document.getElementById(a.getAttribute("href").slice(1)); if (!t || t.hidden) a.parentNode.hidden = true; });
    spy();
    renderMetrics(site);
  });
})();
