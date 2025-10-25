let editor; // Global variable to store editor instance

document.addEventListener("DOMContentLoaded", async function () {
  loadEditorJs();
  loadZipLogic();
});

async function loadZipLogic() {
  document.getElementById("makeZip").addEventListener("click", async () => {
    const owoHomepageHtml = document.getElementById("owo-homepage-template");
    const indexHtml = `<!DOCTYPE html>\n${owoHomepageHtml.innerHTML}`;
    // Example inputs (mix of text files and a generated Blob):
    const files = [
      { path: "index.md", data: exportToMarkdown() },
      { path: "index.html", data: indexHtml }
    ];

    const zipBlob = await buildZipBlob(files);

    const name = `site-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
    
    const url = URL.createObjectURL(zipBlob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
  });
}

/* ---------- Create a ZIP from multiple files ---------- */
async function buildZipBlob(files) {
  // files: array of {path, data, type?: 'text'|'blob'}
  const zip = new JSZip();

  for (const f of files) {
    if (f.type === "blob") {
      zip.file(f.path, f.data); // Blob or Uint8Array
    } else {
      zip.file(f.path, f.data); // defaults to string
    }
  }

  // Example: folders are implicit via paths like 'images/banner.webp'
  // You can also do: const folder = zip.folder('images'); folder.file(...)

  // Generate as a Blob (best for IndexedDB)
  return await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

function loadEditorJs() {
  editor = new EditorJS({
    /**
     * Where to render the editor
     */
    holder: "editorjs",

    /**
     * Enable autofocus on start
     */
    autofocus: true,

    /**
     * Define block tools
     */
    tools: {
      paragraph: {
        class: Paragraph,
        inlineToolbar: ["link", "bold", "italic"],
      },
      header: {
        class: Header,
        inlineToolbar: ["link", "bold", "italic"],
        config: {
          placeholder: "Enter a header",
          levels: [1, 2, 3, 4, 5, 6],
          defaultLevel: 1,
        },
      },
      list: {
        class: EditorjsList,
        inlineToolbar: ["link", "bold", "italic"],
        config: {
          defaultStyle: "unordered",
        },
      },
      quote: {
        class: Quote,
        inlineToolbar: ["link", "bold", "italic"],
        config: {
          quotePlaceholder: "Enter a quote",
          captionPlaceholder: "Author",
        },
      },
      code: CodeTool,
      delimiter: Delimiter,
      table: {
        class: Table,
        inlineToolbar: ["link", "bold", "italic"],
        config: {
          rows: 2,
          cols: 3,
        },
      },
      embed: {
        class: Embed,
        config: {
          services: {
            youtube: true,
          },
        },
        inlineToolbar: true,
      },
      image: {
        class: ImageTool,
        config: {
          endpoints: {
            byFile: "http://localhost:8000/api/v1/sites/uploadFile",
          },
          field: "file",
        },
      },
      linkTool: {
        class: LinkTool,
        config: {
          endpoint: "http://localhost:8000/fetchUrl",
        },
      },
    },

    /**
     * Data example (optional)
     */
    data: {
      blocks: [
        {
          type: "header",
          data: { text: "Welcome to Editor.js!", level: 1 },
        },
        {
          type: "paragraph",
          data: {
            text: "You can edit this text, add new blocks, and save as JSON.",
          },
        },
      ],
    },
  });
}

async function exportToMarkdown() {
  const outputData = await editor.save();
  let markdown = "";

  for (const block of outputData.blocks) {
    switch (block.type) {
      case "header":
        const level = "#".repeat(block.data.level);
        markdown += `${level} ${block.data.text}\n\n`;
        break;

      case "paragraph":
        markdown += `${block.data.text}\n\n`;
        break;

      case "list":
        const marker = block.data.style === "ordered" ? "1." : "-";
        block.data.items.forEach((item) => {
          markdown += `${marker} ${item}\n`;
        });
        markdown += "\n";
        break;

      case "quote":
        markdown += `> ${block.data.text}\n`;
        if (block.data.caption) {
          markdown += `>\n> — ${block.data.caption}\n`;
        }
        markdown += "\n";
        break;

      case "code":
        markdown += `\`\`\`\n${block.data.code}\n\`\`\`\n\n`;
        break;

      case "delimiter":
        markdown += `---\n\n`;
        break;

      case "table":
        if (block.data.content && block.data.content.length > 0) {
          // Header row
          markdown += "| " + block.data.content[0].join(" | ") + " |\n";
          markdown +=
            "| " + block.data.content[0].map(() => "---").join(" | ") + " |\n";
          // Data rows
          for (let i = 1; i < block.data.content.length; i++) {
            markdown += "| " + block.data.content[i].join(" | ") + " |\n";
          }
          markdown += "\n";
        }
        break;

      case "image":
        const alt = block.data.caption || "image";
        markdown += `![${alt}](${block.data.file.url})\n\n`;
        break;

      case "embed":
        markdown += `[${block.data.service}](${block.data.source})\n\n`;
        break;

      case "linkTool":
        markdown += `[${block.data.meta.title || block.data.link}](${
          block.data.link
        })\n\n`;
        break;

      default:
        console.warn(`Unknown block type: ${block.type}`);
        break;
    }
  }

  return markdown;
}
