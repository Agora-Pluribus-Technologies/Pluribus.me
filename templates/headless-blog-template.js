// Headless blog template - fetches content from a remote AgoraPages site
// Configure via <meta name="agora-source" content="https://agorapages.com/s/user/site">
// or via ?source= query parameter

// Global state for filtering and pagination
let allPosts = [];
let currentSearchQuery = "";
let currentTagFilter = "";
let currentPage = 1;
const POSTS_PER_PAGE = 10;
let sourceBaseUrl = "";
// Batched pages.json: posts are fetched lazily one batch at a time as the
// reader paginates, instead of all at once on page load.
let postBatches = [];
let batchLoadPromises = [];
let loadedBatches = [];
// Tag inverted index loaded from tags.json: { tag: [postFileName, ...] }
let tagsIndex = {};
// Map<postFileName, batchIdx> built from postBatches once on load.
let postBatchByFileName = new Map();

document.addEventListener("DOMContentLoaded", async function () {
  // Resolve source URL from meta tag or query param
  const params = new URLSearchParams(window.location.search);
  const metaTag = document.querySelector('meta[name="agora-source"]');
  const metaContent = metaTag ? metaTag.getAttribute("content") : "";

  sourceBaseUrl = params.get("source") || metaContent || "";

  // Strip trailing slash
  if (sourceBaseUrl.endsWith("/")) {
    sourceBaseUrl = sourceBaseUrl.slice(0, -1);
  }

  if (!sourceBaseUrl || sourceBaseUrl.includes("USERNAME/SITENAME")) {
    document.body.innerHTML =
      '<div style="text-align:center;padding:60px 20px;color:#888;font-size:16pt;">' +
      "No AgoraPages source configured.<br><br>" +
      'Set the <code>&lt;meta name="agora-source"&gt;</code> tag in the HTML,<br>' +
      "or pass <code>?source=https://agorapages.com/s/user/site</code> as a query parameter." +
      "</div>";
    return;
  }

  const pagesJson = await fetchPagesJson(sourceBaseUrl);
  const siteJson = await fetchSiteJson(sourceBaseUrl);
  const tagsJson = await fetchTagsJson(sourceBaseUrl);
  const siteName = siteJson ? (siteJson.displayName || siteJson.siteName) : "Blog";

  document.title = siteName + " \u2022 AgoraPages";

  tagsIndex = (tagsJson && tagsJson.tags && typeof tagsJson.tags === "object")
    ? tagsJson.tags
    : {};

  createBlogHeader(siteName);
  await loadBlogPosts(sourceBaseUrl, pagesJson);
  createFooter(sourceBaseUrl, siteName);
});

async function fetchTagsJson(sourceUrl) {
  try {
    const response = await fetch(`${sourceUrl}/tags.json`, {
      method: "GET",
      headers: { "Cache-Control": "no-cache, must-revalidate" },
    });
    if (response.ok) return await response.json();
  } catch (e) {
    // tags.json is optional \u2014 older blog sites may not have one yet.
  }
  return null;
}

async function fetchSiteJson(sourceUrl) {
  const siteJsonLink = `${sourceUrl}/site.json`;
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

async function fetchPagesJson(sourceUrl) {
  const pagesJsonLink = `${sourceUrl}/pages.json`;
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

async function loadBlogPosts(sourceUrl, pagesJson) {
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
  // faster time-to-first-paint, lazy-loads more as the reader paginates.
  await loadBatch(0, sourceUrl);
  rebuildAllPostsFromLoadedBatches();

  currentPage = 1;
  renderCurrentPage();
}

// Fetch every post in a single batch sequentially (one request at a time).
// Idempotent: a second call for the same batch reuses the in-flight or
// completed promise instead of refetching.
async function loadBatch(batchIndex, sourceUrl) {
  if (batchIndex < 0 || batchIndex >= postBatches.length) return [];
  if (batchLoadPromises[batchIndex]) return batchLoadPromises[batchIndex];

  const batch = postBatches[batchIndex];
  batchLoadPromises[batchIndex] = (async () => {
    const out = [];
    for (const page of batch) {
      try {
        const mdUrl = `${sourceUrl}/${page.fileName}.md`;
        const response = await fetch(mdUrl, {
          method: "GET",
          headers: { "Cache-Control": "no-cache, must-revalidate" },
        });
        if (response.ok) {
          const markdown = await response.text();
          out.push(parsePostMarkdown(markdown, page));
        }
      } catch (e) {
        console.warn("Failed to load post:", page.fileName, e);
      }
    }
    loadedBatches[batchIndex] = out;
    return out;
  })();
  return batchLoadPromises[batchIndex];
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

// Resolve a tag to { page, batchIdx } entries via tags.json. Sorted
// newest-first by modifiedAt for the rendered tag page.
function getTagMatches(tag) {
  const fileNames = (tagsIndex && tagsIndex[tag]) || [];
  const matches = [];
  for (const fn of fileNames) {
    const entry = postBatchByFileName.get(fn);
    if (entry) matches.push(entry);
  }
  matches.sort((a, b) => {
    const ad = new Date(a.page.modifiedAt || a.page.createdAt || 0).getTime();
    const bd = new Date(b.page.modifiedAt || b.page.createdAt || 0).getTime();
    return bd - ad;
  });
  return matches;
}

function parsePostMarkdown(markdown, pageInfo) {
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

  const label = document.createElement("span");
  label.className = "tag-filter-label";
  label.innerHTML = 'Tags: <span class="chevron">&#x25BC;</span>';
  label.addEventListener("click", () => {
    tagBar.classList.toggle("collapsed");
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

// Walk pages.json metadata for posts whose displayName (the title) matches
// the search query. Returns { page, batchIdx } pairs. Doesn't trigger any
// batch loads — that's the whole point of metadata search.
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

  // Three modes share the paginated render at the bottom; the difference
  // is how `pagePosts` and `totalPages` are computed and which batches
  // need to be fetched first.
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
        await loadBatch(idx, sourceBaseUrl);
      }
      rebuildAllPostsFromLoadedBatches();
    }
    const byFileName = new Map(allPosts.map(p => [p.fileName, p]));
    pagePosts = pageMatches
      .map(m => byFileName.get(m.page.fileName))
      .filter(Boolean);
  } else if (currentSearchQuery) {
    const matches = getMetadataSearchMatches();
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
        await loadBatch(idx, sourceBaseUrl);
      }
      rebuildAllPostsFromLoadedBatches();
    }
    const byFileName = new Map(allPosts.map(p => [p.fileName, p]));
    pagePosts = pageMatches
      .map(m => byFileName.get(m.page.fileName))
      .filter(Boolean);
  } else {
    const targetBatch = currentPage - 1;
    if (targetBatch >= 0 && targetBatch < postBatches.length && !loadedBatches[targetBatch]) {
      feedContainer.innerHTML = '<div class="loading-posts">Loading posts...</div>';
      await loadBatch(targetBatch, sourceBaseUrl);
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
          : `${sourceBaseUrl}/${post.image}`;
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
    const sanitizedBody = DOMPurify.sanitize(parsedBody);
    bodyDiv.innerHTML = sanitizedBody;

    // Process images in body to use correct remote paths
    bodyDiv.querySelectorAll("img").forEach(img => {
      const src = img.getAttribute("src");
      if (src) {
        // Rewrite /s/user/site/... paths to use the remote source
        const sitePathMatch = src.match(/^\/s\/[^/]+\/[^/]+\/(.+)$/);
        if (sitePathMatch) {
          const imageFileName = sitePathMatch[1];
          img.setAttribute("src", `${sourceBaseUrl}/${imageFileName}`);
        } else if (!src.startsWith("http") && !src.startsWith("data:")) {
          // Relative path - resolve against remote source
          img.setAttribute("src", `${sourceBaseUrl}/${src}`);
        }
      }
    });

    // Process embeds in body
    processEmbeds(bodyDiv);

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
  // YouTube
  if (embedContent.includes("youtube.com") || embedContent.includes("youtu.be")) {
    const videoId = extractYouTubeVideoId(embedContent);
    if (videoId) {
      return `<div class="embed-container"><iframe width="560" height="315" src="https://www.youtube-nocookie.com/embed/${videoId}" frameborder="0" allowfullscreen></iframe></div>`;
    }
  }

  // SoundCloud
  if (embedContent.includes("soundcloud.com")) {
    const encodedUrl = encodeURIComponent(embedContent);
    return `<div class="embed-container"><iframe width="100%" height="166" scrolling="no" frameborder="no" src="https://w.soundcloud.com/player/?url=${encodedUrl}&color=%23ff5500&auto_play=false"></iframe></div>`;
  }

  // Raw HTML embed
  const sanitized = DOMPurify.sanitize(embedContent, {
    ADD_TAGS: ["iframe"],
    ADD_ATTR: ["allow", "allowfullscreen", "frameborder", "src", "width", "height"],
  });
  return `<div class="embed-container">${sanitized}</div>`;
}

function extractYouTubeVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtu\.be\/|youtube\.com\/v\/|youtube\.com\/watch\?.*&v=)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function processEmbeds(container) {
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
      const isExternal = url.startsWith("https://");
      const icon = isExternal ? "&#x1F310;" : "&#x1F517;";

      const buttonContainer = document.createElement("div");
      buttonContainer.className = "link-button-container";
      const linkButton = document.createElement("a");
      linkButton.href = url;
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
      // Resolve document attachment URL against remote source
      const fileUrl = `${sourceBaseUrl}/${filename}`;
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

function createFooter(sourceUrl, siteName) {
  // Derive siteId and API origin from sourceUrl (e.g. https://agorapages.com/s/user/site)
  let siteId = "";
  let apiOrigin = "";
  try {
    const parsed = new URL(sourceUrl);
    apiOrigin = parsed.origin;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 3 && parts[0] === "s") {
      siteId = parts[1] + "/" + parts[2];
    }
  } catch {
    // Invalid URL, skip subscribe widget
  }

  const footer = document.createElement("footer");
  footer.classList.add("pluribus-footer");

  // Subscribe widget inside footer
  if (siteId) {
    const widget = document.createElement("div");
    widget.className = "subscribe-widget";
    widget.innerHTML = `
      <form class="subscribe-form" id="subscribeForm">
        <input type="email" class="subscribe-input" id="subscribeEmail" placeholder="Subscribe via email" required>
        <div id="subscribeTurnstile"></div>
        <button type="submit" class="subscribe-button" id="subscribeButton">Subscribe</button>
      </form>
      <span class="subscribe-status" id="subscribeStatus"></span>
    `;
    footer.appendChild(widget);
  }

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

  // Attach subscribe handler after footer is in DOM
  if (siteId) {
    const form = document.getElementById("subscribeForm");
    const emailInput = document.getElementById("subscribeEmail");
    const button = document.getElementById("subscribeButton");
    const status = document.getElementById("subscribeStatus");

    // Initialize invisible Turnstile widget for subscribe form
    let subscribeTurnstileToken = null;
    let subscribeTurnstileWidgetId = null;

    function initSubscribeTurnstile() {
      if (typeof turnstile === "undefined") {
        setTimeout(initSubscribeTurnstile, 200);
        return;
      }
      subscribeTurnstileWidgetId = turnstile.render("#subscribeTurnstile", {
        sitekey: "0x4AAAAAACJNWjSEPW9SeZxb",
        size: "invisible",
        callback: function (token) {
          subscribeTurnstileToken = token;
        },
        "expired-callback": function () {
          subscribeTurnstileToken = null;
        },
      });
    }
    initSubscribeTurnstile();

    async function getSubscribeTurnstileToken() {
      if (subscribeTurnstileToken) {
        const token = subscribeTurnstileToken;
        subscribeTurnstileToken = null;
        return token;
      }
      if (typeof turnstile !== "undefined" && subscribeTurnstileWidgetId !== null) {
        turnstile.reset(subscribeTurnstileWidgetId);
      }
      return new Promise((resolve) => {
        let attempts = 0;
        const check = setInterval(() => {
          attempts++;
          if (subscribeTurnstileToken) {
            clearInterval(check);
            const token = subscribeTurnstileToken;
            subscribeTurnstileToken = null;
            resolve(token);
          } else if (attempts >= 100) {
            clearInterval(check);
            resolve(null);
          }
        }, 100);
      });
    }

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const email = emailInput.value.trim();
      if (!email) return;

      button.disabled = true;
      button.textContent = "Subscribing...";
      status.textContent = "";
      status.className = "subscribe-status";

      try {
        const turnstileToken = await getSubscribeTurnstileToken();
        const headers = { "Content-Type": "application/json" };
        if (turnstileToken) {
          headers["X-Turnstile-Token"] = turnstileToken;
        }

        const response = await fetch(`${apiOrigin}/api/subscribers`, {
          method: "POST",
          headers,
          body: JSON.stringify({ siteId, email }),
        });

        const result = await response.json();

        if (response.ok) {
          status.textContent = result.message || "Check your email to confirm!";
          status.className = "subscribe-status subscribe-success";
          emailInput.value = "";
        } else {
          status.textContent = result.message || result.error || "Failed to subscribe.";
          status.className = "subscribe-status subscribe-error";
        }
      } catch (err) {
        status.textContent = "An error occurred.";
        status.className = "subscribe-status subscribe-error";
      } finally {
        button.disabled = false;
        button.textContent = "Subscribe";
      }
    });
  }

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
