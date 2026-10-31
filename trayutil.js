// Pure helpers for the system tray. No GNOME imports here, so this file can
// be tested on its own.

// An app registers a tray icon in one of three ways:
//   "/org/ayatana/NotificationItem/x"   (just a path: the sender is the bus name)
//   "org.kde.StatusNotifierItem-12-1"   (just a bus name: the path is the default)
//   ":1.55/org/ayatana/NotificationItem/x" (both, as the watcher lists them)
export function parseService(service, sender) {
    if (typeof service !== 'string' || service === '')
        return null;

    let busName;
    let objPath;
    const slash = service.indexOf('/');
    if (slash === 0) {
        busName = sender;
        objPath = service;
    } else if (slash > 0) {
        busName = service.slice(0, slash);
        objPath = service.slice(slash);
    } else {
        busName = service;
        objPath = '/StatusNotifierItem';
    }
    if (!busName)
        return null;
    return {busName, objPath, id: `${busName}${objPath}`};
}

// Icon pixmaps arrive as ARGB32 in network byte order (the bytes are A, R, G,
// B). Pixel buffers want R, G, B, A.
export function argbToRgba(data, width, height) {
    const pixels = width * height;
    if (!data || width <= 0 || height <= 0 || data.length < pixels * 4)
        return null;

    const out = new Uint8Array(pixels * 4);
    for (let i = 0; i < pixels; i++) {
        const o = i * 4;
        out[o] = data[o + 1];
        out[o + 1] = data[o + 2];
        out[o + 2] = data[o + 3];
        out[o + 3] = data[o];
    }
    return out;
}

// Of the sizes an app offers, take the smallest one that is at least as big as
// wanted, otherwise the biggest there is.
export function pickPixmap(pixmaps, wanted) {
    if (!Array.isArray(pixmaps))
        return null;
    const usable = pixmaps.filter(p => Array.isArray(p) && p[0] > 0 && p[1] > 0 && p[2]?.length >= p[0] * p[1] * 4);
    if (usable.length === 0)
        return null;

    const bigEnough = usable.filter(p => Math.max(p[0], p[1]) >= wanted)
        .sort((a, b) => a[0] - b[0]);
    if (bigEnough.length > 0)
        return bigEnough[0];
    return usable.sort((a, b) => b[0] - a[0])[0];
}

// dbusmenu labels mark a keyboard shortcut letter with an underscore ("_Quit").
// A doubled underscore is a literal one.
export function cleanLabel(text) {
    return (text ?? '')
        .replace(/__/g, '\u0001')
        .replace(/_/g, '')
        .replace(/\u0001/g, '_');
}
