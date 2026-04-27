// Folder-import for AgoraPages "pages" sites.
//
// Walks a dropped folder (e.g. an Obsidian vault), filters to .md files +
// images, and produces { pages, assets, skipped, errors } ready to seed a
// new site:
//
//   pages: [{ fileName, displayName, content, createdAt, modifiedAt }, ...]
//   assets: [{ filename, base64, contentType }, ...]   // WebP-compressed
//
// Currently in scope:
//   - Recursive walk of dropped folder via DataTransferItem.webkitGetAsEntry
//   - .md file ingestion
//   - Image ingestion: png/jpg/gif/webp/avif/heic/bmp/tiff are run through
//     the editor's WebP pipeline (via window.processImage) and uploaded to
//     public/attachments/<slug>.webp. SVGs pass through untouched.
//   - Standard `![alt](path)` and Obsidian `![[file]]` image refs are
//     resolved against the imported file set (path-aware, with fallback to
//     basename-only) and rewritten to point at the new attachment URLs.
//   - .obsidian/, .git/, .trash/ and other dotfolders ignored
//   - Filenames with spaces produce kebab-case slugs + spaced display names
//   - YAML frontmatter stripped from content; `title` field used as displayName when present
//
// Deferred (handled in follow-up work):
//   - `[text](./page.md)` -> wikilink rewriting

(function (root) {
  const MARKDOWN_EXTENSIONS = [".md", ".markdown"];
  // Raster image formats run through the WebP encoder. SVG is treated as
  // its own asset class — uploaded as-is without conversion.
  const RASTER_IMAGE_EXTENSIONS = [
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif",
    ".heic", ".heif", ".bmp", ".tif", ".tiff",
  ];
  const SVG_EXTENSION = ".svg";
  // Folders never worth importing (Obsidian/Vault metadata, VCS, OS junk).
  const IGNORED_DIR_NAMES = new Set([
    ".obsidian",
    ".trash",
    ".git",
    ".github",
    ".vscode",
    ".idea",
    "__macosx",
    "node_modules",
  ]);

  function isMarkdownFile(name) {
    const lower = name.toLowerCase();
    return MARKDOWN_EXTENSIONS.some(ext => lower.endsWith(ext));
  }

  function isRasterImageFile(name) {
    const lower = name.toLowerCase();
    return RASTER_IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
  }

  function isSvgFile(name) {
    return name.toLowerCase().endsWith(SVG_EXTENSION);
  }

  function shouldIgnoreDir(name) {
    if (!name) return true;
    if (name.startsWith(".")) return true; // any dotfolder
    return IGNORED_DIR_NAMES.has(name.toLowerCase());
  }

  // NFC-normalize every filename string the moment it enters the system.
  // macOS (especially old HFS+ vaults) hands us NFD bytes for the same
  // visible character that other systems supply as NFC — `Café` arrives
  // as either C-a-f-é or C-a-f-e-´ depending on origin, and string
  // equality fails between the two. Normalizing once at the boundary
  // means every Map/Set lookup, slug derivation, and R2 key downstream
  // sees the canonical form.
  function nfc(s) {
    return typeof s === "string" ? s.normalize("NFC") : s;
  }

  // Slugify a single path segment: lowercase, spaces/underscores -> hyphens,
  // drop characters that aren't safe in URLs. The Unicode allowlist
  // (\p{L} = letter, \p{N} = number) preserves CJK / Cyrillic / Greek /
  // accented Latin etc. so non-ASCII filenames don't slug to "" or
  // collide on emptiness.
  function slugifySegment(name) {
    return nfc(name)
      .toLowerCase()
      .replace(/\.(md|markdown)$/i, "")
      .replace(/['"`]/g, "")
      .replace(/[\s_]+/g, "-")
      .replace(/[^\p{L}\p{N}-]+/gu, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  // Build the pages.json slug for a file path. Each segment is slugified
  // independently so folder structure is preserved.
  function pathToSlug(relativePath) {
    return relativePath
      .split("/")
      .filter(Boolean)
      .map(slugifySegment)
      .filter(Boolean)
      .join("/");
  }

  // Display name preserves casing and spacing of the original filename
  // (without the extension).
  function fileNameToDisplayName(name) {
    return name.replace(/\.(md|markdown)$/i, "");
  }

  // Naive YAML frontmatter extractor: returns { content, title } where
  // content has the frontmatter block removed and title (if present) is the
  // unquoted value of the `title:` field.
  function extractFrontmatter(text) {
    if (!text || typeof text !== "string") return { content: text, title: null };
    const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (!match) return { content: text, title: null };
    const block = match[1];
    let title = null;
    const titleMatch = block.match(/^[ \t]*title[ \t]*:[ \t]*(.+?)[ \t]*$/m);
    if (titleMatch) {
      title = titleMatch[1].replace(/^['"]|['"]$/g, "").trim();
    }
    return {
      content: text.slice(match[0].length),
      title: title || null,
    };
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("File read failed"));
      reader.readAsText(file);
    });
  }

  // Walk a FileSystemDirectoryEntry, yielding { relativePath, file } for every
  // file inside (recursively). The relativePath omits the dropped root folder
  // name so two vaults with different root names produce equivalent slugs.
  async function walkDirectoryEntry(entry, prefix = "") {
    const out = [];
    if (!entry) return out;

    if (entry.isFile) {
      const file = await new Promise((resolve, reject) =>
        entry.file(resolve, reject)
      );
      // NFC normalize at the boundary so downstream comparisons with
      // markdown-referenced filenames (which are usually NFC) succeed.
      out.push({ relativePath: nfc(prefix + entry.name), file });
      return out;
    }

    if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries() returns at most ~100 entries per call; loop until empty.
      const entries = [];
      while (true) {
        const batch = await new Promise((resolve, reject) =>
          reader.readEntries(resolve, reject)
        );
        if (!batch || batch.length === 0) break;
        entries.push(...batch);
      }
      for (const child of entries) {
        if (child.isDirectory && shouldIgnoreDir(nfc(child.name))) continue;
        const sub = await walkDirectoryEntry(child, prefix + entry.name + "/");
        out.push(...sub);
      }
    }
    return out;
  }

  // Strip the leading dropped-root segment from every relative path so the
  // resulting slugs are folder-agnostic.
  function stripCommonRoot(entries) {
    if (entries.length === 0) return entries;
    const firstSeg = entries[0].relativePath.split("/")[0];
    if (!firstSeg) return entries;
    const allShareRoot = entries.every(e =>
      e.relativePath.split("/")[0] === firstSeg
    );
    if (!allShareRoot) return entries;
    return entries.map(e => ({
      ...e,
      relativePath: e.relativePath.split("/").slice(1).join("/"),
    }));
  }

  // Asset helpers — image ingestion + path-aware reference resolution.

  function attachmentSlug(relativePath, ext, seen) {
    const base = nfc(relativePath.split("/").pop() || "image");
    const stem = base.replace(/\.[^.]+$/, "");
    let slug = stem
      .toLowerCase()
      .replace(/['"`]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) slug = "image";
    let candidate = `${slug}${ext}`;
    let n = 2;
    while (seen.has(candidate)) {
      candidate = `${slug}-${n}${ext}`;
      n++;
    }
    seen.add(candidate);
    return candidate;
  }

  // Run a raster image through the editor's WebP pipeline. Falls back to
  // the original blob if the global processor isn't available (e.g. tests).
  async function processImageBlob(file) {
    const fn = (typeof window !== "undefined" && window.processImage)
      || (typeof processImage !== "undefined" ? processImage : null);
    if (typeof fn === "function") return await fn(file);
    return file;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result || "";
        const idx = String(result).indexOf(",");
        resolve(idx >= 0 ? String(result).slice(idx + 1) : "");
      };
      reader.onerror = () => reject(reader.error || new Error("blobToBase64 failed"));
      reader.readAsDataURL(blob);
    });
  }

  // Normalize a path: drop leading slashes, resolve "." and ".." segments.
  function normalizeAssetPath(path) {
    const out = [];
    for (const seg of String(path || "").split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") { if (out.length) out.pop(); continue; }
      out.push(seg);
    }
    return out.join("/");
  }

  // Strip URL fragment, query, and percent-encoding so we can compare a
  // markdown reference to a vault-relative file path. NFC normalize so a
  // CJK / accented reference written in NFC (the typical editor output)
  // matches an NFD filename arriving from an old macOS vault.
  function decodeRefPath(ref) {
    let s = String(ref || "").trim();
    s = s.split("#")[0].split("?")[0];
    if (!s) return "";
    try { return nfc(decodeURIComponent(s)); } catch { return nfc(s); }
  }

  function isExternalUrl(ref) {
    return /^(https?:|data:|mailto:|file:)/i.test(String(ref || "").trim());
  }

  // Pick the imported image that a markdown reference points at. Tries
  // path-aware candidates first (vault root, sibling folder, the common
  // `attachments/` `assets/` `images/` siblings), falling back to a
  // basename-only match if none of the candidates landed.
  function resolveAssetRef(ref, mdRelativePath, assetIndex, basenameIndex) {
    if (!ref || isExternalUrl(ref)) return null;
    const decoded = decodeRefPath(ref);
    if (!decoded) return null;

    const mdDir = mdRelativePath.includes("/")
      ? mdRelativePath.substring(0, mdRelativePath.lastIndexOf("/"))
      : "";
    const base = decoded.split("/").pop();

    const candidates = [];
    if (decoded.startsWith("/")) {
      candidates.push(normalizeAssetPath(decoded));
    } else {
      candidates.push(normalizeAssetPath(mdDir ? `${mdDir}/${decoded}` : decoded));
      if (base) {
        if (mdDir) {
          candidates.push(normalizeAssetPath(`${mdDir}/attachments/${base}`));
          candidates.push(normalizeAssetPath(`${mdDir}/assets/${base}`));
          candidates.push(normalizeAssetPath(`${mdDir}/images/${base}`));
        }
        candidates.push(`attachments/${base}`);
        candidates.push(`assets/${base}`);
        candidates.push(`images/${base}`);
      }
    }
    for (const candidate of candidates) {
      const slug = assetIndex.get(candidate.toLowerCase());
      if (slug) return slug;
    }
    if (base) {
      const slug = basenameIndex.get(base.toLowerCase());
      if (slug) return slug;
    }
    return null;
  }

  // Rewrite both standard `![alt](url)` and Obsidian `![[file]]` image
  // references in a markdown body. Skips fenced code blocks and inline code
  // spans so embedded refs there stay literal.
  function rewriteImageRefs(content, mdRelativePath, assetIndex, basenameIndex, attachmentsUrl) {
    if (!content) return content;
    const fenceRe = /^(```[\s\S]*?^```$|~~~[\s\S]*?^~~~$)/gm;
    const out = [];
    let last = 0;
    let m;
    while ((m = fenceRe.exec(content)) !== null) {
      if (m.index > last) out.push(transformOutsideCode(content.slice(last, m.index)));
      out.push(m[0]);
      last = m.index + m[0].length;
    }
    if (last < content.length) out.push(transformOutsideCode(content.slice(last)));
    return out.join("");

    function transformOutsideCode(text) {
      const codeRe = /(`+)([^`\n]+?)\1/g;
      let result = "";
      let l = 0;
      let cm;
      while ((cm = codeRe.exec(text)) !== null) {
        result += transform(text.slice(l, cm.index));
        result += cm[0];
        l = cm.index + cm[0].length;
      }
      result += transform(text.slice(l));
      return result;
    }

    function transform(text) {
      // Standard markdown: ![alt](url "optional title")
      text = text.replace(
        /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g,
        function (whole, alt, url, title) {
          const slug = resolveAssetRef(url, mdRelativePath, assetIndex, basenameIndex);
          if (!slug) return whole;
          const newUrl = `${attachmentsUrl}/${slug}`;
          return title ? `![${alt}](${newUrl} "${title}")` : `![${alt}](${newUrl})`;
        }
      );
      // Obsidian image embed: ![[file]] or ![[file|alias]]
      text = text.replace(
        /!\[\[([^|\]\n]+?)(?:\|([^\]\n]*))?\]\]/g,
        function (whole, ref, alias) {
          const slug = resolveAssetRef(ref, mdRelativePath, assetIndex, basenameIndex);
          if (!slug) return whole;
          const cleanAlias = (alias || "").trim();
          const altBase = ref.split("/").pop().replace(/\.[^.]+$/, "");
          const alt = cleanAlias || altBase || "";
          return `![${alt}](${attachmentsUrl}/${slug})`;
        }
      );
      return text;
    }
  }

  // Public entry point. Accepts either a DataTransfer (drag) or a FileList
  // (input[type=file] webkitdirectory). Returns:
  //   { pages, assets, skipped, errors }
  // where:
  //   pages   = array of page objects ready for site creation
  //   assets  = array of { filename, base64, contentType } for R2 upload
  //   skipped = count of non-markdown / non-image files silently ignored
  //   errors  = per-file errors collected during read/parse/encode
  //
  // Options:
  //   attachmentsUrl  Absolute URL prefix used in rewritten image refs.
  //                   Defaults to "attachments" (vault-relative); pass
  //                   "/s/owner/site/attachments" to match the editor's
  //                   absolute-URL convention.
  async function importFromDataTransfer(dataTransferOrFileList, options) {
    options = options || {};
    const attachmentsUrl = options.attachmentsUrl || "attachments";

    let entries = [];
    const errors = [];

    if (dataTransferOrFileList && dataTransferOrFileList.items) {
      // DataTransferItemList from a drop event.
      const items = Array.from(dataTransferOrFileList.items);
      for (const item of items) {
        const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
        if (!entry) continue;
        if (entry.isDirectory && shouldIgnoreDir(nfc(entry.name))) continue;
        try {
          const sub = await walkDirectoryEntry(entry);
          entries.push(...sub);
        } catch (e) {
          errors.push({ path: nfc(entry.name), message: String(e) });
        }
      }
    } else if (dataTransferOrFileList && dataTransferOrFileList.length != null) {
      // FileList from <input type="file" webkitdirectory>.
      // Each File has a webkitRelativePath like "vault/notes/index.md".
      // NFC normalize at the boundary — see walkDirectoryEntry comment.
      entries = Array.from(dataTransferOrFileList).map(file => ({
        relativePath: nfc(file.webkitRelativePath || file.name),
        file,
      }));
    }

    entries = stripCommonRoot(entries);

    // Bucket entries: markdown, raster image, svg, ignored.
    let skipped = 0;
    const mdEntries = [];
    const imageEntries = [];

    for (const entry of entries) {
      const baseName = entry.relativePath.split("/").pop() || entry.file.name;
      const parents = entry.relativePath.split("/").slice(0, -1);
      if (parents.some(shouldIgnoreDir)) { skipped++; continue; }
      if (isMarkdownFile(baseName)) mdEntries.push(entry);
      else if (isRasterImageFile(baseName) || isSvgFile(baseName)) imageEntries.push(entry);
      else skipped++;
    }

    // Process images first so the markdown pass can rewrite refs to point
    // at the new attachment slugs.
    const assets = [];
    const slugByOriginalPath = new Map();   // vaultPathLower -> slug
    const slugByBasename = new Map();       // basenameLower  -> slug
    const usedSlugs = new Set();

    for (const { relativePath, file } of imageEntries) {
      try {
        let blob;
        let contentType;
        let ext;
        if (isSvgFile(relativePath)) {
          blob = file;
          contentType = "image/svg+xml";
          ext = ".svg";
        } else {
          blob = await processImageBlob(file);
          contentType = "image/webp";
          ext = ".webp";
        }
        const filename = attachmentSlug(relativePath, ext, usedSlugs);
        const base64 = await blobToBase64(blob);
        assets.push({ filename, base64, contentType });
        slugByOriginalPath.set(relativePath.toLowerCase(), filename);
        const baseLower = (relativePath.split("/").pop() || "").toLowerCase();
        if (baseLower && !slugByBasename.has(baseLower)) {
          slugByBasename.set(baseLower, filename);
        }
      } catch (e) {
        errors.push({ path: relativePath, message: String(e) });
      }
    }

    // Process markdown.
    const pages = [];
    const seenSlugs = new Map(); // slug -> count, for de-duplicating collisions

    for (const { relativePath, file } of mdEntries) {
      const baseName = relativePath.split("/").pop() || file.name;

      let text;
      try {
        text = await readFileAsText(file);
      } catch (e) {
        errors.push({ path: relativePath, message: String(e) });
        continue;
      }

      // Rewrite image refs against the imported asset set BEFORE stripping
      // frontmatter, so refs inside YAML are still seen if relevant.
      text = rewriteImageRefs(
        text,
        relativePath,
        slugByOriginalPath,
        slugByBasename,
        attachmentsUrl
      );

      const { content, title } = extractFrontmatter(text);
      const displayName = title || fileNameToDisplayName(baseName);

      let slug = pathToSlug(relativePath);
      if (!slug) continue;
      // De-dupe colliding slugs (e.g. "Foo.md" + "foo.md") by suffixing.
      if (seenSlugs.has(slug)) {
        const n = seenSlugs.get(slug) + 1;
        seenSlugs.set(slug, n);
        slug = `${slug}-${n}`;
      } else {
        seenSlugs.set(slug, 1);
      }

      const stamp = file.lastModified
        ? new Date(file.lastModified).toISOString()
        : new Date().toISOString();

      pages.push({
        fileName: slug,
        displayName,
        content: content.replace(/^\s+|\s+$/g, "") + "\n",
        createdAt: stamp,
        modifiedAt: stamp,
      });
    }

    // Sort alphabetically, then promote any root-level `home` or `index` page
    // to position 0 so the published-site router treats it as the homepage.
    // Vault conventions vary (Obsidian uses `Home.md`, Hugo/Jekyll use
    // `index.md`); both are accepted.
    pages.sort((a, b) => a.fileName.localeCompare(b.fileName));
    const homeIdx = pages.findIndex(p => p.fileName === "home" || p.fileName === "index");
    if (homeIdx > 0) {
      const [home] = pages.splice(homeIdx, 1);
      pages.unshift(home);
    }

    return { pages, assets, skipped, errors };
  }

  root.AgoraFolderImport = {
    importFromDataTransfer,
    pathToSlug,
    slugifySegment,
    extractFrontmatter,
    fileNameToDisplayName,
    isMarkdownFile,
    isRasterImageFile,
    isSvgFile,
    shouldIgnoreDir,
  };
})(typeof window !== "undefined" ? window : globalThis);
