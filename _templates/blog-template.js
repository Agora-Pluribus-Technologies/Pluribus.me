// Global state for filtering and pagination
let allPosts = [];
let currentSearchQuery = "";
let currentTagFilter = "";
let currentPage = 1;
const POSTS_PER_PAGE = 10;
// Batched pages.json: per-batch lists of page-info entries. Element 0 is
// the newest batch (sorted by modifiedAt desc by the publish flow). Posts
// are fetched lazily, one batch at a time, as the user paginates.
let postBatches = [];
// Per-batch loaded markdown promises; reused if the user re-navigates.
let batchLoadPromises = [];
// Loaded post objects, indexed parallel to postBatches.
let loadedBatches = [];
// Per-post cache shared by every load path (batch loads on default browse,
// individual fetches on title search). Lookup key is the page fileName.
let loadedPosts = new Map();
// Stashed at first loadBlogPosts call so pagination/filter handlers can
// trigger additional batch loads without re-threading through events.
let blogOrigin = "";
let blogBasePath = "";
// Tag inverted index loaded from public/tags.json: { tag: [postFileName, ...] }
let tagsIndex = {};
// Map<postFileName, batchIdx> built once from postBatches so tag-click can
// look up which batch each result lives in without rescanning.
let postBatchByFileName = new Map();

document.addEventListener("DOMContentLoaded", async function () {
  const origin = document.location.origin;

  // Determine base path
  let basePath;
  if (
    document.location.origin.includes("agorapages.com") ||
    document.location.origin.includes("pluribus-me.pages.dev")
  ) {
    basePath = document.location.pathname.split("/").slice(0, 4).join("/");
  } else {
    basePath = "";
  }

  const pagesJson = await fetchPagesJson(origin, basePath);
  const siteJson = await fetchSiteJson(origin, basePath);
  const tagsJson = await fetchTagsJson(origin, basePath);
  const siteName = siteJson ? (siteJson.displayName || siteJson.siteName) : "Blog";

  document.title = siteName + " \u2022 AgoraPages";

  tagsIndex = (tagsJson && tagsJson.tags && typeof tagsJson.tags === "object")
    ? tagsJson.tags
    : {};

  createBlogHeader(siteName);
  await loadBlogPosts(origin, basePath, pagesJson);
  createFooter(origin, basePath, siteName);
});

async function fetchTagsJson(origin, basePath) {
  try {
    const response = await fetch(`${origin}${basePath}/tags.json`, {
      method: "GET",
      headers: { "Cache-Control": "no-cache, must-revalidate" },
    });
    if (response.ok) return await response.json();
  } catch (e) {
    // tags.json is optional \u2014 older blog sites may not have one yet.
  }
  return null;
}

async function fetchSiteJson(origin, basePath) {
  const siteJsonLink = `${origin}${basePath}/site.json`;
  try {
    const response = await fetch(siteJsonLink, {
      method: "GET",
      headers: {
        "Cache-Control": "no-cache, must-revalidate",
      },
    });
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.error("Error fetching site.json:", error);
  }
  return null;
}

async function fetchPagesJson(origin, basePath) {
  const pagesJsonLink = `${origin}${basePath}/pages.json`;
  try {
    const response = await fetch(pagesJsonLink, {
      method: "GET",
      headers: {
        "Cache-Control": "no-cache, must-revalidate",
      },
    });
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.error("Error fetching pages.json:", error);
  }
  return [];
}

function createBlogHeader(siteName) {
  const header = document.createElement("header");
  header.className = "blog-header";

  const h1 = document.createElement("h1");
  h1.textContent = siteName;
  header.appendChild(h1);

  // Search bar
  const searchContainer = document.createElement("div");
  searchContainer.className = "search-container";

  const searchIcon = document.createElement("span");
  searchIcon.className = "search-icon";
  searchIcon.innerHTML = "&#x1F50D;";

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.id = "blogSearchInput";
  searchInput.className = "search-input";
  searchInput.placeholder = "Search posts...";
  searchInput.addEventListener("input", handleSearchInput);

  const clearBtn = document.createElement("button");
  clearBtn.className = "search-clear";
  clearBtn.id = "searchClearBtn";
  clearBtn.innerHTML = "&times;";
  clearBtn.style.display = "none";
  clearBtn.addEventListener("click", clearSearch);

  searchContainer.appendChild(searchIcon);
  searchContainer.appendChild(searchInput);
  searchContainer.appendChild(clearBtn);
  header.appendChild(searchContainer);

  document.body.appendChild(header);
}

function handleSearchInput(e) {
  currentSearchQuery = e.target.value.toLowerCase().trim();
  const clearBtn = document.getElementById("searchClearBtn");
  if (clearBtn) {
    clearBtn.style.display = currentSearchQuery ? "block" : "none";
  }
  applyFilters();
}

function clearSearch() {
  const searchInput = document.getElementById("blogSearchInput");
  const clearBtn = document.getElementById("searchClearBtn");
  if (searchInput) {
    searchInput.value = "";
    currentSearchQuery = "";
  }
  if (clearBtn) {
    clearBtn.style.display = "none";
  }
  applyFilters();
}

// Normalize whatever shape pages.json arrives in into a list of batches
// (each batch is an array of page-info entries). Legacy pages.json files
// arrive as a flat array; the new blog shape is { blog, batches: [...] }.
function normalizePagesJsonToBatches(pagesJson) {
  if (!pagesJson) return [];
  if (Array.isArray(pagesJson)) {
    // Legacy flat array — sort by modifiedAt (or createdAt) desc and split
    // into batches of POSTS_PER_PAGE.
    const sorted = pagesJson.slice().sort((a, b) => {
      const ad = new Date(a.modifiedAt || a.createdAt || 0).getTime();
      const bd = new Date(b.modifiedAt || b.createdAt || 0).getTime();
      return bd - ad;
    });
    const out = [];
    for (let i = 0; i < sorted.length; i += POSTS_PER_PAGE) {
      out.push(sorted.slice(i, i + POSTS_PER_PAGE));
    }
    return out;
  }
  if (Array.isArray(pagesJson.batches)) {
    return pagesJson.batches;
  }
  return [];
}

async function loadBlogPosts(origin, basePath, pagesJson) {
  blogOrigin = origin;
  blogBasePath = basePath;
  marked.setOptions({
    gfm: true,
    breaks: true,
  });

  // Create tag filter bar container (will be populated after first batch loads)
  const tagFilterContainer = document.createElement("div");
  tagFilterContainer.id = "tagFilterContainer";
  document.body.appendChild(tagFilterContainer);

  // Create blog feed container
  const feedContainer = document.createElement("main");
  feedContainer.className = "blog-feed";
  feedContainer.id = "blogFeed";
  feedContainer.innerHTML = '<div class="loading-posts">Loading posts...</div>';
  document.body.appendChild(feedContainer);

  postBatches = normalizePagesJsonToBatches(pagesJson);
  batchLoadPromises = new Array(postBatches.length).fill(null);
  loadedBatches = new Array(postBatches.length).fill(null);
  rebuildPostBatchByFileName();

  if (postBatches.length === 0) {
    feedContainer.innerHTML = '<div class="no-posts">No posts yet.</div>';
    return;
  }

  // Tag filter bar is populated from tags.json (already fetched), not from
  // post bodies — so we can render it BEFORE any batches are loaded.
  refreshTagFilterBar(tagFilterContainer);

  // Load only the first batch on initial render — cheaper page weight,
  // faster time-to-first-paint, and lazy-loads more as the reader paginates.
  await loadBatch(0, origin, basePath);
  rebuildAllPostsFromLoadedBatches();

  currentPage = 1;
  renderCurrentPage();
}

// Fetch every post in a single batch sequentially (one network request at
// a time). Idempotent: a second call for the same batch reuses the
// in-flight or completed promise instead of refetching.
async function loadBatch(batchIndex, origin, basePath) {
  if (batchIndex < 0 || batchIndex >= postBatches.length) return [];
  if (batchLoadPromises[batchIndex]) return batchLoadPromises[batchIndex];

  const batch = postBatches[batchIndex];
  batchLoadPromises[batchIndex] = (async () => {
    const out = [];
    for (const page of batch) {
      // Search may have already loaded this individual post — reuse it
      // instead of refetching.
      const post = await loadSinglePost(page, origin, basePath);
      if (post) out.push(post);
    }
    loadedBatches[batchIndex] = out;
    return out;
  })();
  return batchLoadPromises[batchIndex];
}

// Fetch one post's markdown and parse it into the cache. Idempotent: if
// the post is already in `loadedPosts`, returns the cached version. Used
// by both batch loading (default browse) and per-post search loading.
async function loadSinglePost(page, origin, basePath) {
  if (!page || !page.fileName) return null;
  const cached = loadedPosts.get(page.fileName);
  if (cached) return cached;
  try {
    const mdUrl = `${origin}${basePath}/${page.fileName}.md`;
    const response = await fetch(mdUrl, {
      method: "GET",
      headers: { "Cache-Control": "no-cache, must-revalidate" },
    });
    if (response.ok) {
      const markdown = await response.text();
      const post = parsePostMarkdown(markdown, page, basePath);
      loadedPosts.set(page.fileName, post);
      return post;
    }
  } catch (e) {
    console.warn("Failed to load post:", page.fileName, e);
  }
  return null;
}

// Rebuild allPosts from loadedBatches in batch order. Posts already arrive
// sorted (newest first) because the publish flow batches by modifiedAt desc.
function rebuildAllPostsFromLoadedBatches() {
  const out = [];
  for (const batch of loadedBatches) {
    if (batch) out.push.apply(out, batch);
  }
  allPosts = out;
}

function refreshTagFilterBar(container) {
  const target = container || document.getElementById("tagFilterContainer");
  if (!target) return;
  // Source of truth is tags.json (the inverted index). It enumerates every
  // tag in the site without requiring any post bodies to be loaded.
  const allTags = new Set(Object.keys(tagsIndex || {}));
  createTagFilterBar(allTags, target);
  // Restore active state if the user already picked a tag.
  if (currentTagFilter) {
    target.querySelectorAll(".tag-filter").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tag === currentTagFilter);
    });
  }
}

// Build a fileName -> batchIdx lookup once postBatches is known. Used by
// the tag-filter render path to figure out which batch holds each match
// without rescanning postBatches per tag click.
function rebuildPostBatchByFileName() {
  postBatchByFileName = new Map();
  for (let bi = 0; bi < postBatches.length; bi++) {
    const batch = postBatches[bi];
    for (const page of batch) {
      postBatchByFileName.set(page.fileName, { page, batchIdx: bi });
    }
  }
}

function parsePostMarkdown(markdown, pageInfo, basePath) {
  // Parse frontmatter-style metadata from the markdown
  // Expected format at the start of the file:
  // ---
  // title: Post Title
  // date: 2024-01-15
  // tags: tag1, tag2, tag3
  // image: filename.webp
  // embed: https://youtube.com/watch?v=xxx
  // ---
  // Body content here...

  let title = pageInfo.displayName || "Untitled";
  let date = null;
  let tags = [];
  let image = null;
  let embed = null;
  let body = markdown;

  // Check for frontmatter
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1];
    body = frontmatterMatch[2];

    // Parse frontmatter fields
    const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
    if (titleMatch) title = titleMatch[1].trim();

    const dateMatch = frontmatter.match(/^date:\s*(.+)$/m);
    if (dateMatch) date = dateMatch[1].trim();

    const tagsMatch = frontmatter.match(/^tags:\s*(.+)$/m);
    if (tagsMatch) {
      const raw = tagsMatch[1].trim();
      if (raw.includes("#")) {
        // Hashtag format: #tag1 #tag2 #tag3
        tags = raw.split(/\s+/).map(t => t.replace(/^#/, "").trim()).filter(t => t);
      } else {
        // Legacy comma format: tag1, tag2, tag3
        tags = raw.split(",").map(t => t.trim()).filter(t => t);
      }
    }

    const imageMatch = frontmatter.match(/^image:\s*(.+)$/m);
    if (imageMatch) image = imageMatch[1].trim();

    const embedMatch = frontmatter.match(/^embed:\s*(.+)$/m);
    if (embedMatch) embed = embedMatch[1].trim();
  }

  return {
    title,
    date,
    tags,
    image,
    embed,
    body,
    fileName: pageInfo.fileName,
  };
}

function createTagFilterBar(allTags, container) {
  container.innerHTML = "";

  if (allTags.size === 0) {
    return;
  }

  const tagBar = document.createElement("div");
  tagBar.className = "tag-filter-bar collapsed";

  // Outside-click handler installed only while the bar is expanded.
  // Removed again on collapse so we don't leak listeners.
  function onOutsideClick(e) {
    if (!tagBar.contains(e.target)) {
      tagBar.classList.add("collapsed");
      document.removeEventListener("mousedown", onOutsideClick);
    }
  }

  const label = document.createElement("span");
  label.className = "tag-filter-label";
  label.innerHTML = 'Tags: <span class="chevron">&#x25BC;</span>';
  label.addEventListener("click", (e) => {
    // Don't let this click immediately bubble to the document handler we're
    // about to install — otherwise expand-then-collapse fires in one tick.
    e.stopPropagation();
    const wasCollapsed = tagBar.classList.toggle("collapsed");
    if (!wasCollapsed) {
      // Bar is now expanded — start listening for outside clicks.
      document.addEventListener("mousedown", onOutsideClick);
    } else {
      document.removeEventListener("mousedown", onOutsideClick);
    }
  });
  tagBar.appendChild(label);

  // "All" button
  const allBtn = document.createElement("span");
  allBtn.className = "tag-filter active";
  allBtn.textContent = "All";
  allBtn.dataset.tag = "";
  allBtn.addEventListener("click", () => handleTagClick(""));
  tagBar.appendChild(allBtn);

  // Individual tag buttons
  Array.from(allTags).sort().forEach(tag => {
    const tagBtn = document.createElement("span");
    tagBtn.className = "tag-filter";
    tagBtn.textContent = tag;
    tagBtn.dataset.tag = tag;
    tagBtn.addEventListener("click", () => handleTagClick(tag));
    tagBar.appendChild(tagBtn);
  });

  container.appendChild(tagBar);
}

function handleTagClick(tag) {
  // Clicking the currently-active tag clears the filter (back to "All"),
  // so a second click on the same tag toggles the filter off rather than
  // being a no-op.
  if (tag && tag === currentTagFilter) {
    tag = "";
  }
  currentTagFilter = tag;

  // Update active state on filter buttons
  document.querySelectorAll(".tag-filter").forEach(btn => {
    btn.classList.remove("active");
    if (btn.dataset.tag === tag) {
      btn.classList.add("active");
    }
  });

  applyFilters();
}

async function applyFilters() {
  currentPage = 1;
  // Both filters now consult metadata (tags.json + pages.json) and trigger
  // no upfront batch loads. The render path lazy-loads only the batches
  // containing the visible page of results.
  renderCurrentPage();
}

// Resolve a tag to { page, batchIdx } entries via tags.json + the
// pages.json fileName lookup. Returns matches in newest-first order
// (postBatches is already sorted by modifiedAt desc; we preserve that).
function getTagMatches(tag) {
  const fileNames = (tagsIndex && tagsIndex[tag]) || [];
  const matches = [];
  for (const fn of fileNames) {
    const entry = postBatchByFileName.get(fn);
    if (entry) matches.push(entry);
  }
  // tagsIndex stores fileNames alphabetically for git readability; sort
  // here by date so the rendered tag page reads newest-first.
  matches.sort((a, b) => {
    const ad = new Date(a.page.modifiedAt || a.page.createdAt || 0).getTime();
    const bd = new Date(b.page.modifiedAt || b.page.createdAt || 0).getTime();
    return bd - ad;
  });
  return matches;
}

// Walk pages.json metadata for posts whose displayName (the title) matches
// the search query. Returns { page, batchIdx } pairs in newest-first order.
// Doesn't trigger any batch loads — that's the whole point of metadata search.
function getMetadataSearchMatches() {
  if (!currentSearchQuery) return [];
  const matches = [];
  for (let bi = 0; bi < postBatches.length; bi++) {
    const batch = postBatches[bi];
    for (let pi = 0; pi < batch.length; pi++) {
      const page = batch[pi];
      const title = (page.displayName || "").toLowerCase();
      if (title.includes(currentSearchQuery)) {
        matches.push({ page, batchIdx: bi });
      }
    }
  }
  return matches;
}

// (Body-level filtering removed: tag filter now uses tags.json + lazy
// batch loads, and search is title-only via pages.json metadata. Neither
// path needs to inspect post bodies, so getFilteredPosts is gone.)

async function renderCurrentPage() {
  const feedContainer = document.getElementById("blogFeed");
  if (!feedContainer) return;

  // Three modes share the same paginated render at the bottom; the
  // difference is how `pagePosts` and `totalPages` are computed and which
  // batches need to be fetched first.
  let pagePosts;
  let totalPages;

  if (currentTagFilter) {
    // Tag filter is backed by tags.json (the inverted index) so we can
    // figure out which posts match without loading any bodies. We then
    // fetch only the batches that hold the current page of matches —
    // narrowing further by title if a search query is also active.
    let matches = getTagMatches(currentTagFilter);
    if (currentSearchQuery) {
      matches = matches.filter(m =>
        ((m.page.displayName || "").toLowerCase().includes(currentSearchQuery))
      );
    }
    totalPages = Math.max(1, Math.ceil(matches.length / POSTS_PER_PAGE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * POSTS_PER_PAGE;
    const pageMatches = matches.slice(start, start + POSTS_PER_PAGE);

    const neededBatches = Array.from(new Set(
      pageMatches.map(m => m.batchIdx).filter(idx => !loadedBatches[idx])
    ));
    if (neededBatches.length > 0) {
      feedContainer.innerHTML = '<div class="loading-posts">Loading posts...</div>';
      for (const idx of neededBatches) {
        await loadBatch(idx, blogOrigin, blogBasePath);
      }
      rebuildAllPostsFromLoadedBatches();
    }
    const byFileName = new Map(allPosts.map(p => [p.fileName, p]));
    pagePosts = pageMatches
      .map(m => byFileName.get(m.page.fileName))
      .filter(Boolean);
  } else if (currentSearchQuery) {
    // Title-only search via pages.json metadata. We fetch only the
    // matching posts themselves (one .md request each), not their whole
    // batch — keeps memory usage proportional to result count, not to
    // the size of any batch a result happens to live in.
    const matches = getMetadataSearchMatches();
    totalPages = Math.max(1, Math.ceil(matches.length / POSTS_PER_PAGE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * POSTS_PER_PAGE;
    const pageMatches = matches.slice(start, start + POSTS_PER_PAGE);

    const needLoad = pageMatches.filter(m => !loadedPosts.has(m.page.fileName));
    if (needLoad.length > 0) {
      feedContainer.innerHTML = '<div class="loading-posts">Loading posts...</div>';
      for (const m of needLoad) {
        await loadSinglePost(m.page, blogOrigin, blogBasePath);
      }
    }
    pagePosts = pageMatches
      .map(m => loadedPosts.get(m.page.fileName))
      .filter(Boolean);
  } else {
    // Default browse: pagination follows on-disk batch order, so loading
    // "page N" only requires loading batch N-1.
    const targetBatch = currentPage - 1;
    if (targetBatch >= 0 && targetBatch < postBatches.length && !loadedBatches[targetBatch]) {
      feedContainer.innerHTML = '<div class="loading-posts">Loading posts...</div>';
      await loadBatch(targetBatch, blogOrigin, blogBasePath);
      rebuildAllPostsFromLoadedBatches();
      refreshTagFilterBar();
    }
    totalPages = Math.max(1, postBatches.length);
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * POSTS_PER_PAGE;
    pagePosts = allPosts.slice(start, start + POSTS_PER_PAGE);
  }

  feedContainer.innerHTML = "";
  renderPosts(feedContainer, pagePosts);

  // Remove existing pagination
  const existing = document.getElementById("paginationContainer");
  if (existing) existing.remove();

  if (totalPages > 1) {
    const paginationDiv = document.createElement("div");
    paginationDiv.id = "paginationContainer";
    paginationDiv.className = "pagination";

    const prevBtn = document.createElement("button");
    prevBtn.className = "pagination-btn";
    prevBtn.textContent = "Previous";
    prevBtn.disabled = currentPage === 1;
    prevBtn.addEventListener("click", () => {
      if (currentPage > 1) {
        currentPage--;
        renderCurrentPage();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
    paginationDiv.appendChild(prevBtn);

    const pageInfo = document.createElement("span");
    pageInfo.className = "pagination-info";
    pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
    paginationDiv.appendChild(pageInfo);

    const nextBtn = document.createElement("button");
    nextBtn.className = "pagination-btn";
    nextBtn.textContent = "Next";
    nextBtn.disabled = currentPage === totalPages;
    nextBtn.addEventListener("click", () => {
      if (currentPage < totalPages) {
        currentPage++;
        renderCurrentPage();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
    paginationDiv.appendChild(nextBtn);

    feedContainer.after(paginationDiv);
  }
}

function renderPosts(container, posts) {
  if (posts.length === 0) {
    let message = "No posts found.";
    if (currentSearchQuery || currentTagFilter) {
      message = "No posts match your search.";
      if (currentTagFilter && !currentSearchQuery) {
        message = `No posts found with tag "${currentTagFilter}".`;
      }
    } else if (allPosts.length === 0) {
      message = "No posts yet.";
    }
    container.innerHTML = `<div class="no-posts">${message}</div>`;
    return;
  }

  // Determine base path for images
  let basePath;
  if (
    document.location.origin.includes("agorapages.com") ||
    document.location.origin.includes("pluribus-me.pages.dev")
  ) {
    basePath = document.location.pathname.split("/").slice(0, 4).join("/");
  } else {
    basePath = "";
  }

  posts.forEach(post => {
    const article = document.createElement("article");
    article.className = "blog-post";

    // Placeholder for featured media (rendered after all posts are in DOM)
    if (post.image || post.embed) {
      const mediaDiv = document.createElement("div");
      mediaDiv.className = "post-media deferred-media";
      if (post.embed) {
        mediaDiv.dataset.embed = post.embed;
      } else if (post.image) {
        mediaDiv.dataset.imageSrc = post.image.startsWith("http")
          ? post.image
          : `${basePath}/${post.image}`;
        mediaDiv.dataset.imageAlt = post.title;
      }
      article.appendChild(mediaDiv);
    }

    // Post content
    const contentDiv = document.createElement("div");
    contentDiv.className = "post-content";

    // Header with title and date
    const headerDiv = document.createElement("div");
    headerDiv.className = "post-header";

    const titleEl = document.createElement("h2");
    titleEl.className = "post-title";
    titleEl.textContent = post.title;
    headerDiv.appendChild(titleEl);

    if (post.date) {
      const dateEl = document.createElement("span");
      dateEl.className = "post-date";
      dateEl.textContent = formatDate(post.date);
      headerDiv.appendChild(dateEl);
    }

    contentDiv.appendChild(headerDiv);

    // Body
    const bodyDiv = document.createElement("div");
    bodyDiv.className = "post-body";

    // Clean up body and convert to HTML
    let bodyText = post.body.replace(/<br\s*\/?>/gi, "").trim();
    const parsedBody = marked.parse(bodyText);
    // Allow <iframe> in body sanitization so users can paste raw iframe
    // HTML directly into post bodies (the new embed syntax). The legacy
    // `language-embed` code-block path in processEmbeds still works for
    // backwards compatibility.
    let sanitizedBody = DOMPurify.sanitize(parsedBody, {
      ADD_TAGS: ["iframe"],
      ADD_ATTR: [
        "allow", "allowfullscreen", "frameborder", "referrerpolicy",
        "scrolling", "src", "width", "height", "sandbox",
      ],
      FORBID_TAGS: ["script", "style"],
      FORBID_ATTR: ["onerror", "onload"],
    });
    // Force our enforced sandbox onto every iframe BEFORE the HTML
    // enters the DOM — see injectIframeSandbox docs.
    sanitizedBody = injectIframeSandbox(sanitizedBody);
    bodyDiv.innerHTML = sanitizedBody;

    // Process images in body to use correct paths
    bodyDiv.querySelectorAll("img").forEach(img => {
      const src = img.getAttribute("src");
      if (src) {
        const sitePathMatch = src.match(/^\/s\/[^/]+\/[^/]+\/(.+)$/);
        if (sitePathMatch) {
          const imageFileName = sitePathMatch[1];
          img.setAttribute("src", `${basePath}/${imageFileName}`);
        }
      }
    });

    // Process embeds in body (legacy fenced syntax + raw <iframe> styling)
    processEmbeds(bodyDiv, basePath);
    // Apply non-security iframe styling (max-width + aspect ratio) to
    // every iframe — both legacy embed-block iframes and raw <iframe>
    // tags pasted into markdown directly. Sandbox enforcement happened
    // earlier via injectIframeSandbox (pre-DOM); this only sets styles.
    applyIframeStyles(bodyDiv);

    contentDiv.appendChild(bodyDiv);

    // Tags
    if (post.tags && post.tags.length > 0) {
      const tagsDiv = document.createElement("div");
      tagsDiv.className = "post-tags";

      post.tags.forEach(tag => {
        const tagSpan = document.createElement("span");
        tagSpan.className = "post-tag";
        tagSpan.textContent = tag;
        tagSpan.addEventListener("click", () => {
          handleTagClick(tag);
          // Scroll to top to see filtered results
          window.scrollTo({ top: 0, behavior: "smooth" });
        });
        tagsDiv.appendChild(tagSpan);
      });

      contentDiv.appendChild(tagsDiv);
    }

    article.appendChild(contentDiv);
    container.appendChild(article);
  });

  // Now render deferred media (images and embeds)
  container.querySelectorAll(".deferred-media").forEach(mediaDiv => {
    if (mediaDiv.dataset.embed) {
      mediaDiv.innerHTML = renderEmbed(mediaDiv.dataset.embed);
    } else if (mediaDiv.dataset.imageSrc) {
      const img = document.createElement("img");
      img.src = mediaDiv.dataset.imageSrc;
      img.alt = mediaDiv.dataset.imageAlt || "";
      mediaDiv.appendChild(img);
    }
    mediaDiv.classList.remove("deferred-media");
  });
}

function formatDate(dateStr) {
  try {
    const date = new Date(dateStr + "T00:00:00");
    if (isNaN(date.getTime())) return dateStr;
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function renderEmbed(embedContent) {
  // YouTube — sandbox baked into the tag so it's present BEFORE the
  // iframe enters the DOM. Setting sandbox after attachment doesn't
  // apply to the initial src navigation.
  if (embedContent.includes("youtube.com") || embedContent.includes("youtu.be")) {
    const videoId = extractYouTubeVideoId(embedContent);
    if (videoId) {
      return `<div class="embed-container"><iframe sandbox="allow-scripts allow-same-origin" width="560" height="315" src="https://www.youtube-nocookie.com/embed/${videoId}" frameborder="0" allowfullscreen></iframe></div>`;
    }
  }

  // SoundCloud
  if (embedContent.includes("soundcloud.com")) {
    const encodedUrl = encodeURIComponent(embedContent);
    return `<div class="embed-container"><iframe sandbox="allow-scripts allow-same-origin" width="100%" height="166" scrolling="no" frameborder="no" src="https://w.soundcloud.com/player/?url=${encodedUrl}&color=%23ff5500&auto_play=false"></iframe></div>`;
  }

  // Raw HTML embed — sanitize, then force our enforced sandbox via
  // injectIframeSandbox before the HTML enters the DOM.
  const sanitized = DOMPurify.sanitize(embedContent, {
    ADD_TAGS: ["iframe"],
    ADD_ATTR: ["allow", "allowfullscreen", "frameborder", "src", "width", "height", "sandbox"],
  });
  return `<div class="embed-container">${injectIframeSandbox(sanitized)}</div>`;
}

// Force our enforced sandbox onto every <iframe> in an HTML string. MUST
// run BEFORE the HTML is inserted into the DOM — calling
// setAttribute("sandbox", ...) after attachment doesn't apply to the
// initial src navigation (the dangerous race window). Always overwrites
// an existing sandbox attribute so a user with edit access can't bypass
// the sandbox by writing their own permissive value.
function injectIframeSandbox(html) {
  if (typeof html !== "string") return html;
  return html.replace(/<iframe\b([^>]*)>/gi, (_match, attrs) => {
    const cleaned = attrs.replace(/\s+sandbox\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return `<iframe${cleaned} sandbox="allow-scripts allow-same-origin">`;
  });
}

// Apply non-security iframe styling (max-width + aspect-ratio) after
// iframes are attached to the DOM. Sandbox enforcement happens earlier
// via injectIframeSandbox.
function applyIframeStyles(root) {
  if (!root) return;
  root.querySelectorAll("iframe").forEach((iframe) => {
    const w = iframe.width || 560;
    const h = iframe.height || 315;
    iframe.style.maxWidth = "90%";
    iframe.style.aspectRatio = `${w / h}`;
  });
}

function extractYouTubeVideoId(url) {
  // Constrain the capture to YouTube's canonical 11-char id format
  // ([A-Za-z0-9_-]{11}) so a malicious "URL" can't escape the iframe
  // src attribute when interpolated into HTML.
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtu\.be\/|youtube\.com\/v\/|youtube\.com\/watch\?[^#]*&v=)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/,
    /^([A-Za-z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = (url || "").match(pattern);
    if (match && /^[A-Za-z0-9_-]{11}$/.test(match[1])) return match[1];
  }
  return null;
}

function processEmbeds(container, basePath) {
  const preList = container.getElementsByTagName("pre");
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

    if (linkButtonContent) {
      const parts = linkButtonContent.split("|");
      const url = parts[0] || "";
      const label = parts[1] || "Link";
      // Reject any URL whose scheme isn't on the allowlist — see
      // isSafeButtonUrl below for the rationale.
      const safeUrl = isSafeButtonUrl(url) ? url : "#";
      const isExternal = safeUrl.startsWith("https://");
      const icon = isExternal ? "&#x1F310;" : "&#x1F517;";

      const buttonContainer = document.createElement("div");
      buttonContainer.className = "link-button-container";
      const linkButton = document.createElement("a");
      linkButton.href = safeUrl;
      linkButton.className = "link-button";
      if (isExternal) {
        linkButton.setAttribute("target", "_blank");
        linkButton.setAttribute("rel", "noopener noreferrer");
      }
      linkButton.innerHTML = `<span class="link-icon">${icon}</span> ${escapeHtml(label)}`;
      buttonContainer.appendChild(linkButton);
      pre.replaceWith(buttonContainer);
      continue;
    }

    if (pdfAttachment) {
      const filename = pdfAttachment;
      const fileUrl = `${basePath}/${filename}`;
      const isDocx = filename.toLowerCase().endsWith(".docx");
      const icon = isDocx ? "&#x1F4DD;" : "&#x1F4C4;";

      const downloadContainer = document.createElement("div");
      downloadContainer.className = "pdf-download-container";
      const downloadButton = document.createElement("a");
      downloadButton.href = fileUrl;
      downloadButton.className = "pdf-download-button";
      downloadButton.setAttribute("download", filename);
      downloadButton.setAttribute("target", "_blank");
      downloadButton.innerHTML = `<span class="pdf-icon">${icon}</span> Download ${escapeHtml(filename)}`;
      downloadContainer.appendChild(downloadButton);
      pre.replaceWith(downloadContainer);
      continue;
    }

    if (embedContent) {
      // Legacy fenced-embed syntax (```embed\n<URL or HTML>\n```). The
      // editor no longer emits this — new content uses raw <iframe> in
      // markdown directly. Kept here so existing published posts with
      // pre-migration content continue to render. Track in console so
      // we can see if/when this branch can be removed.
      console.warn("processEmbeds: legacy `language-embed` block detected — re-publish the post to convert to raw <iframe> markdown.");
      const embedHtml = renderEmbed(embedContent);
      const newDiv = document.createElement("div");
      newDiv.innerHTML = embedHtml;
      pre.replaceWith(newDiv.firstChild || newDiv);
    }
  }
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

function createFooter(origin, basePath, siteName) {
  const footer = document.createElement("footer");
  footer.classList.add("pluribus-footer");

  const footerRight = document.createElement("div");
  footerRight.className = "footer-right";

  const poweredBy = document.createElement("span");
  poweredBy.innerHTML =
    'Powered by <a href="https://agorapages.com" target="_blank">AgoraPages.com</a>';
  footerRight.appendChild(poweredBy);

  const themeToggle = document.createElement("button");
  themeToggle.classList.add("theme-toggle");
  themeToggle.id = "themeToggle";
  themeToggle.innerHTML = '<span id="themeIcon">&#x1F319;</span>';
  themeToggle.addEventListener("click", toggleTheme);
  themeToggle.addEventListener("mouseenter", showThemePreview);
  themeToggle.addEventListener("mouseleave", hideThemePreview);
  footerRight.appendChild(themeToggle);

  footer.appendChild(footerRight);

  document.body.appendChild(footer);
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
    icon.innerHTML = isLight ? "&#x2600;&#xFE0F;" : "&#x1F319;";
  }
}

function showThemePreview() {
  const icon = document.getElementById("themeIcon");
  if (icon) {
    const isCurrentlyLight = document.body.classList.contains("light-mode");
    icon.innerHTML = isCurrentlyLight ? "&#x1F319;" : "&#x2600;&#xFE0F;";
  }
}

function hideThemePreview() {
  const isCurrentlyLight = document.body.classList.contains("light-mode");
  updateThemeIcon(isCurrentlyLight);
}

// Initialize theme on page load
initTheme();
