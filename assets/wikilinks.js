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

    // Normalize: strip leading/trailing slashes and an optional .md extension
    // so [[page]] and [[page.md]] behave the same.
    const normalizedTarget = target
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.md$/i, "");
    const lowerTarget = normalizedTarget.toLowerCase();

    // 1. Exact fileName match (case-insensitive). An exact path always wins,
    //    so [[page]] with both "page" and "folder/page" resolves to "page".
    const exact = pages.find(p => (p.fileName || "").toLowerCase() === lowerTarget);
    if (exact) return exact;

    // 2. Unique basename match — accept omitted folder when unambiguous.
    //    Multiple pages sharing a basename require the folder prefix to
    //    disambiguate (no fallback resolution).
    const basenameMatches = pages.filter(p => {
      const fn = (p.fileName || "").toLowerCase();
      const base = fn.split("/").pop();
      return base === lowerTarget;
    });
    if (basenameMatches.length === 1) return basenameMatches[0];

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

  // Walk markdown and yield each [[...]] body found outside fenced code blocks
  // and inline code spans. The body is the raw target text (before any | alias).
  function extractWikilinkBodies(markdown) {
    const bodies = [];
    if (!markdown) return bodies;

    const fenceRegex = /^(```[\s\S]*?^```$|~~~[\s\S]*?^~~~$)/gm;
    const segments = [];
    let lastIdx = 0;
    let m;
    while ((m = fenceRegex.exec(markdown)) !== null) {
      if (m.index > lastIdx) {
        segments.push(markdown.slice(lastIdx, m.index));
      }
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < markdown.length) segments.push(markdown.slice(lastIdx));

    const codeSpanRegex = /(`+)([^`\n]+?)\1/g;
    for (const seg of segments) {
      let last = 0;
      let cm;
      const parts = [];
      while ((cm = codeSpanRegex.exec(seg)) !== null) {
        parts.push(seg.slice(last, cm.index));
        last = cm.index + cm[0].length;
      }
      parts.push(seg.slice(last));

      for (const part of parts) {
        const re = new RegExp(WIKILINK_INLINE_REGEX.source, "g");
        let wm;
        while ((wm = re.exec(part)) !== null) {
          bodies.push(wm[1]);
        }
      }
    }
    return bodies;
  }

  // Build a backlink index: for each page, list pages that link *to* it.
  // pages: [{ fileName, displayName }, ...] — fileName without "public/" or ".md"
  // getContent: (fileName) => markdown string (or null/undefined)
  // returns: { [targetFileName]: [{ fileName, displayName }, ...] }
  function buildBacklinkIndex(pages, getContent) {
    const index = {};
    if (!Array.isArray(pages) || typeof getContent !== "function") return index;

    for (const source of pages) {
      const content = getContent(source.fileName);
      if (!content) continue;

      const bodies = extractWikilinkBodies(content);
      const seenTargets = new Set();

      for (const body of bodies) {
        const { target } = parseWikilinkBody(body);
        const resolved = resolveWikilink(target, pages);
        if (!resolved) continue;
        if (resolved.fileName === source.fileName) continue; // skip self-links
        if (seenTargets.has(resolved.fileName)) continue;
        seenTargets.add(resolved.fileName);

        if (!index[resolved.fileName]) index[resolved.fileName] = [];
        index[resolved.fileName].push({
          fileName: source.fileName,
          displayName: source.displayName || source.fileName,
        });
      }
    }

    // Sort each list alphabetically by displayName for stable output.
    for (const key of Object.keys(index)) {
      index[key].sort((a, b) =>
        (a.displayName || a.fileName).localeCompare(b.displayName || b.fileName)
      );
    }

    return index;
  }

  // Choose the best replacement target text for a wikilink whose resolved
  // page was renamed. If the original wikilink wrote out the full path,
  // produce the new full path. If it used the basename and that basename is
  // still unique under the new layout, keep the basename style; otherwise
  // fall back to the new full path.
  function chooseRenamedTarget(originalTarget, oldFileName, newFileName, newPagesList) {
    const stripped = (originalTarget || "").replace(/\.md$/i, "").replace(/^\/+|\/+$/g, "");
    const lower = stripped.toLowerCase();
    const oldLower = (oldFileName || "").toLowerCase();
    const oldBase = (oldFileName || "").split("/").pop().toLowerCase();
    const newBase = (newFileName || "").split("/").pop();

    if (lower === oldLower) return newFileName;
    if (lower === oldBase) {
      const newBaseLower = newBase.toLowerCase();
      const matches = (newPagesList || []).filter(p => {
        const fn = (p.fileName || "").toLowerCase();
        return fn === newBaseLower || fn.split("/").pop() === newBaseLower;
      }).length;
      if (matches <= 1) return newBase;
    }
    return newFileName;
  }

  // Rewrite every [[...]] in `markdownCache` items whose resolved target was
  // renamed. `renameMap` is a Map<oldFileName, newFileName> keyed by the
  // pages.json-style fileName (no "public/" prefix, no ".md" suffix).
  // `oldPagesList` and `newPagesList` are the pre/post-rename page arrays in
  // the same shape pagesFromCache returns. Returns the number of items whose
  // content was modified.
  function rewriteWikilinkTargets(cacheItems, renameMap, oldPagesList, newPagesList) {
    if (!Array.isArray(cacheItems) || !renameMap || renameMap.size === 0) return 0;
    let modified = 0;

    for (const item of cacheItems) {
      const original = item.content || "";
      if (!original) continue;

      // Walk fenced code blocks vs prose so wikilinks inside code stay intact.
      const fenceRegex = /^(```[\s\S]*?^```$|~~~[\s\S]*?^~~~$)/gm;
      const segments = [];
      let lastIdx = 0;
      let m;
      while ((m = fenceRegex.exec(original)) !== null) {
        if (m.index > lastIdx) segments.push({ kind: "text", text: original.slice(lastIdx, m.index) });
        segments.push({ kind: "code", text: m[0] });
        lastIdx = m.index + m[0].length;
      }
      if (lastIdx < original.length) segments.push({ kind: "text", text: original.slice(lastIdx) });

      const updated = segments
        .map(seg => seg.kind === "code" ? seg.text : rewriteInline(seg.text))
        .join("");

      if (updated !== original) {
        item.content = updated;
        modified++;
      }
    }
    return modified;

    function rewriteInline(text) {
      // Carve out inline code spans first.
      const codeSpanRegex = /(`+)([^`\n]+?)\1/g;
      let out = "";
      let last = 0;
      let cm;
      while ((cm = codeSpanRegex.exec(text)) !== null) {
        out += rewriteWikilinks(text.slice(last, cm.index));
        out += cm[0];
        last = cm.index + cm[0].length;
      }
      out += rewriteWikilinks(text.slice(last));
      return out;
    }

    function rewriteWikilinks(text) {
      const re = new RegExp(WIKILINK_INLINE_REGEX.source, "g");
      return text.replace(re, (whole, body, alias) => {
        const { target, heading } = parseWikilinkBody(body);
        const oldResolved = resolveWikilink(target, oldPagesList);
        if (!oldResolved) return whole;

        const newFileName = renameMap.get(oldResolved.fileName);
        if (!newFileName || newFileName === oldResolved.fileName) return whole;

        const newTarget = chooseRenamedTarget(target, oldResolved.fileName, newFileName, newPagesList);
        const newBody = heading ? `${newTarget}#${heading}` : newTarget;
        return alias != null ? `[[${newBody}|${alias}]]` : `[[${newBody}]]`;
      });
    }
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
    extractWikilinkBodies,
    buildBacklinkIndex,
    chooseRenamedTarget,
    rewriteWikilinkTargets,
    WIKILINK_INLINE_REGEX,
    WIKILINK_TOKENIZE_REGEX,
  };

  // Expose globally for both editor and published-template contexts.
  root.AgoraWikilinks = api;
})(typeof window !== "undefined" ? window : globalThis);
