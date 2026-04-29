// Folder-import for AgoraPages "pages" sites.
//
// Walks a dropped folder (e.g. an Obsidian vault), filters to .md files
// only, and produces { pages, skipped, errors } ready to seed a new site:
//
//   pages: [{ fileName, displayName, content, createdAt, modifiedAt }, ...]
//
// AgoraPages does NOT host user-uploaded image bytes (CSAM policy). Image
// files in the dropped folder are silently dropped — counted toward
// `skipped` and surfaced in the import summary so the user knows their
// images didn't come along. Image references in the markdown body are
// left verbatim and will render as broken links until the user re-embeds
// each image via the editor's "Insert image from URL" toolbar button
// pointing at an external host.
//
// Currently in scope:
//   - Recursive walk of dropped folder via DataTransferItem.webkitGetAsEntry
//   - .md file ingestion
//   - .obsidian/, .git/, .trash/ and other dotfolders ignored
//   - Filenames with spaces produce kebab-case slugs + spaced display names
//   - YAML frontmatter stripped from content; `title` field used as displayName when present

(function (root) {
  const MARKDOWN_EXTENSIONS = [".md", ".markdown"];
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

  // Public entry point. Accepts either a DataTransfer (drag) or a FileList
  // (input[type=file] webkitdirectory). Returns:
  //   { pages, skipped, errors }
  // where:
  //   pages   = array of page objects ready for site creation
  //   skipped = count of non-markdown files silently ignored (includes images)
  //   errors  = per-file errors collected during read/parse
  async function importFromDataTransfer(dataTransferOrFileList) {
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

    // Bucket entries: markdown vs. ignored. Image files (and everything
    // else non-markdown) fall into `skipped` — see file header for the
    // policy rationale.
    let skipped = 0;
    const mdEntries = [];

    for (const entry of entries) {
      const baseName = entry.relativePath.split("/").pop() || entry.file.name;
      const parents = entry.relativePath.split("/").slice(0, -1);
      if (parents.some(shouldIgnoreDir)) { skipped++; continue; }
      if (isMarkdownFile(baseName)) mdEntries.push(entry);
      else skipped++;
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

    return { pages, skipped, errors };
  }

  root.AgoraFolderImport = {
    importFromDataTransfer,
    pathToSlug,
    slugifySegment,
    extractFrontmatter,
    fileNameToDisplayName,
    isMarkdownFile,
    shouldIgnoreDir,
  };
})(typeof window !== "undefined" ? window : globalThis);
