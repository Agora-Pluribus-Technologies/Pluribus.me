document.addEventListener("DOMContentLoaded", async function () {
  // https://agorapages.com
  const origin = document.location.origin;

  // /s/username/sitename/path/to/page.html --> /s/username/sitename
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

  await fetchPageContent(origin, basePath, siteName, pagesJson, mainContent);
  decodeEmbeds(basePath);
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
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtu\.be\/|youtube\.com\/v\/|youtube\.com\/watch\?.*&v=)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/, // Just the video ID
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
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

// Convert YouTube URL to embed iframe HTML
function youtubeUrlToEmbed(url) {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return null;
  }
  return `<iframe width="560" height="315" src="https://www.youtube-nocookie.com/embed/${videoId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`;
}

// Check if content is a SoundCloud URL
function isSoundCloudUrl(content) {
  const trimmed = content.trim();
  return trimmed.includes("soundcloud.com");
}

// Convert SoundCloud URL to embed iframe HTML
function soundcloudUrlToEmbed(url) {
  const trimmedUrl = url.trim();
  // SoundCloud widget uses the URL as a parameter
  const encodedUrl = encodeURIComponent(trimmedUrl);
  return `<iframe width="100%" height="166" scrolling="no" frameborder="no" allow="autoplay" src="https://w.soundcloud.com/player/?url=${encodedUrl}&color=%23ff5500&auto_play=false&hide_related=false&show_comments=true&show_user=true&show_reposts=false&show_teaser=true"></iframe>`;
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
      const isExternal = url.startsWith('https://');
      const icon = isExternal ? '🌐' : '🔗';

      const buttonContainer = document.createElement("div");
      buttonContainer.classList.add("link-button-container");

      const linkButton = document.createElement("a");
      linkButton.href = url;
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
      console.log("Embed content: " + embedContent);
      let embedHtml;

      // Check if it's a YouTube URL and convert to iframe
      if (isYouTubeUrl(embedContent)) {
        embedHtml = youtubeUrlToEmbed(embedContent);
        if (!embedHtml) {
          console.error("Could not parse YouTube URL: " + embedContent);
          continue;
        }
        console.log("Converted YouTube URL to embed");
      } else if (isSoundCloudUrl(embedContent)) {
        embedHtml = soundcloudUrlToEmbed(embedContent);
        console.log("Converted SoundCloud URL to embed");
      } else {
        // Treat as raw HTML
        embedHtml = embedContent;
      }

      let newDiv = document.createElement("div");
      newDiv.classList.add("embed-container");
      const sanitizedHtml = DOMPurify.sanitize(embedHtml, {
        // Allow iframes explicitly
        ADD_TAGS: ["iframe"],

        // Allow only safe, expected attributes
        ADD_ATTR: [
          "allow",
          "allowfullscreen",
          "frameborder",
          "referrerpolicy",
          "scrolling",
          "src",
          "width",
          "height",
        ],

        // Keep built-in protections on
        FORBID_TAGS: ["script", "style"], // script already forbidden by default, but explicit is fine
        FORBID_ATTR: ["onerror", "onload"], // event handlers (DOMPurify strips these by default too)
      });
      console.log("Sanitized: " + sanitizedHtml);
      newDiv.innerHTML = sanitizedHtml;

      let iframe = newDiv.children[0];
      if (iframe) {
        const w = iframe.width || 560;
        const h = iframe.height || 315;
        iframe.style.maxWidth = "90%";
        iframe.style.aspectRatio = `${w / h}`;
      }

      pre.parentElement.parentElement.replaceWith(newDiv);
    }
  }
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

  const tree = buildTreeFromPages(pagesJson, foldersJson);

  let currentPage = "";
  if (
    document.location.href.includes("agorapages.com/s") ||
    document.location.href.includes("pluribus-me.pages.dev/s")
  ) {
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

  renderNodes(sidebar, tree, 0);
  return sidebar;
}

async function fetchPageContent(origin, basePath, siteName, pagesJson, mainContent) {
  marked.setOptions({
    gfm: true,
    breaks: true,
  });

  // https://agorapages.com/s/username/sitename/path/to/page.html --> path/to/page
  let pathName;
  if (
    document.location.href.includes("agorapages.com/s") ||
    document.location.href.includes("pluribus-me.pages.dev/s")
  ) {
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
      console.log(text);
      if (typeof AgoraWikilinks !== "undefined") {
        const pages = (pagesJson || []).map(p => ({
          fileName: p.fileName,
          displayName: p.displayName,
        }));
        text = AgoraWikilinks.preprocessWikilinks(text, pages, basePath);
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
      let sanitizedMarkdown = DOMPurify.sanitize(parsedMarkdown, {
        ADD_ATTR: ["data-target"],
      });
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
    } else {
      throw new RuntimeException(errorMessage);
    }
  } catch (error) {
    panel.innerHTML = errorMessage;
  }

  mainContent.appendChild(panel);

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
