import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// GNOME's own search providers (Files, Calculator, Settings, ...). Each one
// is a small D-Bus service described by an .ini file; this talks to them the
// same way the overview search does.

const IFACE = 'org.gnome.Shell.SearchProvider2';
const GROUP = 'Shell Search Provider';

function call(provider, method, signature, args, replyType) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(
            provider.busName,
            provider.objectPath,
            IFACE,
            method,
            new GLib.Variant(signature, args),
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE,
            4000,
            null,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

const unpack = value =>
    (value && typeof value.deepUnpack === 'function') ? value.deepUnpack() : value;

export function loadProviders() {
    let disabled = [];
    let sortOrder = [];
    try {
        const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.search-providers'});
        disabled = settings.get_strv('disabled');
        sortOrder = settings.get_strv('sort-order');
    } catch (_e) {
        // schema not installed: use everything
    }

    const found = [];
    const seen = new Set();
    const dirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()];
    for (const dir of dirs) {
        const folder = GLib.build_filenamev([dir, 'gnome-shell', 'search-providers']);
        let enumerator;
        try {
            enumerator = Gio.File.new_for_path(folder).enumerate_children('standard::name', 0, null);
        } catch (_e) {
            continue;
        }
        let info;
        while ((info = enumerator.next_file(null))) {
            const name = info.get_name();
            if (!name.endsWith('.ini'))
                continue;
            try {
                const keyFile = new GLib.KeyFile();
                keyFile.load_from_file(GLib.build_filenamev([folder, name]), GLib.KeyFileFlags.NONE);
                const desktopId = keyFile.get_string(GROUP, 'DesktopId');
                const busName = keyFile.get_string(GROUP, 'BusName');
                const objectPath = keyFile.get_string(GROUP, 'ObjectPath');
                let version = 1;
                try {
                    version = keyFile.get_integer(GROUP, 'Version');
                } catch (_e) {
                    // default
                }
                if (version < 2 || seen.has(desktopId) || disabled.includes(desktopId))
                    continue;
                const app = Gio.DesktopAppInfo.new(desktopId);
                if (!app)
                    continue;
                seen.add(desktopId);
                found.push({desktopId, busName, objectPath, app});
            } catch (_e) {
                // unreadable provider file
            }
        }
        enumerator.close(null);
    }

    const rank = id => {
        const i = sortOrder.indexOf(id);
        return i < 0 ? sortOrder.length : i;
    };
    return found.sort((a, b) => rank(a.desktopId) - rank(b.desktopId));
}

export async function queryProvider(provider, terms, limit = 5) {
    const initial = await call(provider, 'GetInitialResultSet', '(as)', [terms], '(as)');
    const [ids] = initial.deepUnpack();
    if (!ids || ids.length === 0)
        return null;

    const shown = ids.slice(0, limit);
    const reply = await call(provider, 'GetResultMetas', '(as)', [shown], '(aa{sv})');
    const [metas] = reply.deepUnpack();
    const results = metas.map(meta => {
        let gicon = null;
        try {
            if (meta.icon)
                gicon = Gio.icon_deserialize(meta.icon);
            else if (meta.gicon)
                gicon = Gio.icon_new_for_string(unpack(meta.gicon));
        } catch (_e) {
            // fall back to the app's icon
        }
        return {
            id: unpack(meta.id),
            name: unpack(meta.name) ?? '',
            description: unpack(meta.description) ?? '',
            gicon,
        };
    });
    return {provider, results, total: ids.length};
}

export function activateResult(provider, id, terms, time) {
    return call(provider, 'ActivateResult', '(sasu)', [id, terms, time], null);
}

export function launchSearch(provider, terms, time) {
    return call(provider, 'LaunchSearch', '(asu)', [terms, time], null);
}
