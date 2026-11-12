# with — menu

A tiny static site that shows the menu PDF as a normal web page: full width, pages
stacked with no gaps, no PDF toolbar, no page numbers. A **TR / EN** switch at the
top right changes between the Turkish and the English menu. Empty space at the
sides of the PDF is trimmed off automatically, so on a phone the menu itself fills
the screen. When a guest zooms in, the part on screen is redrawn so the text stays
sharp.

## Add the menus

Put the two PDFs in this folder and name them exactly:

- **`menu-tr.pdf`**: the Turkish menu
- **`menu-en.pdf`**: the English menu

## Languages

- Guests see the Turkish menu first.
- If a guest switches language, their phone remembers it for the next visit.
- A link can open a language directly: add `?lang=en` (or `?lang=tr`) to the
  address, for example for a separate English QR code.
- To change the default or add a language, edit `MENUS` and `DEFAULT_LANGUAGE`
  at the top of `app.js`, and add a button with the same `data-lang` in `index.html`.

## Preview locally

```bash
npx serve .
# or: python3 -m http.server 8000
```

Then open the address it prints. (Opening `index.html` by double-clicking won't
work, because browsers block PDF loading from `file://`.)

## Deploy to Cloudflare Pages

The site is hosted on [Cloudflare Pages](https://pages.cloudflare.com/) as the
project **`with-menu`**. The live address is <https://with-menu.pages.dev>.

There is no build step and no GitHub connection: a deploy uploads this folder
as it is, from your computer.

### One-time setup

Install [Node.js](https://nodejs.org/), then log in to Cloudflare once per
computer:

```bash
npx wrangler login
```

The first time, it asks to install `wrangler`: answer `y`. A browser window then
opens. Log in with the Cloudflare account that owns the `with-menu` project and
allow access.

### Deploy a new version to production

From this folder, run:

```bash
npx wrangler pages deploy . --project-name=with-menu --branch=main
```

`--branch=main` is what makes it the live version. When the command finishes,
the new version is live at <https://with-menu.pages.dev>. Open it and check
both languages.

### Try a version before it goes live

```bash
npx wrangler pages deploy . --project-name=with-menu --branch=preview
```

This uploads to <https://preview.with-menu.pages.dev> and leaves the live site
alone. When it looks right, run the production command above.

### Go back to an older version

In the [Cloudflare dashboard](https://dash.cloudflare.com/), go to
**Workers & Pages → with-menu → Deployments**, open the **⋯** menu next to an
older production deployment and choose **Rollback to this deployment**.

### What gets uploaded

Everything in this folder is uploaded, and anyone can open it by its address,
this README included. Don't keep drafts or private files here.

## Update the menu

Replace `menu-tr.pdf` and/or `menu-en.pdf` (keep the exact names), then
[deploy to production](#deploy-a-new-version-to-production). Guests get the new
version right away. Each PDF must be smaller than 25 MB, Cloudflare's limit for
one file.

## Optional tweaks (top of `index.html`)

- `--max-width`: how wide the menu gets on computers (default `560px`; a bigger
  number gives bigger text, `100%` goes edge to edge).
- `--bg`: the background color. It is picked automatically from the edge of
  your PDF, so you usually don't need to change it.
- `--accent`: the color of the selected language in the TR / EN switch.
- `--ink`: the text color of the switch (turns white automatically on a dark menu).

And at the top of `app.js`:

- `SIDE_PADDING`: how much border is kept at each side after the empty sides of
  the PDF are trimmed off (default `0.04`, which is 4% of the menu's width).

## Files

- `index.html`: the page
- `app.js`: draws the PDF pages and switches language
- `menu-tr.pdf`, `menu-en.pdf`: the menus
- `vendor/pdfjs/`: [PDF.js](https://mozilla.github.io/pdf.js/) 6.5.438 (Mozilla's PDF renderer), stored locally so the site doesn't depend on any other server
- `.wrangler/`: created by the deploy command to remember the Cloudflare project. It is not uploaded and is safe to delete.
