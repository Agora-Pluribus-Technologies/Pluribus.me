// Wikilink syntax handling shared by the editor and the published-site templates.
//
// Supported forms:
//   [[name]]                       -> link to page "name", display "name"
//   [[name|display text]]          -> link to page "name", display "display text"
//   [[name#heading]]               -> link to "name#heading", display "name > heading"
//   [[name#heading|display text]]  -> link to "name#heading", display "display text"
//
// `name` matches a page's fileName (with or without folder prefix). A bare
// name resolves to a unique page across the whole site; if multiple pages
// share that name a folder prefix disambiguates.

(function (root) {
  // Page list shape: array of { fileName, displayName, ... }
  // fileName is a slug like "research/transformers" (no .md, no leading slash).

  const WIKILINK_INLINE_REGEX = /\[\[([^\]\n|]+?)(?:\|([^\]\n]*))?\]\]/g;
  const WIKILINK_TOKENIZE_REGEX = /^\[\[([^\]\n|]+?)(?:\|([^\]\n]*))?\]\]/;

  function parseWikilinkBody(body) {
    // Split target and optional heading
    const hashIdx = body.indexOf("#");
    if (hashIdx >= 0) {
      return {
        target: body.slice(0, hashIdx).trim(),
        heading: body.slice(hashIdx + 1).trim(),
      };
    }
    return { target: body.trim(), heading: null };
  }

  function slugifyHeading(heading) {
    // GitHub-style heading anchors: lowercase, spaces -> dashes, drop most punctuation.
    return heading
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-");
  }

  function resolveWikilink(target, pages) {
    if (!target) return null;
    if (!Array.isArray(pages) || pages.length === 0) return null;

    const normalizedTarget = target.replace(/^\/+|\/+$/g, "");
    const lowerTarget = normalizedTarget.toLowerCase();

    // Exact fileName match (case-insensitive).
    let exact = pages.find(p => (p.fileName || "").toLowerCase() === lowerTarget);
    if (exact) return exact;

    // Match by basename (last path segment) — unique resolution only.
    const basenameMatches = pages.filter(p => {
      const fn = (p.fileName || "").toLowerCase();
      const base = fn.split("/").pop();
      return base === lowerTarget;
    });
    if (basenameMatches.length === 1) return basenameMatches[0];

    // Match by displayName (case-insensitive) — unique resolution only.
    const displayMatches = pages.filter(
      p => (p.displayName || "").toLowerCase() === lowerTarget
    );
    if (displayMatches.length === 1) return displayMatches[0];

    return null;
  }

  function buildWikilinkUrl(page, heading, basePath) {
    const fileName = page.fileName || "";
    const prefix = basePath || "";
    const url = `${prefix}/${fileName}`;
    if (heading) {
      return `${url}#${slugifyHeading(heading)}`;
    }
    return url;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderWikilinkHtml(rawTarget, alias, pages, basePath) {
    const { target, heading } = parseWikilinkBody(rawTarget);
    const page = resolveWikilink(target, pages);
    const display = (alias != null && alias !== "")
      ? alias
      : (heading ? `${target} > ${heading}` : target);

    if (!page) {
      return `<a class="wikilink wikilink-broken" data-target="${escapeHtml(rawTarget)}">${escapeHtml(display)}</a>`;
    }

    const url = buildWikilinkUrl(page, heading, basePath);
    return `<a class="wikilink" href="${escapeHtml(url)}">${escapeHtml(display)}</a>`;
  }

  // Pre-process markdown: split out fenced code blocks and inline code spans,
  // replace [[...]] with HTML <a> tags, then re-stitch. Keeps wikilinks out of
  // code regions where they should be literal text.
  function preprocessWikilinks(markdown, pages, basePath) {
    if (!markdown) return markdown;
    if (!Array.isArray(pages)) pages = [];

    // Split fenced code blocks first (``` or ~~~). Anything between fences is
    // preserved verbatim.
    const fenceRegex = /^(```[\s\S]*?^```$|~~~[\s\S]*?^~~~$)/gm;
    const segments = [];
    let lastIdx = 0;
    let m;
    while ((m = fenceRegex.exec(markdown)) !== null) {
      if (m.index > lastIdx) {
        segments.push({ kind: "text", text: markdown.slice(lastIdx, m.index) });
      }
      segments.push({ kind: "code", text: m[0] });
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < markdown.length) {
      segments.push({ kind: "text", text: markdown.slice(lastIdx) });
    }

    return segments
      .map(seg => (seg.kind === "code" ? seg.text : transformInline(seg.text, pages, basePath)))
      .join("");
  }

  function transformInline(text, pages, basePath) {
    // Carve out inline code spans (`...`) so wikilinks inside them stay literal.
    const codeSpanRegex = /(`+)([^`\n]+?)\1/g;
    let out = "";
    let last = 0;
    let cm;
    while ((cm = codeSpanRegex.exec(text)) !== null) {
      const before = text.slice(last, cm.index);
      out += before.replace(WIKILINK_INLINE_REGEX, (_, body, alias) =>
        renderWikilinkHtml(body, alias, pages, basePath)
      );
      out += cm[0];
      last = cm.index + cm[0].length;
    }
    const tail = text.slice(last);
    out += tail.replace(WIKILINK_INLINE_REGEX, (_, body, alias) =>
      renderWikilinkHtml(body, alias, pages, basePath)
    );
    return out;
  }

  // Normalize a markdownCache-style entry list into the page shape this module
  // expects. Strips "public/" prefix and ".md" suffix so fileName matches the
  // pages.json convention.
  function pagesFromCache(cache) {
    if (!Array.isArray(cache)) return [];
    return cache.map(c => ({
      fileName: (c.fileName || "")
        .replace(/^public\//, "")
        .replace(/\.md$/, ""),
      displayName: c.displayName || "",
    }));
  }

  // Detect a [[ trigger in the text immediately preceding the caret.
  // Returns { query, startOffset } where startOffset is relative to text.
  // Returns null if no active trigger (no [[ before caret, or [[ already
  // closed by ]] before the caret, or contains a newline in between).
  function findActiveWikilinkTrigger(text, caretOffset) {
    if (caretOffset <= 0) return null;
    const before = text.slice(0, caretOffset);
    const openIdx = before.lastIndexOf("[[");
    if (openIdx < 0) return null;
    const between = before.slice(openIdx + 2);
    if (between.includes("]]") || between.includes("\n")) return null;
    return { query: between, startOffset: openIdx };
  }

  function filterPagesByQuery(pages, query) {
    const q = (query || "").toLowerCase().trim();
    if (!q) return pages.slice(0, 8);
    const scored = [];
    for (const p of pages) {
      const fn = (p.fileName || "").toLowerCase();
      const dn = (p.displayName || "").toLowerCase();
      const base = fn.split("/").pop();
      let score = -1;
      if (base.startsWith(q)) score = 100 - base.length;
      else if (fn.startsWith(q)) score = 80 - fn.length;
      else if (dn.startsWith(q)) score = 70 - dn.length;
      else if (fn.includes(q)) score = 40;
      else if (dn.includes(q)) score = 30;
      if (score >= 0) scored.push({ page: p, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8).map(s => s.page);
  }

  const api = {
    parseWikilinkBody,
    resolveWikilink,
    buildWikilinkUrl,
    renderWikilinkHtml,
    preprocessWikilinks,
    pagesFromCache,
    findActiveWikilinkTrigger,
    filterPagesByQuery,
    slugifyHeading,
    WIKILINK_INLINE_REGEX,
    WIKILINK_TOKENIZE_REGEX,
  };

  // Expose globally for both editor and published-template contexts.
  root.AgoraWikilinks = api;
})(typeof window !== "undefined" ? window : globalThis);
