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
  const siteName = siteJson ? siteJson.siteName : null;
  const showHistory = siteJson ? siteJson.showHistory : false;
  await createMenubar(origin, basePath, pagesJson);
  await fetchPageContent(origin, basePath, siteName, pagesJson);
  decodeEmbeds(basePath);
  decodeImages(basePath);
  createFooter(origin, basePath, showHistory);
});

function decodeImages(basePath) {
  const pList = document.getElementsByTagName("p");
  for (let i = 0; i < pList.length; i++) {
    let p = pList[i];
    if (
      p.children.length == 1 &&
      p.children[0].nodeName.toLowerCase() == "img"
    ) {
      p.style.textAlign = "center";
      p.parentElement.parentElement.classList.remove("h-entry");
      p.parentElement.parentElement.classList.add("image-container");
      p.parentElement.classList.remove("e-content");

      // Check if image has a title attribute (used as caption)
      const img = p.children[0];

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

async function createMenubar(origin, basePath, pagesJson) {
  const menubar = document.createElement("nav");
  menubar.style.width = "100%";

  if (pagesJson) {
    for (const page of pagesJson) {
      const displayName = page.displayName;
      const fileName = page.fileName;

      let relPage;
      if (fileName === "index") {
        relPage = "";
      } else {
        relPage = `${fileName}.html`;
      }
      const pageLink = document.createElement("a");
      pageLink.classList.add("menu-link");
      pageLink.href = `${origin}${basePath}/${relPage}`;
      pageLink.textContent = displayName;
      menubar.appendChild(pageLink);
    }
    document.body.appendChild(menubar);
  }
}

async function fetchPageContent(origin, basePath, siteName, pagesJson) {
  marked.setOptions({
    gfm: true,
    breaks: false,
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
  if (!pathName) {
    pathName = "index";
  }

  // Set tab title
  if (pagesJson) {
    let siteName;
    if (siteName) {
      siteName = siteName;
    } else {
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
      const parsedMarkdown = await marked.parse(text);
      const sanitizedMarkdown = DOMPurify.sanitize(parsedMarkdown);

      const markdownSections = sanitizedMarkdown.split("<hr>");
      for (let i = 0; i < markdownSections.length; i++) {
        let section = markdownSections[i].trim();
        if (section) {
          let sectionArticle = document.createElement("article");
          sectionArticle.classList.add("h-entry");

          if (section.startsWith("<h")) {
            // Extract title text from header tag
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

  document.body.appendChild(panel);
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
