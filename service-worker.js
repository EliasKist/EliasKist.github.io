/* Manifest version: dnZH6+a0 */
// Production service worker.
//
// It caches the application shell - the files that were published with this build - so DsSync can
// start without a network. It caches nothing else. Save content, ROM content, Cloud metadata, and
// every request that carries an Authorization header go to the network and are never stored:
// keeping Save bytes in a browser cache would be a data-at-rest decision that DsSync has not taken
// (see ADR 0005). Cross-origin requests, which is everything that talks to Google, are passed
// through untouched.
//
// A new build activates when no tab of the old one is left. That is deliberate: swapping assets
// under a running WebAssembly application would mix two versions of the Sync rules.

self.importScripts('./service-worker-assets.js');

self.addEventListener('install', event => event.waitUntil(onInstall(event)));
self.addEventListener('activate', event => event.waitUntil(onActivate(event)));
self.addEventListener('fetch', event => event.respondWith(onFetch(event)));

const cacheNamePrefix = 'dssync-shell-';
const cacheName = `${cacheNamePrefix}${self.assetsManifest.version}`;
// Everything the application needs in order to start. appsettings.json belongs in here: the
// configuration is read during startup, so without it an offline start reaches the runtime and then
// stops at the loading screen. It holds deployment parameters, never a credential.
const shellInclude = [
    /\.css$/, /\.js$/, /\.html$/, /\.webmanifest$/, /\.json$/,
    /\.wasm$/, /\.dat$/, /\.blat$/,
    /\.png$/, /\.svg$/, /\.ico$/,
    /\.woff2?$/,
];
const shellExclude = [/^service-worker\.js$/, /^service-worker-assets\.js$/];

async function onInstall() {
    const requests = self.assetsManifest.assets
        .filter(asset => shellInclude.some(pattern => pattern.test(asset.url)))
        .filter(asset => !shellExclude.some(pattern => pattern.test(asset.url)))
        .map(asset => new Request(asset.url, { integrity: asset.hash, cache: 'no-cache' }));
    await caches.open(cacheName).then(cache => cache.addAll(requests));
}

async function onActivate() {
    const names = await caches.keys();
    await Promise.all(names
        .filter(name => name.startsWith(cacheNamePrefix) && name !== cacheName)
        .map(name => caches.delete(name)));
}

async function onFetch(event) {
    const request = event.request;
    if (request.method !== 'GET' || request.headers.has('Authorization')) {
        return fetch(request);
    }

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) {
        // Google Identity Services and the Drive API. Nothing here is ours to cache.
        return fetch(request);
    }

    // A navigation to any route is answered with the shell; the router inside the application
    // resolves the path.
    const key = request.mode === 'navigate'
        ? 'index.html'
        : url.pathname.replace(self.registration.scope.replace(self.location.origin, ''), '');
    const cache = await caches.open(cacheName);
    const cached = await cache.match(key) ?? await cache.match(request);
    return cached ?? fetch(request);
}
