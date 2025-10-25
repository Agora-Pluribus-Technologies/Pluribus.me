let editor; // Global variable to store editor instance

document.addEventListener("DOMContentLoaded", async function () {
  loadToastEditor();
  loadZipLogic();
});

async function loadZipLogic() {
  document.getElementById("makeZip").addEventListener("click", async () => {
    const editorContent = editor.getMarkdown();
    console.log("Markdown: " + editorContent);

    const owoHomepageHtml = document.getElementById("owo-homepage-template");
    const indexHtml = `<!DOCTYPE html>\n${owoHomepageHtml.innerHTML}`;
    console.log("Index: " + indexHtml);

    // Example inputs (mix of text files and a generated Blob):
    const files = [
      { path: "index.md", data: editorContent },
      { path: "index.html", data: indexHtml },
    ];

    console.log("Building zip blob");
    const zipBlob = await buildZipBlob(files);

    const name = `site-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;

    console.log("Creating link");
    const url = URL.createObjectURL(zipBlob);
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: name,
    });
    document.body.appendChild(a);
    a.click();
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

function loadToastEditor() {
  editor = new toastui.Editor({
    el: document.querySelector("#editor"),
    height: "500px",
    initialEditType: "markdown",
    previewStyle: "vertical",
  });
}
