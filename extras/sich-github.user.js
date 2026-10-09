// ==UserScript==
// @name         sich: sietches on GitHub
// @namespace    https://github.com/marinsokol5/sich
// @version      0.1.0
// @description  Adds a Sietches section to a GitHub repo's sidebar: the sich layers of that repo you can access.
// @match        https://github.com/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/marinsokol5/sich
// @downloadURL  https://raw.githubusercontent.com/marinsokol5/sich/main/extras/sich-github.user.js
// @updateURL    https://raw.githubusercontent.com/marinsokol5/sich/main/extras/sich-github.user.js
// ==/UserScript==

// A sietch (sich layer) of base <owner>/<repo> is a GitHub repo with the topic `sietch`
// whose description links to https://github.com/<owner>/<repo> (`sich new --gh` sets
// both). Base itself carries no trace of its layers, so this script asks GitHub's own
// search, as you (with your github.com session), and only ever finds repos you can access.
// It never checks on its own: you click to check, and the result stays in localStorage
// until you click refresh.

(() => {
  "use strict";

  const ID = "sich-sietches";
  const KEY = "sich-sietches:"; // + lowercase owner/repo
  const MAX_PAGES = 10;

  // Primer octicons, 16px.
  const ICONS = {
    repo: "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z",
    lock: "M4 4a4 4 0 0 1 8 0v2h.25c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-5.5C2 6.784 2.784 6 3.75 6H4Zm8.25 3.5h-8.5a.25.25 0 0 0-.25.25v5.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25ZM10.5 6V4a2.5 2.5 0 1 0-5 0v2Z",
    sync: "M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z",
  };

  const CSS = `
#${ID} .sich-refresh { background: none; border: 0; margin: -4px; padding: 4px; line-height: 0; border-radius: var(--borderRadius-medium, 6px); color: var(--fgColor-muted, #59636e); cursor: pointer; }
#${ID} .sich-refresh:hover { background: var(--control-transparent-bgColor-hover, #818b981a); color: var(--fgColor-accent, #0969da); }
#${ID} .sich-refresh[disabled] { cursor: default; }
#${ID} .sich-refresh[disabled] svg { animation: sich-spin 1s linear infinite; }
@keyframes sich-spin { to { transform: rotate(360deg); } }
#${ID} .sich-note { color: var(--fgColor-muted, #59636e); font-size: 12px; line-height: 18px; }
#${ID} .sich-error { color: var(--fgColor-danger, #d1242f); font-size: 12px; line-height: 18px; margin-bottom: 8px; }
#${ID} .sich-check { background: none; border: 0; padding: 0; font: inherit; color: var(--fgColor-accent, #0969da); cursor: pointer; }
#${ID} .sich-check:hover, [data-a11y-link-underlines="true"] #${ID} .sich-check { text-decoration: underline; }
#${ID} ul { list-style: none; margin: 0; padding: 0; }
#${ID} li + li { margin-top: 8px; }
#${ID} li a { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: var(--fgColor-default, #1f2328); }
#${ID} li a:hover { color: var(--fgColor-accent, #0969da); text-decoration: none; }
#${ID} li svg { flex: none; color: var(--fgColor-muted, #59636e); }`;

  /** Repos being checked, and the last failure per repo; kept here so a re-rendered section still shows them. */
  const checking = new Set();
  const failures = new Map();

  /** owner/repo of the current page, from its URL. */
  function currentRepo() {
    const m = /^\/([^/]+)\/([^/]+)/.exec(location.pathname);
    return m ? `${m[1]}/${m[2]}` : null;
  }

  /** The About section of the repo sidebar (not the copy GitHub shows on narrow screens). */
  function aboutSection() {
    const headings = [...document.querySelectorAll("h2")].filter((h) => h.textContent.trim() === "About");
    const heading = headings.find((h) => h.closest('[class*="PageLayout-Pane"]')) ?? headings.at(-1);
    return heading?.parentElement ?? null;
  }

  function load(repo) {
    try {
      return JSON.parse(localStorage.getItem(KEY + repo.toLowerCase()) ?? "null");
    } catch {
      return null;
    }
  }

  function save(repo, entry) {
    try {
      localStorage.setItem(KEY + repo.toLowerCase(), JSON.stringify(entry));
    } catch {
      // Storage full or blocked: the result still shows until the page reloads.
    }
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const textOf = (html) => new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";

  /** Repos with the topic `sietch` whose description links to `repo`. */
  async function findSietches(repo) {
    const q = `topic:sietch "github.com/${repo}" in:description`;
    // The phrase search also matches longer names (github.com/o/repo-tools), so check the link exactly.
    const linksHere = new RegExp(`github\\.com/${escapeRe(repo)}(?:\\.git)?(?![\\w.-]*\\w)`, "i");
    const found = [];
    for (let page = 1, pages = 1; page <= Math.min(pages, MAX_PAGES); page++) {
      const params = new URLSearchParams({ q, type: "repositories", p: String(page) });
      const res = await fetch(`/search?${params}`, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(res.status === 429 ? "GitHub rate limit, try again in a minute" : `GitHub answered ${res.status}`);
      const search = (await res.json().catch(() => null))?.payload?.blackbirdSearchRoute;
      if (!search) throw new Error("unexpected answer from GitHub search");
      pages = search.page_count ?? 1;
      for (const r of search.results ?? []) {
        const { owner_login: owner, name } = r.repo?.repository ?? {};
        if (owner && name && linksHere.test(textOf(r.hl_trunc_description ?? ""))) {
          found.push({ repo: `${owner}/${name}`, private: !r.public });
        }
      }
    }
    return found;
  }

  async function check(repo) {
    if (checking.has(repo)) return;
    checking.add(repo);
    failures.delete(repo);
    repaint(repo);
    try {
      save(repo, { checkedAt: Date.now(), sietches: await findSietches(repo) });
    } catch (e) {
      failures.set(repo, e instanceof Error ? e.message : String(e));
    } finally {
      checking.delete(repo);
      repaint(repo);
    }
  }

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: "16", height: "16", fill: "currentColor", "aria-hidden": "true" })) {
      svg.setAttribute(k, v);
    }
    svg.setAttribute("class", `octicon octicon-${name}`);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICONS[name]);
    svg.append(path);
    return svg;
  }

  /** An empty section, with GitHub's own classes copied from the About section. */
  function createSection(repo, about) {
    const sectionClass = [...about.classList].filter((c) => !/HideWhenNarrow|^border-0$/.test(c)).join(" ");
    const aboutHeading = about.querySelector("h2");
    const heading = el("h2", { className: aboutHeading?.className ?? "" }, el("span", { textContent: "Sietches" }));
    Object.assign(heading.dataset, aboutHeading?.dataset); // data-variant="small" sizes it
    heading.style.cssText = "display: flex; align-items: center; justify-content: space-between;";
    const section = el("div", { id: ID, className: sectionClass }, heading, el("div", { className: "sich-body" }));
    section.dataset.repo = repo;
    return section;
  }

  /** Fills the section from storage and the check in progress, if any. */
  function paint(section, repo) {
    const entry = load(repo);
    const busy = checking.has(repo);
    const failure = failures.get(repo);
    const heading = section.querySelector("h2");
    const label = entry ? `Refresh (last checked ${new Date(entry.checkedAt).toLocaleString()})` : "Check for sietches";
    const refresh = el("button", { type: "button", className: "sich-refresh", title: label, disabled: busy }, icon("sync"));
    refresh.setAttribute("aria-label", label);
    refresh.addEventListener("click", () => check(repo));
    heading.querySelector(".sich-refresh")?.remove();
    heading.append(refresh);

    const body = section.querySelector(".sich-body");
    body.replaceChildren();
    if (failure) body.append(el("div", { className: "sich-error", textContent: `Couldn't check: ${failure}` }));
    if (!entry) {
      if (busy) body.append(el("div", { className: "sich-note", textContent: "Checking…" }));
      else {
        const start = el("button", { type: "button", className: "sich-check", textContent: "Check for sietches" });
        start.addEventListener("click", () => check(repo));
        body.append(el("div", { className: "sich-note" }, start));
      }
    } else if (!entry.sietches.length) {
      body.append(el("div", { className: "sich-note", textContent: "No sietches found" }));
    } else {
      const [owner] = repo.split("/");
      const items = entry.sietches.map((s) => {
        const [sOwner, sName] = s.repo.split("/");
        const name = sOwner.toLowerCase() === owner.toLowerCase() ? sName : s.repo;
        return el("li", {}, el("a", { href: `/${s.repo}`, title: s.repo }, icon(s.private ? "lock" : "repo"), name));
      });
      body.append(el("ul", {}, ...items));
    }
  }

  function repaint(repo) {
    const section = document.getElementById(ID);
    if (section?.dataset.repo === repo) paint(section, repo);
  }

  /** Puts the section right under About, once per page; GitHub re-renders and navigates without reloads. */
  function ensure() {
    const repo = currentRepo();
    const about = repo ? aboutSection() : null;
    const existing = document.getElementById(ID);
    if (!about) {
      existing?.remove();
      return;
    }
    if (existing?.dataset.repo === repo && existing.previousElementSibling === about) return;
    existing?.remove();
    if (!document.getElementById(`${ID}-style`)) document.head.append(el("style", { id: `${ID}-style`, textContent: CSS }));
    const section = createSection(repo, about);
    about.after(section);
    paint(section, repo);
  }

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      ensure();
    });
  }).observe(document.body, { childList: true, subtree: true });
  ensure();
})();
