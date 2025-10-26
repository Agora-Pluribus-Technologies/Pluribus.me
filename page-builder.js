let editor; // Global variable to store editor instance

async function loadZipLogic() {
  const main = document.getElementById("main");
  var deploySiteButton = document.createElement("button");
  main.appendChild(deploySiteButton);

  deploySiteButton.innerText = "Deploy Site";
  deploySiteButton.addEventListener("click", async () => {
    console.log("Building zip blob");
    const zipBlob = await buildZipBlob();

    const resp0 = await createSite();
    console.log(resp0);
    const siteId = resp0.id;
    console.log(siteId);
    
    const resp1 = await deploySite(siteId, zipBlob);
    console.log(resp1);
  });
}

/* ---------- Create a ZIP from multiple files ---------- */
async function buildZipBlob() {
  const editorContent = editor.getMarkdown();

  const owoHomepageHtml = document.getElementById("owo-homepage-template");
  const indexHtml = `<!DOCTYPE html>\n${owoHomepageHtml.innerHTML}`;

  const files = [
    { path: "index.md", data: editorContent },
    { path: "index.html", data: indexHtml },
  ];

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

  // Generate as a Blob
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
    initialEditType: "wysiwyg",
    previewStyle: "vertical",
  });
}
