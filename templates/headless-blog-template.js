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
  const siteName = siteJson ? siteJson.siteName : "Blog";
  const showHistory = siteJson ? siteJson.showHistory : false;

  document.title = siteName;

  createBlogHeader(siteName);
  await loadBlogPosts(sourceBaseUrl, pagesJson);
  createFooter(sourceBaseUrl, showHistory);
});

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

async function loadBlogPosts(sourceUrl, pagesJson) {
  marked.setOptions({
    gfm: true,
    breaks: false,
  });

  // Create tag filter bar container (will be populated after loading posts)
  const tagFilterContainer = document.createElement("div");
  tagFilterContainer.id = "tagFilterContainer";
  document.body.appendChild(tagFilterContainer);

  // Create blog feed container
  const feedContainer = document.createElement("main");
  feedContainer.className = "blog-feed";
  feedContainer.id = "blogFeed";
  feedContainer.innerHTML = '<div class="loading-posts">Loading posts...</div>';
  document.body.appendChild(feedContainer);

  if (!pagesJson || pagesJson.length === 0) {
    feedContainer.innerHTML = '<div class="no-posts">No posts yet.</div>';
    return;
  }

  // Fetch all posts in parallel
  const postResults = await Promise.allSettled(
    pagesJson.map(async (page) => {
      const mdUrl = `${sourceUrl}/${page.fileName}.md`;
      const response = await fetch(mdUrl, {
        method: "GET",
        headers: {
          "Cache-Control": "no-cache, must-revalidate",
        },
      });
      if (response.ok) {
        const markdown = await response.text();
        return parsePostMarkdown(markdown, page);
      }
      return null;
    })
  );
  const posts = postResults
    .filter(r => r.status === "fulfilled" && r.value)
    .map(r => r.value);

  // Sort posts by date (newest first)
  posts.sort((a, b) => {
    const dateA = a.date ? new Date(a.date) : new Date(0);
    const dateB = b.date ? new Date(b.date) : new Date(0);
    return dateB - dateA;
  });

  // Store posts globally for filtering
  allPosts = posts;

  // Collect all unique tags
  const allTags = new Set();
  posts.forEach(post => {
    if (post.tags) {
      post.tags.forEach(tag => allTags.add(tag));
    }
  });

  // Create tag filter bar
  createTagFilterBar(allTags, tagFilterContainer);

  // Render first page of posts
  currentPage = 1;
  renderCurrentPage();
}

function parsePostMarkdown(markdown, pageInfo) {
  let title = pageInfo.displayName || "Untitled";
  let date = pageInfo.modifiedAt || pageInfo.createdAt || null;
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
      tags = tagsMatch[1].split(",").map(t => t.trim()).filter(t => t);
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

function applyFilters() {
  currentPage = 1;
  renderCurrentPage();
}

function getFilteredPosts() {
  let filteredPosts = allPosts;

  // Apply tag filter
  if (currentTagFilter) {
    filteredPosts = filteredPosts.filter(post =>
      post.tags && post.tags.includes(currentTagFilter)
    );
  }

  // Apply search filter
  if (currentSearchQuery) {
    filteredPosts = filteredPosts.filter(post => {
      const titleMatch = post.title.toLowerCase().includes(currentSearchQuery);
      const bodyMatch = post.body.toLowerCase().includes(currentSearchQuery);
      const tagMatch = post.tags && post.tags.some(tag =>
        tag.toLowerCase().includes(currentSearchQuery)
      );
      return titleMatch || bodyMatch || tagMatch;
    });
  }

  return filteredPosts;
}

function renderCurrentPage() {
  const feedContainer = document.getElementById("blogFeed");
  if (!feedContainer) return;

  const filteredPosts = getFilteredPosts();
  const totalPages = Math.max(1, Math.ceil(filteredPosts.length / POSTS_PER_PAGE));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * POSTS_PER_PAGE;
  const pagePosts = filteredPosts.slice(start, start + POSTS_PER_PAGE);

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
    const date = new Date(dateStr);
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

function createFooter(sourceUrl, showHistory) {
  const footer = document.createElement("footer");
  footer.classList.add("pluribus-footer");

  const poweredBy = document.createElement("span");
  poweredBy.innerHTML =
    'Powered by <a href="https://agorapages.com" target="_blank">AgoraPages.com</a>';
  footer.appendChild(poweredBy);

  if (showHistory) {
    const historyLink = document.createElement("span");
    historyLink.classList.add("history-link");
    historyLink.textContent = "View History";
    historyLink.addEventListener("click", function () {
      showHistoryModal(sourceUrl);
    });
    footer.appendChild(historyLink);
  }

  const themeToggle = document.createElement("button");
  themeToggle.classList.add("theme-toggle");
  themeToggle.id = "themeToggle";
  themeToggle.innerHTML = '<span id="themeIcon">&#x1F319;</span>';
  themeToggle.addEventListener("click", toggleTheme);
  themeToggle.addEventListener("mouseenter", showThemePreview);
  themeToggle.addEventListener("mouseleave", hideThemePreview);
  footer.appendChild(themeToggle);

  document.body.appendChild(footer);

  // Create history modal overlay
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

async function showHistoryModal(sourceUrl) {
  const overlay = document.getElementById("historyOverlay");
  const content = document.getElementById("historyContent");
  overlay.style.display = "flex";

  try {
    const response = await fetch(`${sourceUrl}/history.json`, {
      method: "GET",
      headers: {
        "Cache-Control": "no-cache, must-revalidate",
      },
    });

    if (response.ok) {
      const history = await response.json();
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
          html += `<div class="history-message">${escapeHtml(commit.message)}</div>`;
          html += `<div class="history-author">by ${escapeHtml(commit.author)}</div>`;

          if (commit.changes && commit.changes.length > 0) {
            html += `<div class="history-changes">`;
            for (const change of commit.changes) {
              const statusClass = `change-${change.status}`;
              const statusIcon =
                change.status === "added" ? "+" : change.status === "deleted" ? "−" : "~";
              html += `<div class="history-change-item ${statusClass}">`;
              html += `<span class="change-icon">${statusIcon}</span>`;
              html += `<span class="change-file">${escapeHtml(change.file)}</span>`;
              html += `</div>`;

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
    content.innerHTML = '<p style="color: #ff4444;">Failed to load history.</p>';
  }
}

function closeHistoryModal() {
  const overlay = document.getElementById("historyOverlay");
  overlay.style.display = "none";
}

// Theme toggle functionality
function initTheme() {
  const savedTheme = localStorage.getItem("pluribus-site-theme") || "dark";
  if (savedTheme === "light") {
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
