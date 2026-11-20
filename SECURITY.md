# Security

MTP-1F is a static page. There is no server side, no account, no login, and no analytics.

## What the page can reach

- **One kind of USB device.** Chrome only offers devices matching vendor `0x2367`, products `0x0102` and `0x8102` (`mtp.js`). Every other USB device stays hidden from the page.
- **One folder you choose.** It is opened through Chrome's folder picker with read and write access. Chrome asks again for permission on a later visit.
- **Nothing on the network.** The page makes no requests after it loads. The Content-Security-Policy in `index.html` enforces this: `connect-src 'none'`, and scripts and styles only from the page's own origin.

## Hardening in place

- **Strict CSP** (`index.html`): `default-src 'none'`, with no inline scripts or styles, no plugins, no form submission, and no `<base>` rewriting.
- **Trusted Types** (`require-trusted-types-for 'script'`, `trusted-types 'none'`): the browser refuses any HTML-string or script-string DOM write. The page builds its DOM with `createElement` and text nodes only.
- **No framing.** GitHub Pages cannot send `frame-ancestors`, so the page refuses to run when it is inside a frame (`app.js`). This stops another site from overlaying it and steering clicks onto Send or Remove.
- **No referrer** is sent when you follow a link off the page.
- **Device data is untrusted.** Names the unit reports are rejected if they contain `/`, `\`, `..` or control characters, or form an incomplete or cyclic folder tree (`volume.js`). Binary replies are read with bounds-checked `DataView`.

## Reporting a problem

Open an issue on the repository, or use the repository's Security tab to report privately.
