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
  const siteName = siteJson ? siteJson.siteName : "Blog";
  const showHistory = siteJson ? siteJson.showHistory : false;

  createBlogHeader(siteName);
  await loadBlogPosts(origin, basePath, pagesJson);
  createFooter(origin, basePath, showHistory);
});

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

  document.body.appendChild(header);
}

async function loadBlogPosts(origin, basePath, pagesJson) {
  marked.setOptions({
    gfm: true,
    breaks: false,
  });

  // Create blog feed container
  const feedContainer = document.createElement("main");
  feedContainer.className = "blog-feed";
  feedContainer.innerHTML = '<div class="loading-posts">Loading posts...</div>';
  document.body.appendChild(feedContainer);

  if (!pagesJson || pagesJson.length === 0) {
    feedContainer.innerHTML = '<div class="no-posts">No posts yet.</div>';
    return;
  }

  // Fetch all posts
  const posts = [];
  for (const page of pagesJson) {
    try {
      const mdUrl = `${origin}${basePath}/${page.fileName}.md`;
      const response = await fetch(mdUrl, {
        method: "GET",
        headers: {
          "Cache-Control": "no-cache, must-revalidate",
        },
      });

      if (response.ok) {
        const markdown = await response.text();
        const postData = parsePostMarkdown(markdown, page, basePath);
        posts.push(postData);
      }
    } catch (error) {
      console.error("Error fetching post:", page.fileName, error);
    }
  }

  // Sort posts by date (newest first)
  posts.sort((a, b) => {
    const dateA = a.date ? new Date(a.date) : new Date(0);
    const dateB = b.date ? new Date(b.date) : new Date(0);
    return dateB - dateA;
  });

  // Collect all unique tags
  const allTags = new Set();
  posts.forEach(post => {
    if (post.tags) {
      post.tags.forEach(tag => allTags.add(tag));
    }
  });

  // Create tag filter bar if there are tags
  if (allTags.size > 0) {
    createTagFilterBar(allTags, feedContainer, posts);
  }

  // Render posts
  feedContainer.innerHTML = "";
  renderPosts(feedContainer, posts, basePath);
}

function parsePostMarkdown(markdown, pageInfo, basePath) {
  // Parse frontmatter-style metadata from the markdown
  // Expected format at the start of the file:
  // ---
  // title: Post Title
  // date: 2024-01-15
  // tags: tag1, tag2, tag3
  // image: filename.avif
  // embed: https://youtube.com/watch?v=xxx
  // ---
  // Body content here...

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

    // Parse frontmatter fields
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

function createTagFilterBar(allTags, feedContainer, posts) {
  const tagBar = document.createElement("div");
  tagBar.className = "tag-filter-bar";

  const label = document.createElement("span");
  label.textContent = "Filter:";
  tagBar.appendChild(label);

  // "All" button
  const allBtn = document.createElement("span");
  allBtn.className = "tag-filter active";
  allBtn.textContent = "All";
  allBtn.dataset.tag = "";
  allBtn.addEventListener("click", () => filterByTag("", posts, feedContainer));
  tagBar.appendChild(allBtn);

  // Individual tag buttons
  Array.from(allTags).sort().forEach(tag => {
    const tagBtn = document.createElement("span");
    tagBtn.className = "tag-filter";
    tagBtn.textContent = tag;
    tagBtn.dataset.tag = tag;
    tagBtn.addEventListener("click", () => filterByTag(tag, posts, feedContainer));
    tagBar.appendChild(tagBtn);
  });

  // Insert before feed container
  feedContainer.parentNode.insertBefore(tagBar, feedContainer);
}

function filterByTag(tag, posts, feedContainer) {
  // Update active state on filter buttons
  document.querySelectorAll(".tag-filter").forEach(btn => {
    btn.classList.remove("active");
    if (btn.dataset.tag === tag) {
      btn.classList.add("active");
    }
  });

  // Filter and render posts
  const filteredPosts = tag
    ? posts.filter(post => post.tags && post.tags.includes(tag))
    : posts;

  feedContainer.innerHTML = "";
  renderPosts(feedContainer, filteredPosts);
}

function renderPosts(container, posts) {
  if (posts.length === 0) {
    container.innerHTML = '<div class="no-posts">No posts found.</div>';
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

    // Featured image or embed
    if (post.image || post.embed) {
      const mediaDiv = document.createElement("div");
      mediaDiv.className = "post-media";

      if (post.embed) {
        mediaDiv.innerHTML = renderEmbed(post.embed);
      } else if (post.image) {
        const img = document.createElement("img");
        // Handle image path
        if (post.image.startsWith("http")) {
          img.src = post.image;
        } else {
          img.src = `${basePath}/${post.image}`;
        }
        img.alt = post.title;
        mediaDiv.appendChild(img);
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

    // Process embeds in body
    processEmbeds(bodyDiv, basePath);

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
          const tagBtn = document.querySelector(`.tag-filter[data-tag="${tag}"]`);
          if (tagBtn) tagBtn.click();
        });
        tagsDiv.appendChild(tagSpan);
      });

      contentDiv.appendChild(tagsDiv);
    }

    article.appendChild(contentDiv);
    container.appendChild(article);
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

function createFooter(origin, basePath, showHistory) {
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
      showHistoryModal(origin, basePath);
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

async function showHistoryModal(origin, basePath) {
  const overlay = document.getElementById("historyOverlay");
  const content = document.getElementById("historyContent");
  overlay.style.display = "flex";

  try {
    const response = await fetch(`${origin}${basePath}/history.json`, {
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
