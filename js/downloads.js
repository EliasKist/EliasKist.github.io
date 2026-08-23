// Hands a finished transfer to the browser as a download.
//
// Bytes are collected as separate chunks and only assembled into a Blob when the transfer is
// complete and verified. Nothing is offered to the user before that, so a failed download cannot
// produce a file that looks valid.

const transfers = new Map();
const preparedShares = new Map();
let nextTransferId = 1;

export function open() {
    const id = nextTransferId++;
    transfers.set(id, []);
    return id;
}

export function append(transferId, data) {
    const parts = transfers.get(transferId);
    if (!parts) {
        throw new Error("invalid-handle");
    }

    parts.push(data);
}

export function discard(transferId) {
    transfers.delete(transferId);
}

export function save(transferId, fileName, mimeType) {
    return offer(transferId, fileName, mimeType, false).sizeBytes;
}

export function offer(transferId, fileName, mimeType, preferNativeShare) {
    const parts = transfers.get(transferId);
    if (!parts) {
        throw new Error("invalid-handle");
    }

    transfers.delete(transferId);
    const blob = new Blob(parts, { type: mimeType || "application/octet-stream" });
    if (preferNativeShare && supportsFileShare(blob, fileName)) {
        preparedShares.set(transferId, { blob, fileName });
        return {
            disposition: 1,
            shareHandle: transferId,
            sizeBytes: blob.size
        };
    }

    saveBlob(blob, fileName);
    return {
        disposition: 0,
        shareHandle: null,
        sizeBytes: blob.size
    };
}

export async function share(shareHandle) {
    const prepared = preparedShares.get(shareHandle);
    if (!prepared) {
        throw new Error("invalid-share-handle");
    }

    const file = createFile(prepared.blob, prepared.fileName);
    try {
        await navigator.share({ files: [file] });
        preparedShares.delete(shareHandle);
        return true;
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            return false;
        }

        throw error;
    }
}

export function discardShare(shareHandle) {
    preparedShares.delete(shareHandle);
}

export function saveText(fileName, text) {
    return saveBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), fileName);
}

function saveBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        anchor.rel = "noopener";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
    } finally {
        // The object URL stays valid until the browser started the download; releasing it on the
        // next macrotask is the documented way to avoid leaking it.
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    return blob.size;
}

function supportsFileShare(blob, fileName) {
    if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") {
        return false;
    }

    return navigator.canShare({ files: [createFile(blob, fileName)] });
}

function createFile(blob, fileName) {
    return new File([blob], fileName, {
        type: blob.type || "application/octet-stream",
        lastModified: Date.now()
    });
}
