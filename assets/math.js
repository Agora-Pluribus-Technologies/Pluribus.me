// KaTeX-based math rendering shared by the editor preview and the
// published-site templates.
//
// Supported syntax:
//   $inline math$          -> rendered inline
//   $$display math$$       -> rendered as a block
//
// Math is lifted out of the markdown source BEFORE marked.parse so that
// LaTeX characters like \, _, *, ^ are not interpreted as Markdown
// formatting. Each expression is replaced with a placeholder token; after
// marked + DOMPurify run, restoreMath swaps the placeholders for the
// pre-rendered KaTeX HTML.
//
// Limitations:
//   - Math inside fenced code blocks and inline code spans is left intact.
//   - \ce{} chemistry syntax is intentionally NOT supported in v1
//     (requires the mhchem extension; deferred).

(function (root) {
  const KATEX_VERSION = "0.16.11";
  const KATEX_CSS = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.css`;
  const KATEX_JS = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.js`;

  // $$ ... $$, non-greedy, may span newlines.
  const DISPLAY_REGEX_SRC = /\$\$([\s\S]+?)\$\$/.source;
  // $ ... $ inline. Disallow $ before/after a word char (so prices like $5,
  // and \$ escapes, don't trigger), and disallow whitespace immediately
  // adjacent to the delimiters (so `$ x $` and `$x $` don't match).
  const INLINE_REGEX_SRC = /(?<![\w\\])\$(?!\s|\$)([^$\n]+?)(?<!\s)\$(?!\w)/.source;

  const FENCE_REGEX_SRC = /^(```[\s\S]*?^```$|~~~[\s\S]*?^~~~$)/.source;
  const INLINE_CODE_REGEX_SRC = /(`+)([^`\n]+?)\1/.source;

  let katexLoadPromise = null;

  function containsMath(markdown) {
    if (!markdown || typeof markdown !== "string") return false;
    if (markdown.indexOf("$") < 0) return false;
    const segs = splitOutsideFences(markdown);
    for (const seg of segs) {
      const parts = splitOutsideInlineCode(seg);
      for (const part of parts) {
        if (new RegExp(DISPLAY_REGEX_SRC).test(part)) return true;
        if (new RegExp(INLINE_REGEX_SRC).test(part)) return true;
      }
    }
    return false;
  }

  function splitOutsideFences(markdown) {
    const out = [];
    let lastIdx = 0;
    let m;
    const re = new RegExp(FENCE_REGEX_SRC, "gm");
    while ((m = re.exec(markdown)) !== null) {
      if (m.index > lastIdx) out.push(markdown.slice(lastIdx, m.index));
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < markdown.length) out.push(markdown.slice(lastIdx));
    return out;
  }

  function splitOutsideInlineCode(text) {
    const out = [];
    let last = 0;
    let cm;
    const re = new RegExp(INLINE_CODE_REGEX_SRC, "g");
    while ((cm = re.exec(text)) !== null) {
      out.push(text.slice(last, cm.index));
      last = cm.index + cm[0].length;
    }
    out.push(text.slice(last));
    return out;
  }

  function loadKaTeX() {
    if (typeof window === "undefined") {
      return Promise.reject(new Error("KaTeX requires a browser environment"));
    }
    if (window.katex) return Promise.resolve(window.katex);
    if (katexLoadPromise) return katexLoadPromise;

    katexLoadPromise = new Promise((resolve, reject) => {
      // CSS — idempotent
      if (!document.querySelector(`link[data-agora-katex="css"]`)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = KATEX_CSS;
        link.setAttribute("data-agora-katex", "css");
        document.head.appendChild(link);
      }
      // JS — idempotent
      const existing = document.querySelector(`script[data-agora-katex="js"]`);
      if (existing) {
        existing.addEventListener("load", () => resolve(window.katex));
        existing.addEventListener("error", () => reject(new Error("Failed to load KaTeX")));
        if (window.katex) resolve(window.katex);
        return;
      }
      const script = document.createElement("script");
      script.src = KATEX_JS;
      script.async = true;
      script.setAttribute("data-agora-katex", "js");
      script.addEventListener("load", () => resolve(window.katex));
      script.addEventListener("error", () => reject(new Error("Failed to load KaTeX")));
      document.head.appendChild(script);
    });

    // Don't reset katexLoadPromise on failure so callers don't trigger
    // repeated network requests in re-render loops.
    return katexLoadPromise;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fallbackHtml(tex, displayMode) {
    const wrapped = displayMode ? `$$${tex}$$` : `$${tex}$`;
    const cls = displayMode
      ? "katex-fallback katex-fallback-display"
      : "katex-fallback katex-fallback-inline";
    return `<code class="${cls}">${escapeHtml(wrapped)}</code>`;
  }

  function renderTex(tex, displayMode) {
    if (typeof window === "undefined" || !window.katex) return null;
    // Collapse blank lines inside the math body. KaTeX rejects them as
    // "paragraph break in math mode", and Toast UI's WYSIWYG round-trip
    // tends to insert them between every line of a multi-line $$…$$ block.
    const normalized = tex.replace(/\n[\t ]*\n+/g, "\n");
    try {
      return window.katex.renderToString(normalized, {
        displayMode: !!displayMode,
        throwOnError: true,
        output: "htmlAndMathml",
        strict: "ignore",
      });
    } catch (e) {
      return null;
    }
  }

  // Replace math expressions in markdown with placeholder tokens. Returns
  // { markdown, placeholders } where the placeholders are alphanumeric tokens
  // that survive markdown parsing and DOMPurify sanitization. The caller is
  // expected to: marked.parse → DOMPurify.sanitize → restoreMath.
  //
  // Requires KaTeX to be loaded (call loadKaTeX() first). If not loaded, math
  // is left untouched.
  function preprocessMath(markdown) {
    if (!containsMath(markdown)) return { markdown, placeholders: [] };
    if (typeof window === "undefined" || !window.katex) {
      return { markdown, placeholders: [] };
    }

    const placeholders = [];
    let counter = 0;
    function makeToken(html, displayMode) {
      const id = `KATEXPLACEHOLDER${counter++}KATEXEND`;
      placeholders.push({ id, html, displayMode });
      return id;
    }

    // Walk segments, preserving fenced code blocks verbatim.
    const segs = [];
    let lastIdx = 0;
    let m;
    const fenceRe = new RegExp(FENCE_REGEX_SRC, "gm");
    while ((m = fenceRe.exec(markdown)) !== null) {
      if (m.index > lastIdx) {
        segs.push({ kind: "text", text: markdown.slice(lastIdx, m.index) });
      }
      segs.push({ kind: "code", text: m[0] });
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < markdown.length) {
      segs.push({ kind: "text", text: markdown.slice(lastIdx) });
    }

    const out = segs
      .map(s => (s.kind === "code" ? s.text : transformOutsideCodeSpans(s.text)))
      .join("");

    return { markdown: out, placeholders };

    function transformOutsideCodeSpans(text) {
      const codeRe = new RegExp(INLINE_CODE_REGEX_SRC, "g");
      let result = "";
      let last = 0;
      let cm;
      while ((cm = codeRe.exec(text)) !== null) {
        result += transform(text.slice(last, cm.index));
        result += cm[0];
        last = cm.index + cm[0].length;
      }
      result += transform(text.slice(last));
      return result;
    }

    function transform(text) {
      // Display math first so the inline regex doesn't eat one of the $'s.
      const displayRe = new RegExp(DISPLAY_REGEX_SRC, "g");
      let after = text.replace(displayRe, (_, body) => {
        const html = renderTex(body.trim(), true);
        return html != null
          ? makeToken(html, true)
          : makeToken(fallbackHtml(body.trim(), true), true);
      });
      const inlineRe = new RegExp(INLINE_REGEX_SRC, "g");
      after = after.replace(inlineRe, (_, body) => {
        const html = renderTex(body, false);
        return html != null
          ? makeToken(html, false)
          : makeToken(fallbackHtml(body, false), false);
      });
      return after;
    }
  }

  // Swap placeholder tokens back to rendered HTML. Display-mode placeholders
  // wrapped alone in <p>...</p> are lifted into a <div class="math-display">
  // so they don't sit inside an empty paragraph.
  function restoreMath(html, placeholders) {
    if (!placeholders || placeholders.length === 0) return html;
    const map = {};
    const ids = [];
    for (const p of placeholders) {
      map[p.id] = p;
      ids.push(p.id);
    }
    const altPattern = ids.join("|");

    let out = html;
    // Lift display-mode tokens out of their wrapping paragraph if they're
    // the sole content of that paragraph.
    const wrappedRe = new RegExp(`<p>\\s*(${altPattern})\\s*</p>`, "g");
    out = out.replace(wrappedRe, (whole, id) => {
      const p = map[id];
      if (p && p.displayMode) return `<div class="math-display">${p.html}</div>`;
      return p ? p.html : whole;
    });

    // Replace remaining placeholders inline.
    const restRe = new RegExp(altPattern, "g");
    out = out.replace(restRe, id => {
      const p = map[id];
      // Use a function to sidestep $-replacement specials in the HTML.
      return p ? p.html : id;
    });
    return out;
  }

  // Toast UI's WYSIWYG round-trip mangles LaTeX in math regions in two ways:
  //   - The MARKDOWN PARSER consumes `\X` as a backslash escape when X is an
  //     ASCII-punctuation char (so `\{`, `\}`, `\[`, `\]`, `\_`, `\*`, `\\`,
  //     etc. lose their backslash entering WYSIWYG).
  //   - The MARKDOWN SERIALIZER escapes literal backslashes and markdown
  //     specials on the way out (`\` -> `\\`, `_` -> `\_`, ...).
  //
  // To survive round-trip, we double every backslash inside math regions
  // before handing markdown to Toast UI (so the parser still ends up with
  // the original char sequence in ProseMirror), and undo all the serializer
  // escapes on the way back.

  // Markdown specials that Toast UI's serializer is likely to re-escape
  // when emitting the WYSIWYG state back to markdown. `]` must be escaped
  // inside the char class so it doesn't close the bracket expression.
  const MD_ESCAPED_CHARS = "\\\\`*_{}\\[\\]()#+\\-.!~<>|";
  const ESCAPED_CHAR_RE = new RegExp("\\\\([" + MD_ESCAPED_CHARS + "])", "g");

  // Pre-escape: double every backslash in math regions so the markdown
  // parser preserves the original char (`\\` -> literal `\`) on its way to
  // ProseMirror state. Other characters are left alone — the serializer's
  // escapes on those round-trip via unescapeMathRoundTrip.
  function escapeMathForWysiwyg(markdown) {
    if (!markdown || typeof markdown !== "string") return markdown;
    if (markdown.indexOf("$") < 0) return markdown;
    return walkMathRegions(markdown, body => body.replace(/\\/g, "\\\\"));
  }

  // Reverse of the WYSIWYG round-trip. Inside each math region:
  //   1. Stash `\\` (literal-backslash escape) as a NUL sentinel.
  //   2. Strip remaining `\X` (markdown-spec escapes for `_`, `*`, `{`, etc.).
  //   3. Restore the sentinel as a single `\`.
  // The two-pass approach keeps `\\` from being mistaken for `\X`.
  function unescapeMathRoundTrip(markdown) {
    if (!markdown || typeof markdown !== "string") return markdown;
    if (markdown.indexOf("\\") < 0) return markdown;
    return walkMathRegions(markdown, unescapeBody);
  }

  function unescapeBody(body) {
    // 1. Stash escaped backslashes (`\\`) as a sentinel so step 2 leaves them alone.
    // 2. Strip serializer-added markdown escapes (`\X` -> `X`).
    // 3. Restore the sentinel as a single `\`.
    // 4. Convert <br> tags to LaTeX line breaks (`\\`). Toast UI turns
    //    a markdown `\\`-at-end-of-line hard break into a <br> when
    //    serializing the WYSIWYG state back to markdown; without this,
    //    multi-line `\begin{aligned}` blocks collapse onto a single row.
    return body
      .replace(/\\\\/g, " ")
      .replace(ESCAPED_CHAR_RE, "$1")
      .replace(/ /g, "\\")
      .replace(/<br\s*\/?>/gi, "\\\\");
  }

  // Apply `transform` only to the body of `$...$` and `$$...$$` regions,
  // skipping fenced code blocks and inline code spans entirely.
  function walkMathRegions(markdown, transform) {
    const segs = [];
    let lastIdx = 0;
    let m;
    const fenceRe = new RegExp(FENCE_REGEX_SRC, "gm");
    while ((m = fenceRe.exec(markdown)) !== null) {
      if (m.index > lastIdx) {
        segs.push({ kind: "text", text: markdown.slice(lastIdx, m.index) });
      }
      segs.push({ kind: "code", text: m[0] });
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < markdown.length) {
      segs.push({ kind: "text", text: markdown.slice(lastIdx) });
    }

    return segs
      .map(s => (s.kind === "code" ? s.text : walkOutsideCodeSpans(s.text, transform)))
      .join("");
  }

  function walkOutsideCodeSpans(text, transform) {
    const codeRe = new RegExp(INLINE_CODE_REGEX_SRC, "g");
    let result = "";
    let last = 0;
    let cm;
    while ((cm = codeRe.exec(text)) !== null) {
      result += transformMath(text.slice(last, cm.index), transform);
      result += cm[0];
      last = cm.index + cm[0].length;
    }
    result += transformMath(text.slice(last), transform);
    return result;
  }

  function transformMath(text, transform) {
    const displayRe = new RegExp(DISPLAY_REGEX_SRC, "g");
    let after = text.replace(displayRe, (_, body) => "$$" + transform(body) + "$$");
    const inlineRe = new RegExp(INLINE_REGEX_SRC, "g");
    after = after.replace(inlineRe, (_, body) => "$" + transform(body) + "$");
    return after;
  }

  const api = {
    KATEX_CSS,
    KATEX_JS,
    containsMath,
    loadKaTeX,
    preprocessMath,
    restoreMath,
    escapeMathForWysiwyg,
    unescapeMathRoundTrip,
  };

  root.AgoraMath = api;
})(typeof window !== "undefined" ? window : globalThis);
