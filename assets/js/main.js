/*
 * Renders the page from the JSON files in /data.
 * Each section stays hidden until its data file has entries, so the site
 * can go live empty and fill in one section at a time.
 */
(function () {
  "use strict";

  var DATA = ["site", "metrics", "experience", "caseStudies", "projects", "writing", "about"];
  var FILES = {
    site: "data/site.json",
    metrics: "data/metrics.json",
    experience: "data/experience.json",
    caseStudies: "data/case-studies.json",
    projects: "data/projects.json",
    writing: "data/writing.json",
    about: "data/about.json"
  };

  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null && text !== "") n.textContent = text;
    return n;
  }
  function get(obj, path) {
    return path.split(".").reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
  }
  function filled(v) {
    if (Array.isArray(v)) return v.length > 0;
    if (v && typeof v === "object") return Object.keys(v).some(function (k) { return filled(v[k]); });
    return v != null && v !== "" && v !== false;
  }
  function load(name) {
    return fetch(FILES[name], { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }
  function links(box, items) {
    (items || []).forEach(function (l) {
      if (!l || !l.url) return;
      var a = el("a", null, l.label || l.url);
      a.href = l.url;
      if (/^https?:/.test(l.url)) { a.target = "_blank"; a.rel = "noopener"; }
      box.appendChild(a);
    });
  }

  /* ---------- section renderers ---------- */
  var render = {
    metrics: function (items) {
      var box = $("#metrics");
      items.forEach(function (m) {
        var d = el("div", "metric");
        d.appendChild(el("span", "metric-value", m.value));
        d.appendChild(el("span", "metric-label", m.label));
        box.appendChild(d);
      });
    },
    experience: function (items) {
      var box = $("#experienceList");
      items.forEach(function (r) {
        var li = el("li", "role");
        li.appendChild(el("span", "role-when", r.period));
        var body = el("div");
        body.appendChild(el("h3", "role-title", r.title));
        body.appendChild(el("p", "role-org", r.org));
        if (filled(r.summary)) body.appendChild(el("p", "card-text", r.summary));
        if (filled(r.highlights)) {
          var ul = el("ul", "role-points");
          r.highlights.forEach(function (h) { ul.appendChild(el("li", null, h)); });
          body.appendChild(ul);
        }
        li.appendChild(body);
        box.appendChild(li);
      });
    },
    caseStudies: function (items) { cards($("#caseStudies"), items); },
    projects: function (items) { cards($("#projectsList"), items); },
    writing: function (items) {
      var box = $("#writingList");
      items.forEach(function (w) {
        var li = el("li");
        li.appendChild(el("span", "list-when", w.date));
        var body = el("div");
        var t = el("h3", "card-title");
        if (w.url) { var a = el("a", null, w.title); a.href = w.url; a.target = "_blank"; a.rel = "noopener"; t.appendChild(a); }
        else t.textContent = w.title;
        body.appendChild(t);
        if (filled(w.summary)) body.appendChild(el("p", "list-text", w.summary));
        li.appendChild(body);
        box.appendChild(li);
      });
    },
    about: function (about) {
      var body = $("#aboutBody");
      (about.paragraphs || []).forEach(function (p) { body.appendChild(el("p", null, p)); });
      var edu = $("#educationList");
      (about.education || []).forEach(function (e) {
        var li = el("li");
        li.appendChild(el("span", "list-when", e.year));
        li.appendChild(el("span", null, [e.degree, e.school].filter(Boolean).join(", ")));
        edu.appendChild(li);
      });
      if (filled(about.heading)) $("#about .section-title").textContent = about.heading;
    }
  };

  function cards(box, items) {
    items.forEach(function (c) {
      var d = el("article", "card");
      if (filled(c.meta)) d.appendChild(el("span", "card-meta", c.meta));
      d.appendChild(el("h3", "card-title", c.title));
      if (filled(c.problem)) d.appendChild(el("p", "card-text", c.problem));
      if (filled(c.approach)) d.appendChild(el("p", "card-text", c.approach));
      if (filled(c.result)) d.appendChild(el("p", "card-result", c.result));
      if (c.url) { var a = el("a", "card-link", c.linkLabel || "View"); a.href = c.url; a.target = "_blank"; a.rel = "noopener"; d.appendChild(a); }
      box.appendChild(d);
    });
  }

  /* ---------- site-wide bindings ---------- */
  function applySite(site) {
    site = site || {};
    document.querySelectorAll("[data-bind]").forEach(function (n) {
      var v = get({ site: site }, n.getAttribute("data-bind"));
      if (filled(v)) n.textContent = v;
    });
    document.querySelectorAll("[data-show]").forEach(function (n) {
      n.hidden = !filled(get({ site: site }, n.getAttribute("data-show")));
    });
    if (filled(site.name)) document.title = site.name + (filled(site.role) ? " · " + site.role : "");
    if (filled(site.summary)) document.querySelector('meta[name="description"]').content = site.summary;
    if (filled(site.photo)) { var img = $("#heroPhoto"); img.src = site.photo; img.alt = site.name || ""; }
    (site.tags || []).forEach(function (t) { $("#heroTags").appendChild(el("li", null, t)); });
    links($("#heroLinks"), site.links);
    links($("#contactLinks"), site.contact && site.contact.links);
    if (filled(site.updated)) $("#updated").textContent = "Updated " + site.updated;
    var titles = site.sectionTitles || {};
    Object.keys(titles).forEach(function (key) {
      var s = document.querySelector('[data-section="' + key + '"] .section-title');
      if (s && filled(titles[key])) s.textContent = titles[key];
    });
  }

  /* ---------- nav ---------- */
  function buildNav() {
    var ul = $("#navLinks");
    var visible = [].slice.call(document.querySelectorAll("[data-section][data-label]")).filter(function (s) { return !s.hidden; });
    visible.forEach(function (s) {
      var li = el("li"), a = el("a", null, s.getAttribute("data-label"));
      a.href = "#" + s.id;
      li.appendChild(a); ul.appendChild(li);
    });
    if (!("IntersectionObserver" in window)) return;
    var map = {};
    [].forEach.call(ul.querySelectorAll("a"), function (a) { map[a.getAttribute("href").slice(1)] = a; });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        Object.keys(map).forEach(function (id) { map[id].classList.toggle("is-active", id === e.target.id); });
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    visible.forEach(function (s) { io.observe(s); });
  }

  /* ---------- boot ---------- */
  Promise.all(DATA.map(load)).then(function (res) {
    var d = {};
    DATA.forEach(function (k, i) { d[k] = res[i]; });

    applySite(d.site);

    document.querySelectorAll("[data-section]").forEach(function (s) {
      var key = s.getAttribute("data-section");
      if (key === "hero") { s.hidden = !filled(d.site && d.site.name); return; }
      if (key === "contact") { s.hidden = !filled(d.site && d.site.contact); return; }
      var data = d[key];
      s.hidden = !filled(data);
      if (!s.hidden && render[key]) render[key](data);
    });

    buildNav();
  });
})();
