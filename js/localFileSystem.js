// Device-local file storage of the Web client, backed by the Origin Private File System.
//
// A browser cannot keep a durable handle to a file in the user's own file tree, so DsSync Web
// treats the origin private file system as the storage of this device. Files enter it through an
// explicit import and leave it through an explicit download; nothing here reads or writes anywhere
// else on the machine.
//
// Every write goes to a temporary file first. The caller verifies the target and then promotes the
// temporary file, so a failed or interrupted transfer can never leave a truncated Save behind.

const readHandles = new Map();
const writeHandles = new Map();
let nextHandleId = 1;

async function root() {
    if (!navigator.storage?.getDirectory) {
        throw new Error("unsupported");
    }

    return await navigator.storage.getDirectory();
}

function splitPath(path) {
    const segments = String(path).split("/").filter(segment => segment.length > 0);
    if (segments.length === 0) {
        throw new Error("invalid-path");
    }

    for (const segment of segments) {
        if (segment === "." || segment === "..") {
            throw new Error("invalid-path");
        }
    }

    return { directories: segments.slice(0, -1), name: segments[segments.length - 1] };
}

async function directoryFor(path, create) {
    const { directories, name } = splitPath(path);
    let handle = await root();
    for (const segment of directories) {
        handle = await handle.getDirectoryHandle(segment, { create });
    }

    return { directory: handle, name };
}

async function fileHandle(path, create) {
    const { directory, name } = await directoryFor(path, create);
    return await directory.getFileHandle(name, { create });
}

// Availability is a property of the browser, not of a single call, so it is reported once and the
// interface decides what it can offer instead of failing at the first transfer.
//
// The property names of every object returned here are the interop contract with the .NET side and
// therefore match its property names.
export async function probe() {
    if (!navigator.storage?.getDirectory) {
        return { isSupported: false, reason: "no-origin-private-file-system" };
    }

    try {
        const directory = await navigator.storage.getDirectory();
        const probeHandle = await directory.getFileHandle(".dssync-probe", { create: true });
        if (typeof probeHandle.createWritable !== "function") {
            return { isSupported: false, reason: "no-writable-stream" };
        }

        const writable = await probeHandle.createWritable();
        await writable.close();
        await directory.removeEntry(".dssync-probe");
        return { isSupported: true, reason: "" };
    } catch (error) {
        return { isSupported: false, reason: error?.name ?? "unavailable" };
    }
}

export async function stat(path) {
    try {
        const handle = await fileHandle(path, false);
        const file = await handle.getFile();
        return { sizeBytes: file.size, lastModifiedMs: file.lastModified };
    } catch (error) {
        if (error?.name === "NotFoundError") {
            return null;
        }

        throw error;
    }
}

export async function list(prefix) {
    const results = [];
    let directory;
    try {
        directory = await root();
        for (const segment of String(prefix).split("/").filter(segment => segment.length > 0)) {
            directory = await directory.getDirectoryHandle(segment, { create: false });
        }
    } catch (error) {
        if (error?.name === "NotFoundError") {
            return results;
        }

        throw error;
    }

    for await (const [name, handle] of directory.entries()) {
        if (handle.kind !== "file") {
            continue;
        }

        const file = await handle.getFile();
        results.push({ name, sizeBytes: file.size, lastModifiedMs: file.lastModified });
    }

    return results;
}

export async function openRead(path) {
    const handle = await fileHandle(path, false);
    const file = await handle.getFile();
    const id = nextHandleId++;
    readHandles.set(id, file);
    return { handleId: id, sizeBytes: file.size, lastModifiedMs: file.lastModified };
}

// Reading in slices keeps a large ROM out of the WebAssembly heap: only the requested window is
// materialized, and the browser reads it from disk on demand.
export async function readChunk(handleId, offset, length) {
    const file = readHandles.get(handleId);
    if (!file) {
        throw new Error("invalid-handle");
    }

    const end = Math.min(offset + length, file.size);
    if (end <= offset) {
        return new Uint8Array(0);
    }

    const buffer = await file.slice(offset, end).arrayBuffer();
    return new Uint8Array(buffer);
}

export function closeRead(handleId) {
    readHandles.delete(handleId);
}

export async function beginWrite(path) {
    const handle = await fileHandle(path, true);
    const writable = await handle.createWritable({ keepExistingData: false });
    const id = nextHandleId++;
    writeHandles.set(id, { path, writable });
    return id;
}

export async function writeChunk(writeId, data) {
    const entry = writeHandles.get(writeId);
    if (!entry) {
        throw new Error("invalid-handle");
    }

    await entry.writable.write(data);
}

// Closing the writable is what makes the bytes visible under the temporary name. Until then the
// browser holds them in its own swap file.
export async function completeWrite(writeId) {
    const entry = writeHandles.get(writeId);
    if (!entry) {
        throw new Error("invalid-handle");
    }

    writeHandles.delete(writeId);
    await entry.writable.close();
}

export async function abortWrite(writeId) {
    const entry = writeHandles.get(writeId);
    if (!entry) {
        return;
    }

    writeHandles.delete(writeId);
    try {
        await entry.writable.abort();
    } catch {
        // An already closed stream needs no abort; the temporary file is removed below.
    }

    await remove(entry.path);
}

// Replaces the target with the temporary file. `move` does this in one step where the browser
// supports it. The fallback copies through a writable stream, which the browser also only commits
// to the target when the stream closes, so an interrupted promote leaves the previous target bytes
// in place either way.
export async function promote(temporaryPath, targetPath) {
    const source = await fileHandle(temporaryPath, false);
    const { directory, name } = await directoryFor(targetPath, true);
    if (typeof source.move === "function") {
        await source.move(directory, name);
        return "move";
    }

    const target = await directory.getFileHandle(name, { create: true });
    const file = await source.getFile();
    const writable = await target.createWritable({ keepExistingData: false });
    try {
        await file.stream().pipeTo(writable);
    } catch (error) {
        try {
            await writable.abort();
        } catch {
            // The stream may already be errored; the target keeps its previous content.
        }

        throw error;
    }

    await remove(temporaryPath);
    return "copy";
}

export async function remove(path) {
    try {
        const { directory, name } = await directoryFor(path, false);
        await directory.removeEntry(name);
        return true;
    } catch (error) {
        if (error?.name === "NotFoundError") {
            return false;
        }

        throw error;
    }
}

export async function persist() {
    if (!navigator.storage?.persist) {
        return false;
    }

    if (await navigator.storage.persisted()) {
        return true;
    }

    return await navigator.storage.persist();
}

export async function usage() {
    if (!navigator.storage?.estimate) {
        return null;
    }

    const estimate = await navigator.storage.estimate();
    return { usageBytes: estimate.usage ?? 0, quotaBytes: estimate.quota ?? 0 };
}
