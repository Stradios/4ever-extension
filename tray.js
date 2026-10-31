import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

import {parseService, argbToRgba, pickPixmap} from './trayutil.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

const WATCHER_NAME = 'org.kde.StatusNotifierWatcher';
const WATCHER_PATH = '/StatusNotifierWatcher';
const WATCHER_IFACE = 'org.kde.StatusNotifierWatcher';
const ITEM_IFACE = 'org.kde.StatusNotifierItem';
const MENU_IFACE = 'com.canonical.dbusmenu';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const CALL_TIMEOUT_MS = 5000;
const ICON_SIZE = 24;

const WATCHER_XML = `
<node>
  <interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem">
      <arg type="s" direction="in" name="service"/>
    </method>
    <method name="RegisterStatusNotifierHost">
      <arg type="s" direction="in" name="service"/>
    </method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered">
      <arg type="s"/>
    </signal>
    <signal name="StatusNotifierItemUnregistered">
      <arg type="s"/>
    </signal>
    <signal name="StatusNotifierHostRegistered"/>
    <signal name="StatusNotifierHostUnregistered"/>
  </interface>
</node>`;

function dbusCall(busName, path, iface, method, signature = null, args = [], replyType = null) {
    return Gio.DBus.session.call(
        busName,
        path,
        iface,
        method,
        signature ? new GLib.Variant(signature, args) : null,
        replyType ? new GLib.VariantType(replyType) : null,
        Gio.DBusCallFlags.NONE,
        CALL_TIMEOUT_MS,
        null);
}

// One icon in the tray (a StatusNotifierItem somewhere on the session bus)
export class TrayItem {
    constructor(manager, id, busName, objPath) {
        this._manager = manager;
        this.id = id;
        this.busName = busName;
        this.objPath = objPath;
        this.props = {};
        this.ready = false;
        this._subscriptions = [];
        this._refreshTimer = 0;
        this._destroyed = false;
        this._iconCacheKey = null;
        this._iconCache = null;
    }

    async init() {
        await this._refresh();
        if (this._destroyed)
            return;

        // The app tells us when something about it changed
        const signals = ['NewTitle', 'NewIcon', 'NewAttentionIcon', 'NewOverlayIcon', 'NewToolTip', 'NewStatus'];
        for (const name of signals) {
            this._subscriptions.push(Gio.DBus.session.signal_subscribe(
                this.busName, ITEM_IFACE, name, this.objPath, null,
                Gio.DBusSignalFlags.NONE, () => this._queueRefresh()));
        }
        this.ready = true;
    }

    async _refresh() {
        const reply = await dbusCall(this.busName, this.objPath, PROPS_IFACE, 'GetAll',
            '(s)', [ITEM_IFACE], '(a{sv})');
        if (this._destroyed)
            return;
        this.props = reply.recursiveUnpack()[0] ?? {};
        this._iconCacheKey = null;
    }

    _queueRefresh() {
        if (this._refreshTimer || this._destroyed)
            return;
        this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            this._refreshTimer = 0;
            this._refresh()
                .then(() => this._manager.changed())
                .catch(() => {});
            return GLib.SOURCE_REMOVE;
        });
    }

    get title() {
        const p = this.props;
        return p.Title || p.ToolTip?.[2] || p.Id || '';
    }

    get menuPath() {
        const path = this.props.Menu;
        return path && path !== '/NO_DBUSMENU' ? path : null;
    }

    get itemIsMenu() {
        return this.props.ItemIsMenu === true;
    }

    // The picture to show. The app's own pixmap is preferred (it shows
    // things like unread counts); otherwise the named theme icon.
    gicon() {
        const p = this.props;
        const needsAttention = p.Status === 'NeedsAttention';
        const name = (needsAttention && p.AttentionIconName) ? p.AttentionIconName : p.IconName;
        const pixmaps = (needsAttention && p.AttentionIconPixmap?.length) ? p.AttentionIconPixmap : p.IconPixmap;

        const key = `${name}|${p.IconThemePath}|${pixmaps?.length}|${pixmaps?.[0]?.[2]?.length}|${p.Status}`;
        if (this._iconCacheKey === key && this._iconCache)
            return this._iconCache;

        let icon = null;
        try {
            const pixmap = pickPixmap(pixmaps, ICON_SIZE);
            if (pixmap) {
                const [width, height, data] = pixmap;
                const rgba = argbToRgba(data, width, height);
                if (rgba) {
                    const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
                        GLib.Bytes.new(rgba), GdkPixbuf.Colorspace.RGB, true, 8, width, height, width * 4);
                    const [, png] = pixbuf.save_to_bufferv('png', [], []);
                    icon = new Gio.BytesIcon({bytes: GLib.Bytes.new(png)});
                }
            }
        } catch (e) {
            console.error(`[4ever] tray icon of ${this.id}: ${e.message}`);
        }

        if (!icon && name) {
            if (name.startsWith('/')) {
                icon = Gio.FileIcon.new(Gio.File.new_for_path(name));
            } else if (p.IconThemePath) {
                for (const ext of ['png', 'svg']) {
                    const path = GLib.build_filenamev([p.IconThemePath, `${name}.${ext}`]);
                    if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
                        icon = Gio.FileIcon.new(Gio.File.new_for_path(path));
                        break;
                    }
                }
            }
            icon ??= new Gio.ThemedIcon({names: [name, 'application-x-executable']});
        }

        icon ??= new Gio.ThemedIcon({name: 'application-x-executable'});
        this._iconCacheKey = key;
        this._iconCache = icon;
        return icon;
    }

    activate(x, y) {
        return dbusCall(this.busName, this.objPath, ITEM_IFACE, 'Activate', '(ii)', [x, y]);
    }

    secondaryActivate(x, y) {
        return dbusCall(this.busName, this.objPath, ITEM_IFACE, 'SecondaryActivate', '(ii)', [x, y]);
    }

    contextMenu(x, y) {
        return dbusCall(this.busName, this.objPath, ITEM_IFACE, 'ContextMenu', '(ii)', [x, y]);
    }

    // The app's right-click menu (com.canonical.dbusmenu): [id, props, children]
    async fetchMenu() {
        const path = this.menuPath;
        if (!path)
            return null;
        try {
            await dbusCall(this.busName, path, MENU_IFACE, 'AboutToShow', '(i)', [0], '(b)');
        } catch (_e) {
            // optional
        }
        const reply = await dbusCall(this.busName, path, MENU_IFACE, 'GetLayout',
            '(iias)', [0, -1, []], '(u(ia{sv}av))');
        return reply.recursiveUnpack()[1];
    }

    menuEvent(menuItemId) {
        return dbusCall(this.busName, this.menuPath, MENU_IFACE, 'Event', '(isvu)',
            [menuItemId, 'clicked', new GLib.Variant('i', 0), Math.floor(Date.now() / 1000)]);
    }

    destroy() {
        this._destroyed = true;
        this.ready = false;
        if (this._refreshTimer) {
            GLib.source_remove(this._refreshTimer);
            this._refreshTimer = 0;
        }
        for (const id of this._subscriptions)
            Gio.DBus.session.signal_unsubscribe(id);
        this._subscriptions = [];
    }
}

// Keeps the list of tray icons. If nothing else on the system provides the
// StatusNotifierWatcher service, this is the watcher (apps register with it).
// If something else already does (for example the AppIndicator extension),
// it simply reads the icons from that one.
export class TrayManager {
    constructor(onChange) {
        this._onChange = onChange;
        this._items = new Map();
        this._nameWatches = new Map();
        this._subscriptions = [];
        this._started = false;
        this._isWatcher = false;
        this._client = false;
    }

    get items() {
        return [...this._items.values()].filter(item => item.ready);
    }

    changed() {
        if (this._started)
            this._onChange?.();
    }

    start() {
        if (this._started)
            return;
        this._started = true;

        this._hostName = `org.kde.StatusNotifierHost-forever-${GLib.random_int_range(1000, 999999)}`;
        this._hostOwnerId = Gio.bus_own_name(
            Gio.BusType.SESSION, this._hostName, Gio.BusNameOwnerFlags.NONE, null, null, null);

        this._impl = Gio.DBusExportedObject.wrapJSObject(WATCHER_XML, this);
        this._impl.export(Gio.DBus.session, WATCHER_PATH);
        this._watcherOwnerId = Gio.bus_own_name(
            Gio.BusType.SESSION, WATCHER_NAME, Gio.BusNameOwnerFlags.DO_NOT_QUEUE, null,
            () => {
                this._isWatcher = true;
                this._impl?.emit_signal('StatusNotifierHostRegistered', null);
            },
            () => {
                this._isWatcher = false;
                this._becomeClient();
            });
    }

    // ---- the StatusNotifierWatcher interface (when this is the watcher) ----

    get RegisteredStatusNotifierItems() {
        return [...this._items.keys()];
    }

    get IsStatusNotifierHostRegistered() {
        return true;
    }

    get ProtocolVersion() {
        return 0;
    }

    RegisterStatusNotifierItemAsync([service], invocation) {
        const sender = invocation.get_sender();
        invocation.return_value(null);
        this._addItem(service, sender);
    }

    RegisterStatusNotifierHostAsync(_params, invocation) {
        invocation.return_value(null);
    }

    // ---- when another watcher is running ----

    async _becomeClient() {
        if (this._client || !this._started)
            return;
        this._client = true;

        const connection = Gio.DBus.session;
        const onSignal = (add) => (_c, _sender, _path, _iface, _signal, parameters) => {
            const [service] = parameters.recursiveUnpack();
            if (add)
                this._addItem(service, null);
            else
                this._removeItem(parseService(service, null)?.id);
        };
        this._subscriptions.push(connection.signal_subscribe(
            WATCHER_NAME, WATCHER_IFACE, 'StatusNotifierItemRegistered', WATCHER_PATH, null,
            Gio.DBusSignalFlags.NONE, onSignal(true)));
        this._subscriptions.push(connection.signal_subscribe(
            WATCHER_NAME, WATCHER_IFACE, 'StatusNotifierItemUnregistered', WATCHER_PATH, null,
            Gio.DBusSignalFlags.NONE, onSignal(false)));

        try {
            const reply = await dbusCall(WATCHER_NAME, WATCHER_PATH, PROPS_IFACE, 'Get',
                '(ss)', [WATCHER_IFACE, 'RegisteredStatusNotifierItems'], '(v)');
            const [services] = reply.recursiveUnpack();
            for (const service of services ?? [])
                this._addItem(service, null);
            await dbusCall(WATCHER_NAME, WATCHER_PATH, WATCHER_IFACE, 'RegisterStatusNotifierHost',
                '(s)', [this._hostName]);
        } catch (e) {
            console.error(`[4ever] could not read the existing tray watcher: ${e.message}`);
        }
    }

    // ---- items ----

    _addItem(service, sender) {
        if (!this._started)
            return;
        const parsed = parseService(service, sender);
        if (!parsed || this._items.has(parsed.id))
            return;

        const {busName, objPath, id} = parsed;
        const item = new TrayItem(this, id, busName, objPath);
        this._items.set(id, item);

        item.init().then(() => {
            if (!this._started || this._items.get(id) !== item)
                return;
            // Drop the icon when the app quits
            this._nameWatches.set(id, Gio.bus_watch_name_on_connection(
                Gio.DBus.session, busName, Gio.BusNameWatcherFlags.NONE, null,
                () => this._removeItem(id)));
            if (this._isWatcher)
                this._impl?.emit_signal('StatusNotifierItemRegistered', new GLib.Variant('(s)', [id]));
            this.changed();
        }).catch(() => {
            // not a working tray item
            if (this._items.get(id) === item)
                this._removeItem(id);
        });
    }

    _removeItem(id) {
        const item = id ? this._items.get(id) : null;
        if (!item)
            return;
        this._items.delete(id);
        item.destroy();

        const watch = this._nameWatches.get(id);
        if (watch) {
            Gio.bus_unwatch_name(watch);
            this._nameWatches.delete(id);
        }
        if (this._isWatcher)
            this._impl?.emit_signal('StatusNotifierItemUnregistered', new GLib.Variant('(s)', [id]));
        this.changed();
    }

    destroy() {
        this._started = false;
        for (const item of this._items.values())
            item.destroy();
        this._items.clear();

        for (const watch of this._nameWatches.values())
            Gio.bus_unwatch_name(watch);
        this._nameWatches.clear();

        for (const id of this._subscriptions)
            Gio.DBus.session.signal_unsubscribe(id);
        this._subscriptions = [];

        if (this._impl) {
            this._impl.unexport();
            this._impl = null;
        }
        if (this._watcherOwnerId) {
            Gio.bus_unown_name(this._watcherOwnerId);
            this._watcherOwnerId = 0;
        }
        if (this._hostOwnerId) {
            Gio.bus_unown_name(this._hostOwnerId);
            this._hostOwnerId = 0;
        }
        this._isWatcher = false;
        this._client = false;
    }
}
