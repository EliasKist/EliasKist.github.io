let tokenClient;
let accessToken;

const identityServicesTimeoutMs = 10000;
const identityServicesPollMs = 50;

// The Google Identity Services script is loaded asynchronously by the host page, so it may still
// be pending when the first authorization starts. Waiting here keeps the load order from
// deciding whether a connection attempt works.
async function waitForIdentityServices() {
    const deadline = Date.now() + identityServicesTimeoutMs;
    while (!globalThis.google?.accounts?.oauth2) {
        if (Date.now() >= deadline) {
            throw new Error("Google Identity Services did not load.");
        }

        await new Promise(resolve => setTimeout(resolve, identityServicesPollMs));
    }
}

export async function initialize(clientId, scope) {
    await waitForIdentityServices();

    tokenClient = globalThis.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope,
        callback: () => {},
        error_callback: () => {}
    });
}

export function requestAccessToken(forceConsent) {
    if (!tokenClient) {
        throw new Error("Google browser authorization is not initialized.");
    }

    return new Promise((resolve, reject) => {
        tokenClient.callback = response => {
            if (response.error) {
                reject(new Error(response.error));
                return;
            }

            accessToken = response.access_token;
            resolve({
                accessToken: response.access_token,
                expiresInSeconds: Number(response.expires_in)
            });
        };
        tokenClient.error_callback = error => reject(new Error(error.type ?? "oauth_error"));
        tokenClient.requestAccessToken({ prompt: forceConsent ? "consent" : "" });
    });
}

export function revoke() {
    if (!accessToken) {
        return Promise.resolve();
    }

    const token = accessToken;
    accessToken = undefined;
    return new Promise(resolve => globalThis.google.accounts.oauth2.revoke(token, resolve));
}

export function clear() {
    accessToken = undefined;
}
