# Nova OS — offline PWA

This folder is a copy of Nova OS set up as an installable Progressive Web App. The original single-file OS (`../webos.html`) is left untouched.

The shell, built-in local apps, virtual filesystem, and settings work without a network connection after the first load. Live web content and the cloud account backend do not.

## Files

| File | Role |
| --- | --- |
| `index.html` | Nova OS, plus the manifest link, Apple meta tags, theme color, touch icon, and service-worker registration |
| `manifest.webmanifest` | Web app manifest (`name`: Nova OS, `start_url`/`scope`: `./`, `display`: standalone, 192/512 and maskable icons) |
| `sw.js` | Versioned cache, precache, cache-first for same-origin requests, navigation fallback to `index.html` |
| `apple-touch-icon.png` | 180×180 icon for iOS “Add to Home Screen” |
| `icon-192.png`, `icon-512.png` | Standard PWA icons |
| `icon-192-maskable.png`, `icon-512-maskable.png` | Maskable icons (artwork inset for the safe zone) |
| `vendor/supabase-js.mjs` | Local copy of supabase-js v2, so the library itself does not need a CDN |

All paths in the HTML, manifest, and service worker are **relative** (no leading `/`). Registering the worker with `navigator.serviceWorker.register('./sw.js')` and setting `start_url` / `scope` to `./` means the same files work:

- at the site root on Render, Netlify, or Cloudflare Pages (`https://example.com/`)
- under the GitHub Pages subpath `/nova-os/` (`https://<user>.github.io/nova-os/`)

Do not move or rename files independently. They must be served together from the same directory.

## Deploy

1. Serve this entire directory over **HTTPS**. Service workers and “Add to Home Screen” / standalone display will not work on `file://`, and iOS Safari requires HTTPS (localhost is allowed only for development).
2. Keep the directory structure intact. The service worker can only cache and control pages under its scope, which is this folder (`./`).
3. After you change `index.html`, icons, the manifest, the vendored library, or the worker itself, **bump the cache version** in `sw.js` (`CACHE_NAME`, currently `nova-os-offline-v1`). If you skip this, browsers will keep serving the old cached shell.
4. GitHub Pages: publish this folder as the `/nova-os/` site (or as a `nova-os` directory in the Pages repo). Visit `https://<user>.github.io/nova-os/`.
5. Render / Netlify / Cloudflare: publish this folder as a static site at the root. No build command is required.

### iPhone Safari

- Install via **Share → Add to Home Screen**. Standalone display (`display: standalone`, `apple-mobile-web-app-capable`) is not applied in a regular Safari tab.
- The first visit must happen online (and over HTTPS) so the service worker can cache the shell.
- After that, opening the home-screen icon works offline for the OS and local apps.
- Real iPhone service-worker behavior cannot be fully proven in desktop WebKit emulation.

## Using it offline

On first load the service worker precaches `index.html`, the manifest, the icons, and `vendor/supabase-js.mjs`. Later same-origin requests are **cache-first**, with a network fallback. If a navigation is offline and uncached, the worker falls back to the cached `index.html`.

`?guest` still opens guest mode. A previously chosen guest/account session stays in IndexedDB / localStorage on the device.

## What will not work offline

These need a live network and are not (and cannot usefully be) cached as the OS shell:

- **Accounts / cloud sync** — the Supabase project (`*.supabase.co`). Auth, settings sync, cloud files, and the app store depend on it. The supabase-js library is local; the API is not.
- **Weather** — Open-Meteo geocoding and forecast APIs.
- **Browser and web apps** that load remote sites: Wikipedia, Photopea, Excalidraw, tldraw, Desmos, JS Paint, Squoosh, GeoGebra, OpenStreetMap, Hacker News, Internet Archive, YouTube, Google, Bing, DuckDuckGo, Twitch, Vimeo, Spotify, and similar.
- **Sign-in redirect** to the hosted GitHub Pages URL, when the OS is opened from `file://` or plain HTTP.

Local apps such as File Manager, Settings, Notepad, Calculator, Paint, Code Runner, Terminal, Clock, Piano, Snake, Image Viewer, and bundled in-file apps (Photos, etc.) run from `index.html` and work offline.

## Updating

1. Edit the files in this folder.
2. Change `CACHE_NAME` in `sw.js` (for example `nova-os-offline-v2`).
3. Redeploy the whole directory.
4. Clients pick up the new worker on the next online visit; `skipWaiting` and `clients.claim` activate it immediately, and the old cache is deleted.
