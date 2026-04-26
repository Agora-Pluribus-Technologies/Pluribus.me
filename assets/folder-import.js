// Folder-import for AgoraPages "pages" sites.
//
// Walks a dropped folder (e.g. an Obsidian vault), filters to .md files, and
// produces an array of pages ready to seed a new site:
//
//   [{
//     fileName:    "research/transformers",   // pages.json slug, no .md
//     displayName: "Transformers",            // sidebar label
//     content:     "<frontmatter-stripped markdown>",
//     createdAt:   ISO timestamp,
//     modifiedAt:  ISO timestamp,
//   }, ...]
//
// Currently in scope:
//   - Recursive walk of dropped folder via DataTransferItem.webkitGetAsEntry
//   - .md file ingestion only; other extensions skipped silently
//   - .obsidian/, .git/, .trash/ and other dotfolders ignored
//   - Filenames with spaces produce kebab-case slugs + spaced display names
//   - YAML frontmatter stripped from content; `title` field used as displayName when present
//
// Deferred (handled in follow-up work):
//   - Image/attachment ingestion (resize to WebP, rewrite paths)
//   - `[text](./page.md)` -> wikilink rewriting

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

  // Slugify a single path segment: lowercase, spaces/underscores -> hyphens,
  // drop characters that aren't safe in URLs.
  function slugifySegment(name) {
    return name
      .toLowerCase()
      .replace(/\.(md|markdown)$/i, "")
      .replace(/['"`]/g, "")
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-z0-9-]+/g, "-")
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
      out.push({ relativePath: prefix + entry.name, file });
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
        if (child.isDirectory && shouldIgnoreDir(child.name)) continue;
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
  //   skipped = count of non-markdown files silently ignored
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
        if (entry.isDirectory && shouldIgnoreDir(entry.name)) continue;
        try {
          const sub = await walkDirectoryEntry(entry);
          entries.push(...sub);
        } catch (e) {
          errors.push({ path: entry.name, message: String(e) });
        }
      }
    } else if (dataTransferOrFileList && dataTransferOrFileList.length != null) {
      // FileList from <input type="file" webkitdirectory>.
      // Each File has a webkitRelativePath like "vault/notes/index.md".
      entries = Array.from(dataTransferOrFileList).map(file => ({
        relativePath: file.webkitRelativePath || file.name,
        file,
      }));
    }

    entries = stripCommonRoot(entries);

    let skipped = 0;
    const pages = [];
    const seenSlugs = new Map(); // slug -> count, for de-duplicating collisions

    for (const { relativePath, file } of entries) {
      const baseName = relativePath.split("/").pop() || file.name;
      if (!isMarkdownFile(baseName)) {
        skipped++;
        continue;
      }
      // Skip files inside ignored dirs that slipped through (input[type=file]
      // doesn't let us pre-filter directories).
      const parts = relativePath.split("/");
      if (parts.slice(0, -1).some(shouldIgnoreDir)) {
        skipped++;
        continue;
      }

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
