## **Pluribus OpenWeb Object (OWO) Specification — v0.1 (Work in Progress)**

**Author:** Michael Yee (Agora Pluribus Technologies)

**Status:** Early draft – conceptual specification

**License:** *Public Domain / CC0 1.0 Universal Dedication*

**Website:** [pluribus.me](https://pluribus.me/)

***

### **Overview**

The **Pluribus OpenWeb Object (OWO)** format is a proposed open specification for a decentralized, static-first, modular web publishing framework.
Its purpose is to make it radically simple for anyone to create, host, and share portable websites — without relying on centralized platforms, databases, or proprietary formats.

The OWO specification defines a lightweight, machine-readable structure for representing a website as a **single, portable object** that can be freely copied, forked, mirrored, or rendered by any compliant reader.

***

### **Design Goals**

1. **Radical Simplicity:** Websites are bundles of plain files (Markdown, images, CBOR manifests).
2. **Transparency & Portability:** Each site is easily inspectable, exportable, and versionable.
3. **Modularity:** Content is stored as modular building blocks with references in a root manifest.
4. **Interoperability:** Fully compatible with IndieWeb and Semantic Web principles (Microformats 2, optional RDFa/JSON-LD).
5. **Open Hosting:** Designed for static deployment on any host (Netlify, GitLab Pages, Cloudflare Pages).
6. **Future-Proof:** Binary manifest format uses CBOR for compactness, allowing efficient archiving and validation.

***

### **Core Structure**

A `.owo` file represents a compressed website archive:

```
/index.cbor         ← CBOR-encoded HTML document
/manifest.json      ← Content and metadata manifest (title, description, assets)
/assets/*.avif      ← Images (AVIF or WebP)
/content/*.md       ← Text content (Markdown)
/style.css          ← Optional site-wide styling
/license.html       ← Optional license metadata (e.g., CC BY-NC-ND 4.0)
```

Compliant readers or tools should be able to:

* Parse and render `.owo` packages,
* Export them as plain static sites,
* Or re-import them for editing and remixing.

***

### **Implementation Notes**

* Reference implementation will be written in **Python (for desktop)** and **vanilla JavaScript (for browser)**.
* The **Service Worker** may be used to decompress and render `.cbor` files dynamically.
* OWO sites should support optional verification via **GPG-signed commits** or **Git repositories** for provenance.
* Recommended image formats: **AVIF**, fallback **WebP**.
* Recommended checksum: **SHA-256** or **BLAKE3** for archive integrity.

***

### **Legal Status**

This specification is released under the **CC0 1.0 Universal Public Domain Dedication**.

Anyone is free to use, modify, or redistribute it without restriction.
Reference implementations (e.g. editors, readers) may be licensed separately under the **AGPL-3.0-only** license to preserve freedom and transparency.

***

### **Current Stage**

⚙️ *Work in progress.*
The goal of this first publication is to reserve the name **“Pluribus OpenWeb Object (OWO)”** and establish the specification’s authorship and intent for future collaborative development.