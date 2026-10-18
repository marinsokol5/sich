// ==UserScript==
// @name         sich: sietches on GitHub
// @namespace    https://github.com/marinsokol5/sich
// @version      0.2.0
// @description  Shows the sich layers of a GitHub repo you can access: in its sidebar, and their files in its file list.
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
//
// A check also saves every file path of each sietch (the list GitHub's "Go to file"
// uses), so base's "Folders and files" table can show the sietches' files and folders
// next to its own, in every folder, linking to them in the sietch.

(() => {
  "use strict";

  const ID = "sich-sietches";
  const KEY = "sich-sietches:"; // + lowercase owner/repo
  const MAX_PAGES = 10;
  const RATE_LIMITED = "GitHub rate limit, try again in a minute";

  // Primer octicons, 16px.
  const ICONS = {
    repo: "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z",
    lock: "M4 4a4 4 0 0 1 8 0v2h.25c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-5.5C2 6.784 2.784 6 3.75 6H4Zm8.25 3.5h-8.5a.25.25 0 0 0-.25.25v5.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25ZM10.5 6V4a2.5 2.5 0 1 0-5 0v2Z",
    sync: "M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z",
    file: "M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z",
    "file-directory-fill": "M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z",
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
#${ID} li svg { flex: none; color: var(--fgColor-muted, #59636e); }
tr[data-sich-row] .react-directory-filename-cell { display: flex; align-items: center; min-width: 0; }
tr[data-sich-row] .react-directory-truncate { flex: 0 1 auto; min-width: 0; }
tr[data-sich-row] .sich-from { display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; font-size: 12px; flex: 0 100000 auto; min-width: 12px; overflow: hidden; white-space: nowrap; }
tr[data-sich-row] .sich-from svg { flex: none; width: 12px; height: 12px; }
tr[data-sich-row] .sich-from span { overflow: hidden; text-overflow: ellipsis; }`;

  /** Repos being checked, and the last failure per repo; kept here so a re-rendered section still shows them. */
  const checking = new Set();
  const failures = new Map();

  /** owner/repo of the current page, from its URL. */
  function currentRepo() {
    const m = /^\/([^/]+)\/([^/]+)/.exec(location.pathname);
    return m ? `${m[1]}/${m[2]}` : null;
  }

  /** Folder the page lists ("" at the top), or null on pages without a folder; assumes a ref without "/". */
  function currentDir() {
    const [, , , kind, , ...path] = location.pathname.split("/");
    if (!kind) return "";
    if (kind !== "tree") return null;
    return path.filter(Boolean).map(decodeURIComponent).join("/");
  }

  /** The About section of the repo sidebar (not the copy GitHub shows on narrow screens). */
  function aboutSection() {
    const headings = [...document.querySelectorAll("h2")].filter((h) => h.textContent.trim() === "About");
    const heading = headings.find((h) => h.closest('[class*="PageLayout-Pane"]')) ?? headings.at(-1);
    return heading?.parentElement ?? null;
  }

  /** GitHub's "Folders and files" table, if the page has one. */
  function filesTable() {
    for (const table of document.querySelectorAll("table")) {
      const labelledBy = table.getAttribute("aria-labelledby");
      const label = table.getAttribute("aria-label") ?? (labelledBy && document.getElementById(labelledBy)?.textContent);
      if (label?.trim() === "Folders and files") return table;
    }
    return null;
  }

  // Entries are read on every page change (for the file table), so keep them parsed.
  const cache = new Map();
  addEventListener("storage", () => cache.clear()); // refreshed in another tab

  function load(repo) {
    const key = KEY + repo.toLowerCase();
    if (!cache.has(key)) {
      let entry = null;
      try {
        entry = JSON.parse(localStorage.getItem(key) ?? "null");
      } catch {
        // Unreadable: same as never checked.
      }
      cache.set(key, entry);
    }
    return cache.get(key);
  }

  function save(repo, entry) {
    const key = KEY + repo.toLowerCase();
    cache.set(key, entry);
    try {
      localStorage.setItem(key, JSON.stringify(entry));
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
      if (!res.ok) throw new Error(res.status === 429 ? RATE_LIMITED : `GitHub answered ${res.status}`);
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

  /** Every file path in `repo`'s default branch, from the list behind GitHub's "Go to file". */
  async function listFiles(repo) {
    const res = await fetch(`/${repo}/tree-list/HEAD`, { headers: { Accept: "application/json" } });
    if (res.status === 404) return []; // nothing pushed yet
    if (!res.ok) throw new Error(res.status === 429 ? RATE_LIMITED : `GitHub answered ${res.status} for ${repo}'s files`);
    const paths = (await res.json().catch(() => null))?.paths;
    if (!Array.isArray(paths)) throw new Error(`unexpected answer from GitHub for ${repo}'s files`);
    return paths;
  }

  async function check(repo) {
    if (checking.has(repo)) return;
    checking.add(repo);
    failures.delete(repo);
    repaint(repo);
    try {
      const sietches = await findSietches(repo);
      for (const s of sietches) s.paths = await listFiles(s.repo);
      save(repo, { checkedAt: Date.now(), sietches });
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

  function icon(name, extraClass = "") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", width: "16", height: "16", fill: "currentColor", "aria-hidden": "true" })) {
      svg.setAttribute(k, v);
    }
    svg.setAttribute("class", `octicon octicon-${name} ${extraClass}`.trim());
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICONS[name]);
    svg.append(path);
    return svg;
  }

  /** How a sietch is named on base's page: just its name when base's owner owns it too. */
  function sietchName(repo, sietch) {
    const [owner] = repo.split("/");
    const [sOwner, sName] = sietch.repo.split("/");
    return sOwner.toLowerCase() === owner.toLowerCase() ? sName : sietch.repo;
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
      const items = entry.sietches.map((s) =>
        el("li", {}, el("a", { href: `/${s.repo}`, title: s.repo }, icon(s.private ? "lock" : "repo"), sietchName(repo, s))),
      );
      body.append(el("ul", {}, ...items));
    }
  }

  function repaint(repo) {
    const section = document.getElementById(ID);
    if (section?.dataset.repo === repo) paint(section, repo);
  }

  function addStyle() {
    if (!document.getElementById(`${ID}-style`)) document.head.append(el("style", { id: `${ID}-style`, textContent: CSS }));
  }

  /** Puts the section right under About, once per page; GitHub re-renders and navigates without reloads. */
  function ensureSection() {
    const repo = currentRepo();
    const about = repo ? aboutSection() : null;
    const existing = document.getElementById(ID);
    if (!about) {
      existing?.remove();
      return;
    }
    if (existing?.dataset.repo === repo && existing.previousElementSibling === about) return;
    existing?.remove();
    addStyle();
    const section = createSection(repo, about);
    about.after(section);
    paint(section, repo);
  }

  /** GitHub's order: folders first, then by name (capitals first). */
  const byGitHubOrder = (a, b) => b.folder - a.folder || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  /** What each saved sietch has directly in `dir`, sorted like GitHub's list. */
  function sietchEntries(entry, dir) {
    const prefix = dir ? `${dir}/` : "";
    const entries = [];
    for (const sietch of entry.sietches) {
      const names = new Map(); // name -> is a folder
      for (const path of sietch.paths ?? []) {
        if (!path.startsWith(prefix) || path.startsWith(".sich/")) continue;
        const [name, ...rest] = path.slice(prefix.length).split("/");
        names.set(name, names.get(name) || rest.length > 0);
      }
      for (const [name, folder] of names) entries.push({ sietch, name, path: prefix + name, folder });
    }
    return entries.sort(byGitHubOrder);
  }

  /** Base's own rows in the file table. */
  function baseRows(table) {
    return [...table.querySelectorAll("tr.react-directory-row:not([data-sich-row])")].map((row) => ({
      row,
      name: row.querySelector("a")?.textContent ?? "",
      folder: !!row.querySelector(".octicon-file-directory-fill, .icon-directory"),
    }));
  }

  /** A copy of one of GitHub's rows, pointing at a sietch's file or folder. */
  function sietchRow(template, repo, e, stamp) {
    const row = template.cloneNode(true);
    row.removeAttribute("id");
    row.dataset.sichRow = stamp;
    const href = `/${e.sietch.repo}/${e.folder ? "tree" : "blob"}/HEAD/${e.path.split("/").map(encodeURIComponent).join("/")}`;
    const nameCells = [...row.cells].filter((c) => c.className.includes("name-cell"));
    for (const cell of nameCells.length ? nameCells : [row.cells[0]]) {
      cell.querySelector("svg")?.replaceWith(e.folder ? icon("file-directory-fill", "icon-directory") : icon("file", "color-fg-muted"));
      const a = cell.querySelector("a");
      if (!a) continue;
      Object.assign(a, { href, title: e.name, textContent: e.name });
      a.setAttribute("aria-label", `${e.name}, (${e.folder ? "Directory" : "File"}, in sietch ${e.sietch.repo})`);
      // Which sietch it's in, next to the name: the only column that's wide on every screen.
      // Outside GitHub's truncating wrapper, so on narrow screens it shrinks before the name does.
      const from = el("a", { className: "Link--secondary sich-from", href: `/${e.sietch.repo}`, title: `In sietch ${e.sietch.repo}` });
      from.append(icon(e.sietch.private ? "lock" : "repo"), el("span", { textContent: sietchName(repo, e.sietch) }));
      (a.closest(".react-directory-truncate") ?? a).after(from);
    }
    // No commit or date to show for it.
    for (const cell of row.cells) if (!nameCells.includes(cell)) cell.replaceChildren();
    return row;
  }

  /** Which rows are in the table now: redone when the folder, the saved check or GitHub's table changes. */
  let shown = { stamp: "", table: null, count: 0 };

  /** Adds the sietches' files and folders in the current folder to base's file table. */
  function ensureRows() {
    const repo = currentRepo();
    const dir = currentDir();
    const table = repo && dir !== null ? filesTable() : null;
    const entry = table ? load(repo) : null;
    const stamp = entry ? `${repo}:${dir}:${entry.checkedAt}` : "";
    const ours = [...document.querySelectorAll("tr[data-sich-row]")];
    const intact = ours.every((r) => r.dataset.sichRow === stamp && table?.contains(r));
    if (stamp === shown.stamp && table === shown.table && ours.length === shown.count && intact) return;

    ours.forEach((r) => r.remove());
    shown = { stamp, table, count: 0 };
    if (!stamp) return;
    const base = baseRows(table);
    if (!base.length) {
      shown.stamp = ""; // GitHub hasn't filled the table yet: try again on the next change
      return;
    }
    const taken = new Set(base.map((b) => b.name)); // e.g. a folder both base and a sietch have
    const viewAll = table.querySelector('tr[data-testid="view-all-files-row"]');
    addStyle();
    for (const e of sietchEntries(entry, dir)) {
      if (taken.has(e.name)) continue;
      const template = base.find((b) => b.folder === e.folder)?.row ?? base[0].row;
      const row = sietchRow(template, repo, e, stamp);
      const next = base.find((b) => byGitHubOrder(b, e) > 0)?.row ?? viewAll;
      if (next) next.before(row);
      else base[0].row.parentElement.append(row);
      shown.count++;
    }
  }

  function ensure() {
    ensureSection();
    ensureRows();
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
