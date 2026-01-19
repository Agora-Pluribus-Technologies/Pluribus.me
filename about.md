# About this tool

AgoraPages is a mobile-friendly web app that allows users to create and edit webpages easily for free. Optionally, the user can add collaborators to provide shared access to editable websites.

---

## The Goal
The goal of AgoraPages is to democratize the open web by lowering the barrier to entry for creative and non-technical people to create an online presence on the internet.

---

## How it works
When creating an Agora site, this app uses a Cloudflare Pages function to dynamically link to the user's files in Cloudflare R2 storage.

This distributed model is inspired by a tool created in Taiwan's g0v movement called [hackfoldr](https://github.com/hackfoldr/hackfoldr). Similar to hackfoldr, AgoraPages dynamically links various files when the main page is accessed.

An Agora site is made up of JSON, markdown, and image files:

* site.json - top-level site settings
* pages.json - a list of pages, each of which has a corresponding markdown file
* images.json - a list of images, each of which has a corresponding image file

When an Agora site is accessed, these JSON files are fetched, and the contents of the site are fetched and rendered dynamically.