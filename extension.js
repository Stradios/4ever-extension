import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import {TrayManager} from './tray.js';
import {cleanLabel} from './trayutil.js';
import {loadProviders, queryProvider, activateResult, launchSearch} from './searchproviders.js';

const RECOMMENDED_COUNT = 6;
const MAX_SEARCH_RESULTS = 20;

const VIEW_MODES = [
    ['category', 'Category'],
    ['grid', 'Grid'],
    ['list', 'List'],
];

const SEARCH_MODES = [
    ['hidden', 'Hide'],
    ['icon', 'Search icon only'],
    ['box', 'Search box'],
];

const THEME_MODES = [
    ['system', 'Follow system'],
    ['light', 'Light'],
    ['dark', 'Dark'],
];

// Used only the first time, before the user has pinned anything to Start.
const DEFAULT_START_PINS = [
    'org.gnome.Nautilus.desktop',
    'firefox.desktop',
    'org.mozilla.firefox.desktop',
    'org.gnome.Ptyxis.desktop',
    'org.gnome.Console.desktop',
    'org.gnome.Settings.desktop',
    'org.gnome.TextEditor.desktop',
    'org.gnome.Calculator.desktop',
    'org.gnome.Software.desktop',
    'org.gnome.Calendar.desktop',
];

// Freedesktop menu categories -> the groups shown in the "All" category view.
const CATEGORY_RULES = [
    ['Accessibility', ['Accessibility']],
    ['Games', ['Game']],
    ['Creativity', ['Graphics', 'Photography', '2DGraphics', '3DGraphics', 'RasterGraphics', 'VectorGraphics', 'Recorder']],
    ['Entertainment', ['AudioVideo', 'Audio', 'Video', 'Player', 'Music', 'Midi', 'Mixer', 'TV']],
    ['Productivity', ['Office', 'Calendar', 'TextEditor', 'Email', 'WebBrowser', 'Network', 'Education', 'Science',
        'Documentation', 'ProjectManagement', 'ContactManagement', 'Dictionary', 'Viewer']],
    ['Utilities & Tools', ['Utility', 'System', 'Settings', 'Development', 'TerminalEmulator', 'PackageManager',
        'Monitor', 'FileManager', 'Core', 'Archiving', 'Calculator']],
];

function categoryOf(app) {
    let raw = '';
    try {
        raw = app.get_app_info()?.get_categories?.() ?? '';
    } catch (_e) {
        raw = '';
    }
    const cats = raw.split(';').filter(c => c);
    for (const [name, keys] of CATEGORY_RULES) {
        if (cats.some(c => keys.includes(c)))
            return name;
    }
    return 'Other';
}

// Run a callback after the current event has finished, so widgets can be
// destroyed safely from inside their own signal handlers.
function nowMs() {
    return Math.floor(GLib.get_monotonic_time() / 1000);
}

function defer(fn) {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        try {
            fn();
        } catch (e) {
            console.error(`[4ever] ${e.message}`);
        }
        return GLib.SOURCE_REMOVE;
    });
}

function hasProgram(name) {
    return !!GLib.find_program_in_path(name);
}

function spawn(command) {
    try {
        GLib.spawn_command_line_async(command);
    } catch (e) {
        console.error(`[4ever] could not run "${command}": ${e.message}`);
    }
}

function vadjustmentOf(scroll) {
    try {
        return scroll.vscroll?.adjustment ?? scroll.vadjustment ?? null;
    } catch (_e) {
        return null;
    }
}

function hadjustmentOf(scroll) {
    try {
        return scroll.hscroll?.adjustment ?? scroll.hadjustment ?? null;
    } catch (_e) {
        return null;
    }
}

export default class Forever extends Extension {
    enable() {
        this._signals = [];
        this._appMenus = [];
        this._bars = [];
        this._trayUis = [];
        this._hiddenWindows = [];
        this._layoutTimers = [];
        this._allAppsCache = null;
        this._pendingQuery = null;
        this._gs = this.getSettings();
        this._startPins = this._loadPins();
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

        this._panelBox = Main.layoutManager.panelBox;
        this._panel = Main.panel;
        this._panel.add_style_class_name('forever-panel');

        this._moveToBottom();
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            this._moveToBottom();
            this._rebuildBars();
        });
        this._connect(this._panelBox, 'notify::height', () => this._moveToBottom());

        // Light / dark: follows GNOME unless the user picked one
        this._connect(this._iface, 'changed::color-scheme', () => this._applyTheme());
        this._applyTheme();
        this._applyPanelSize();

        // Hide Activities, move the date menu (calendar + notifications) to the right
        this._panel.statusArea.activities?.hide();
        const dm = this._panel.statusArea.dateMenu;
        this._dateContainer = dm?.container;
        if (this._dateContainer) {
            this._panel._centerBox.remove_child(this._dateContainer);
            this._panel._rightBox.add_child(this._dateContainer);
        }

        this._setupClock();
        this._setupDateMenu();
        this._setupNotifications();
        this._setupShowDesktop();

        // Taskbar in the center box
        this._taskbar = new St.BoxLayout({style_class: 'forever-taskbar'});
        this._panel._centerBox.add_child(this._taskbar);

        this._buildStartMenu();
        this._buildTaskbarExtras();
        this._rebuildApps();
        this._setupTray();
        this._rebuildBars();
        this._applyTaskbarLook();
        this._applyOpacity();
        this._applyOverviewDash();

        // Some other part of GNOME can reset the panel's height while logging
        // in. Put ours back whenever that happens, and once more after startup.
        this._connect(this._panel, 'notify::style', () => {
            if (!this._panel.style?.includes('height:'))
                defer(() => this._gs && this._applyPanelSize());
        });
        for (const ms of [0, 500, 2000]) {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._layoutTimers = this._layoutTimers.filter(t => t !== id);
                if (this._gs) {
                    this._applyOpacity();
                    this._moveToBottom();
                }
                return GLib.SOURCE_REMOVE;
            });
            this._layoutTimers.push(id);
        }

        // Right-click on the empty taskbar: search + theme options
        this._connect(this._panel, 'button-press-event', (_a, event) => this._onPanelPress(event));

        const sys = Shell.AppSystem.get_default();
        this._connect(sys, 'app-state-changed', () => this._rebuildApps());
        this._connect(sys, 'installed-changed', () => {
            this._allAppsCache = null;
        });
        this._connect(AppFavorites.getAppFavorites(), 'changed', () => this._rebuildApps());
        this._connect(Shell.WindowTracker.get_default(), 'notify::focus-app', () => this._rebuildApps());

        // Live updates from the Settings window
        this._connect(this._gs, 'changed', (_settings, key) => this._onSettingChanged(key));
        this._overrideOverlayKey();
        this._skipLoginOverview();
    }

    // The row of pinned and running apps along the bottom of the overview
    _applyOverviewDash() {
        const dash = Main.overview.dash;
        if (!dash)
            return;
        if (this._dashSignal) {
            dash.disconnect(this._dashSignal);
            this._dashSignal = 0;
        }
        if (this._gs.get_boolean('hide-overview-dash')) {
            dash.hide();
            this._dashHidden = true;
            this._dashSignal = dash.connect('notify::visible', () => {
                if (dash.visible)
                    dash.hide();
            });
        } else if (this._dashHidden) {
            dash.show();
            this._dashHidden = false;
        }
    }

    _restoreOverviewDash() {
        const dash = Main.overview.dash;
        if (dash && this._dashSignal)
            dash.disconnect(this._dashSignal);
        this._dashSignal = 0;
        if (dash && this._dashHidden)
            dash.show();
        this._dashHidden = false;
    }

    // GNOME opens the Activities overview after login. Go straight to the desktop.
    _skipLoginOverview() {
        const lm = Main.layoutManager;
        if (!lm._startingUp || !this._gs.get_boolean('skip-login-overview'))
            return;
        this._overviewWasAllowed = Main.sessionMode.hasOverview;
        Main.sessionMode.hasOverview = false;
        try {
            lm.startInOverview = false;
        } catch (_e) {
            // property not present
        }
        this._connect(lm, 'startup-complete', () => {
            this._restoreOverview();
            defer(() => {
                if (Main.overview.visible)
                    Main.overview.hide();
            });
        });
    }

    _restoreOverview() {
        if (this._overviewWasAllowed !== undefined) {
            Main.sessionMode.hasOverview = this._overviewWasAllowed;
            this._overviewWasAllowed = undefined;
        }
    }

    disable() {
        this._restoreOverview();
        this._restoreOverviewDash();
        for (const [obj, id] of this._signals ?? [])
            obj.disconnect(id);
        this._signals = null;

        if (this._providerTimer) {
            GLib.source_remove(this._providerTimer);
            this._providerTimer = 0;
        }
        this._providers = null;
        this._providerSections = null;
        for (const id of this._layoutTimers ?? [])
            GLib.source_remove(id);
        this._layoutTimers = [];
        this._restoreOverlayKey();
        this._unwatchSuperKey();
        this._teardownBars();
        this._showDesktopButton?.destroy();
        this._showDesktopButton = null;
        this._hiddenWindows = [];
        this._teardownTray();
        this._hideTooltip();
        this._teardownClock();
        this._teardownDateMenu();
        this._teardownNotifications();
        this._clearAppMenus();

        for (const key of ['_menu', '_winxMenu', '_taskbarMenu']) {
            const menu = this[key];
            if (!menu)
                continue;
            try {
                Main.panel.menuManager.removeMenu(menu);
            } catch (_e) {
                // already removed
            }
            menu.destroy();
            this[key] = null;
        }
        this._anchor?.destroy();
        this._anchor = null;
        this._taskbar?.destroy();
        this._taskbar = null;
        this._startButton = null;
        this._searchWidget = null;
        this._searchEntry = null;
        this._taskViewButton = null;
        this._root = null;

        Main.uiGroup.remove_style_class_name('forever-light');
        this._iface = null;

        if (this._dateContainer) {
            this._panel._rightBox.remove_child(this._dateContainer);
            this._panel._centerBox.add_child(this._dateContainer);
        }
        this._dateContainer = null;
        this._panel.statusArea.activities?.show();
        this._panel.remove_style_class_name('forever-panel');
        this._panel.style = '';
        this._startIcon = null;
        this._gs = null;

        const m = Main.layoutManager.primaryMonitor;
        this._panelBox.set_position(m.x, m.y);
    }

    _connect(obj, name, cb) {
        this._signals.push([obj, obj.connect(name, cb)]);
    }

    _svgIcon(name) {
        return Gio.FileIcon.new(Gio.File.new_for_path(GLib.build_filenamev([this.path, name])));
    }

    // ------------------------------------------------------------------
    // Theme
    // ------------------------------------------------------------------

    _applyTheme() {
        let light = false;
        const mode = this._gs.get_string('theme');
        if (mode === 'light') {
            light = true;
        } else if (mode === 'system') {
            const scheme = this._iface?.get_string('color-scheme');
            light = scheme === 'default' || scheme === 'prefer-light';
        }
        if (light)
            Main.uiGroup.add_style_class_name('forever-light');
        else
            Main.uiGroup.remove_style_class_name('forever-light');
        if (this._taskbar) {
            this._applyOpacity();
            this._rebuildApps();
            if (this._gs.get_string('icon-style') === 'auto')
                this._refreshPackIcons();
        }
    }

    // ------------------------------------------------------------------
    // Start icon: the distribution's own logo
    // ------------------------------------------------------------------

    _osLogoIcon() {
        const names = [];
        const add = name => {
            if (name && !names.includes(name))
                names.push(name);
        };
        const osInfo = key => {
            try {
                return GLib.get_os_info(key);
            } catch (_e) {
                return null;
            }
        };

        // os-release: LOGO= is the distribution's own icon name
        add(osInfo('LOGO'));
        const ids = [osInfo('ID'), ...(osInfo('ID_LIKE') ?? '').split(' ')].filter(id => id);
        for (const id of ids) {
            add(`${id}-logo`);
            add(`${id}-logo-icon`);
            add(`distributor-logo-${id}`);
            add(id);
            if (id === 'arch') {
                add('archlinux-logo');
                add('archlinux');
            }
        }
        add('distributor-logo');

        let theme = null;
        try {
            theme = new St.IconTheme();
        } catch (_e) {
            theme = null;
        }

        for (const name of names) {
            try {
                if (theme?.has_icon(name))
                    return new Gio.ThemedIcon({name});
            } catch (_e) {
                // theme lookup unavailable: fall through to the file search
            }
            const file = this._findIconFile(name);
            if (file)
                return Gio.FileIcon.new(file);
        }
        return this._svgIcon('start.svg');
    }

    _findIconFile(name) {
        const dirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()];
        const relatives = [
            'pixmaps/{n}.svg',
            'pixmaps/{n}.png',
            'icons/hicolor/scalable/apps/{n}.svg',
            'icons/hicolor/256x256/apps/{n}.png',
            'icons/hicolor/128x128/apps/{n}.png',
            'icons/hicolor/64x64/apps/{n}.png',
            'icons/hicolor/48x48/apps/{n}.png',
        ];
        const themeSubdirs = [
            'scalable/apps', 'scalable/places', 'scalable/distros', 'scalable/emblems',
            '256x256/apps', '128x128/apps', '96x96/apps', '64x64/apps', '48x48/apps',
            '64/apps', '48/apps', '64/places', '48/places',
        ];
        const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);

        for (const dir of dirs) {
            for (const rel of relatives) {
                const path = GLib.build_filenamev([dir, rel.replace('{n}', name)]);
                if (exists(path))
                    return Gio.File.new_for_path(path);
            }

            // Installed icon themes (e.g. a distribution's own theme)
            let themes = [];
            try {
                const iconsDir = Gio.File.new_for_path(GLib.build_filenamev([dir, 'icons']));
                const children = iconsDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = children.next_file(null)))
                    themes.push(info.get_name());
            } catch (_e) {
                themes = [];
            }
            for (const theme of themes) {
                for (const sub of themeSubdirs) {
                    for (const ext of ['svg', 'png']) {
                        const path = GLib.build_filenamev([dir, 'icons', theme, sub, `${name}.${ext}`]);
                        if (exists(path))
                            return Gio.File.new_for_path(path);
                    }
                }
            }
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Panel placement
    // ------------------------------------------------------------------

    _moveToBottom() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m)
            return;
        this._panelBox.set_position(m.x, m.y + m.height - this._panelBox.height);
        this._positionAnchor();
    }

    // Invisible 1px actor at the horizontal center of the screen, just above
    // the taskbar. The Start menu attaches to this instead of the Start button,
    // so it opens centered on the screen.
    _positionAnchor(monitorIndex = null) {
        const lm = Main.layoutManager;
        const onOther = monitorIndex !== null && monitorIndex !== lm.primaryIndex && lm.monitors[monitorIndex];
        const m = onOther ? lm.monitors[monitorIndex] : lm.primaryMonitor;
        if (!m || !this._anchor)
            return;
        const barHeight = onOther ? this._gs.get_int('taskbar-height') : this._panelBox.height;
        const gap = 12;
        this._anchor.set_position(
            Math.round(m.x + m.width / 2),
            Math.round(m.y + m.height - barHeight - gap));
    }

    // The monitor under the pointer, if it has an 4ever taskbar of its own
    _pointerBarMonitor() {
        let index = null;
        try {
            index = global.display.get_current_monitor();
        } catch (_e) {
            return null;
        }
        return this._bars.some(bar => bar.index === index) ? index : null;
    }

    // ------------------------------------------------------------------
    // Small UI helpers
    // ------------------------------------------------------------------

    // A clickable row. A plain reactive BoxLayout (not St.Button) so its
    // content always starts at the left instead of being centered.
    _clickable(styleClass, onClick, {allowRight = false} = {}) {
        const actor = new St.BoxLayout({
            style_class: styleClass,
            reactive: true,
            track_hover: true,
            can_focus: true,
        });
        let pressed = 0;
        actor.connect('button-press-event', (_a, event) => {
            const button = event.get_button();
            if (button === 1 || (allowRight && button === 3)) {
                pressed = button;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        actor.connect('button-release-event', (_a, event) => {
            const button = event.get_button();
            if (pressed && pressed === button) {
                pressed = 0;
                if (actor.hover)
                    onClick(button);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        actor.connect('leave-event', () => {
            pressed = 0;
            return Clutter.EVENT_PROPAGATE;
        });
        actor.connect('key-press-event', (_a, event) => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter || key === Clutter.KEY_space) {
                onClick(1);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        return actor;
    }

    // ------------------------------------------------------------------
    // Tooltips for taskbar buttons
    // ------------------------------------------------------------------

    _attachTooltip(actor, text) {
        actor.connect('notify::hover', () => {
            this._hideTooltip();
            if (!actor.hover)
                return;
            this._tooltipTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._tooltipTimer = 0;
                this._showTooltip(actor, text);
                return GLib.SOURCE_REMOVE;
            });
        });
        actor.connect('button-press-event', () => {
            this._hideTooltip();
            return Clutter.EVENT_PROPAGATE;
        });
        actor.connect('destroy', () => this._hideTooltip());
    }

    _showTooltip(actor, text) {
        this._hideTooltip();
        const tip = new St.Label({text, style_class: 'forever-tooltip'});
        Main.uiGroup.add_child(tip);
        const [x, y] = actor.get_transformed_position();
        const [, width] = tip.get_preferred_width(-1);
        const [, height] = tip.get_preferred_height(width);
        tip.set_position(
            Math.round(x + (actor.width - width) / 2),
            Math.round(y - height - 10));
        this._tooltip = tip;
    }

    _hideTooltip() {
        if (this._tooltipTimer) {
            GLib.source_remove(this._tooltipTimer);
            this._tooltipTimer = 0;
        }
        this._tooltip?.destroy();
        this._tooltip = null;
    }

    // ------------------------------------------------------------------
    // Clock: time on top, date below, right-aligned
    // ------------------------------------------------------------------

    _setupClock() {
        const dm = this._panel.statusArea.dateMenu;
        const label = dm?._clockDisplay;
        const parent = label?.get_parent();
        if (!label || !parent)
            return;

        this._clockLabel = label;
        this._clockBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'forever-clock',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clockTime = new St.Label({style_class: 'forever-clock-time', x_align: Clutter.ActorAlign.END});
        this._clockDate = new St.Label({style_class: 'forever-clock-date', x_align: Clutter.ActorAlign.END});
        this._clockBox.add_child(this._clockTime);
        this._clockBox.add_child(this._clockDate);
        parent.add_child(this._clockBox);
        label.hide();

        this._applyClockLayout();
        this._updateClock();
        this._clockTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateClock() {
        if (!this._clockTime)
            return;
        const now = this._clockTz ? GLib.DateTime.new_now(this._clockTz) : GLib.DateTime.new_now_local();
        const timeFormat = this._gs.get_string('clock-time-format');
        const twelve = timeFormat === '12h' ||
            (timeFormat === 'system' && this._iface?.get_string('clock-format') === '12h');
        const seconds = this._gs.get_boolean('clock-seconds');
        const timePattern = twelve
            ? (seconds ? '%-I:%M:%S %p' : '%-I:%M %p')
            : (seconds ? '%H:%M:%S' : '%H:%M');
        const datePattern = {
            iso: '%Y-%m-%d',
            dmy: '%d/%m/%Y',
            mdy: '%m/%d/%Y',
            long: '%a %-d %b',
        }[this._gs.get_string('clock-date-format')] ?? '%x';
        const time = now.format(timePattern) ?? '';
        const date = now.format(datePattern) ?? '';
        if (this._clockTime.text !== time)
            this._clockTime.text = time;
        if (this._clockDate.text !== date)
            this._clockDate.text = date;
        for (const bar of this._bars) {
            if (!bar.clockTime)
                continue;
            bar.clockTime.text = time;
            bar.clockDate.text = date;
        }
    }

    _teardownClock() {
        if (this._clockTimer) {
            GLib.source_remove(this._clockTimer);
            this._clockTimer = 0;
        }
        this._clockBox?.destroy();
        this._clockBox = null;
        this._clockTime = null;
        this._clockDate = null;
        this._clockLabel?.show();
        this._clockLabel = null;
    }

    // ------------------------------------------------------------------
    // Calendar popup: notifications stacked above the calendar
    // ------------------------------------------------------------------

    _setupDateMenu() {
        try {
            const dm = this._panel.statusArea.dateMenu;
            const children = dm?.menu?.box?.get_children?.() ?? [];
            const area = children.find(c => c.name === 'calendarArea');
            if (!area || area.orientation === undefined)
                return;
            this._dateArea = {area, orientation: area.orientation};
            area.orientation = Clutter.Orientation.VERTICAL;
            area.add_style_class_name('forever-calendar-area');
        } catch (e) {
            console.error(`[4ever] could not restyle the calendar popup: ${e.message}`);
        }
    }

    _teardownDateMenu() {
        if (!this._dateArea)
            return;
        try {
            this._dateArea.area.orientation = this._dateArea.orientation;
            this._dateArea.area.remove_style_class_name('forever-calendar-area');
        } catch (_e) {
            // popup already gone
        }
        this._dateArea = null;
    }

    // ------------------------------------------------------------------
    // Notification banners: bottom right, above the clock
    // ------------------------------------------------------------------

    _setupNotifications() {
        const bin = Main.messageTray?._bannerBin;
        if (!bin)
            return;
        this._banner = {
            bin,
            xAlign: bin.x_align,
            yAlign: bin.y_align,
            style: bin.style,
        };
        bin.x_align = Clutter.ActorAlign.END;
        bin.y_align = Clutter.ActorAlign.END;
        bin.style = 'margin: 0 12px 12px 12px;';
    }

    _teardownNotifications() {
        if (!this._banner)
            return;
        const {bin, xAlign, yAlign, style} = this._banner;
        bin.x_align = xAlign;
        bin.y_align = yAlign;
        bin.style = style;
        this._banner = null;
    }

    // ------------------------------------------------------------------
    // Settings + Start pins (pins are separate from the taskbar favorites)
    // ------------------------------------------------------------------

    _configPath(name) {
        return GLib.build_filenamev([GLib.get_user_config_dir(), '4ever', name]);
    }

    _readJson(name) {
        // Fall back to the folder of the old name (Eleven) so pins carry over
        const paths = [
            this._configPath(name),
            GLib.build_filenamev([GLib.get_user_config_dir(), 'eleven', name]),
        ];
        for (const path of paths) {
            try {
                const [ok, bytes] = GLib.file_get_contents(path);
                if (ok)
                    return JSON.parse(new TextDecoder().decode(bytes));
            } catch (_e) {
                // missing or unreadable
            }
        }
        return null;
    }

    _writeJson(name, data) {
        try {
            const path = this._configPath(name);
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
            GLib.file_set_contents(path, JSON.stringify(data));
        } catch (e) {
            console.error(`[4ever] could not save ${name}: ${e.message}`);
        }
    }

    // ------------------------------------------------------------------
    // Settings-driven behaviour (values come from the Settings window)
    // ------------------------------------------------------------------

    // Width the Start menu content really has: menu width minus the 24px
    // padding on each side and the 14px kept clear for the scrollbar.
    // Every fixed width inside the menu is derived from this, so nothing can
    // end up wider than the visible area.
    _viewportWidth() {
        return this._gs.get_int('start-menu-width') - 2 * 24 - 14;
    }

    _applyMenuSize() {
        if (!this._root)
            return;
        this._root.style = `width: ${this._gs.get_int('start-menu-width')}px;`;
        const height = this._gs.get_int('start-menu-height');
        for (const view of [this._pageView, this._resultsView])
            view.scroll.style = `height: ${height}px;`;
    }

    // Which version of the bundled icons to use: transparent, dark, light, ember
    // or "auto" (dark or light to match the theme)
    _iconStyle() {
        const style = this._gs.get_string('icon-style');
        if (style === 'auto')
            return Main.uiGroup.has_style_class_name('forever-light') ? 'light' : 'dark';
        return style;
    }

    // One of the bundled icons: 'applications', 'launcher' or 'workspaces'
    _packIcon(name) {
        const file = GLib.build_filenamev([this.path, 'icons', `${name}-${this._iconStyle()}.svg`]);
        return Gio.FileIcon.new(Gio.File.new_for_path(file));
    }

    _startGicon() {
        const source = this._gs.get_string('start-icon-source');
        if (source === 'custom') {
            const path = this._gs.get_string('start-icon-path');
            if (path && GLib.file_test(path, GLib.FileTest.EXISTS))
                return Gio.FileIcon.new(Gio.File.new_for_path(path));
        }
        if (source === 'os')
            return this._osLogoIcon();
        return this._packIcon('applications');
    }

    // Put the bundled icons back after the icon style or the theme changed
    _refreshPackIcons() {
        if (!this._taskbar)
            return;
        if (this._startIcon) {
            this._startIcon.gicon = this._startGicon();
            this._startIcon.icon_size = this._startIconSize();
        }
        if (this._taskViewButton?.child) {
            this._taskViewButton.child.gicon = this._packIcon('workspaces');
            this._taskViewButton.child.icon_size = this._packSize(22);
        }
        this._applySearchMode();
        this._rebuildBars();
    }

    _startIconSize() {
        const base = Math.max(16, this._gs.get_int('app-icon-size') - 2);
        // The bundled icons have some empty space around them, so draw them a bit larger
        if (this._gs.get_string('start-icon-source') === 'pack')
            return this._packSize(base);
        return base;
    }

    _packSize(base) {
        return Math.max(16, Math.min(base + 6, this._gs.get_int('taskbar-height') - 12));
    }

    // background-color with the chosen opacity, in the colours of the current theme
    _bgStyle(darkRgb, lightRgb, key) {
        const light = Main.uiGroup.has_style_class_name('forever-light');
        const [r, g, b] = light ? lightRgb : darkRgb;
        const alpha = Math.min(100, Math.max(0, this._gs.get_int(key))) / 100;
        return `background-color: rgba(${r}, ${g}, ${b}, ${alpha});`;
    }

    _applyOpacity() {
        this._applyPanelSize();
        if (this._menu)
            this._menu.box.style = this._bgStyle([40, 40, 40], [243, 243, 243], 'start-opacity');
        for (const ui of this._trayUis)
            ui.menu.box.style = this._bgStyle([48, 48, 48], [252, 252, 252], 'tray-opacity');
        const height = this._gs.get_int('taskbar-height');
        for (const bar of this._bars)
            bar.root.style = this._barStyle(height, bar.monitor);
    }

    _applyTaskbarLook() {
        if (!this._taskbar)
            return;
        const spacing = `spacing: ${this._gs.get_int('icon-spacing')}px;`;
        this._taskbar.style = spacing;
        const highlight = this._gs.get_boolean('start-highlight');
        const buttons = [this._startButton, ...this._bars.map(bar => bar.startButton)];
        for (const button of buttons) {
            if (!button)
                continue;
            if (highlight)
                button.add_style_class_name('forever-start-highlight');
            else
                button.remove_style_class_name('forever-start-highlight');
        }
        for (const bar of this._bars) {
            bar.center.style = spacing;
            bar.appsBox.style = spacing;
        }
    }

    _indicatorColor() {
        const chosen = this._gs.get_string('indicator-color').trim();
        if (/^#[0-9a-fA-F]{6}$/.test(chosen))
            return chosen;
        return Main.uiGroup.has_style_class_name('forever-light') ? '#0067c0' : '#60cdff';
    }

    _applyPanelSize() {
        this._panel.style = `height: ${this._gs.get_int('taskbar-height')}px; ` +
            this._bgStyle([32, 32, 32], [243, 243, 243], 'panel-opacity');
        if (this._startIcon)
            this._startIcon.icon_size = this._startIconSize();
    }

    _clockTimeZone() {
        const id = this._gs.get_string('clock-timezone').trim();
        if (!id)
            return null;
        try {
            return GLib.TimeZone.new_identifier ? GLib.TimeZone.new_identifier(id) : GLib.TimeZone.new(id);
        } catch (_e) {
            return null;
        }
    }

    _applyClockLayout() {
        this._clockTz = this._clockTimeZone();
        const layout = this._gs.get_string('clock-layout');
        const inline = layout === 'inline';
        for (const bar of this._bars) {
            if (!bar.clockBox)
                continue;
            bar.clockBox.orientation = inline ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL;
            bar.clockBox.style = inline ? 'spacing: 10px;' : '';
            bar.clockDate.visible = layout !== 'time';
        }
        if (!this._clockBox)
            return;
        this._clockBox.orientation = inline ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL;
        this._clockBox.style = inline ? 'spacing: 10px;' : '';
        this._clockDate.visible = layout !== 'time';
    }

    _overrideOverlayKey() {
        this._restoreOverlayKey();
        if (!this._gs.get_boolean('super-key'))
            return;
        try {
            // Silence GNOME's own handler (the overview) and use ours instead
            const id = GObject.signal_handler_find(global.display, {signalId: 'overlay-key'});
            if (id) {
                global.display.block_signal_handler(id);
                this._blockedOverlayId = id;
            }
        } catch (e) {
            console.error(`[4ever] could not take over the Super key: ${e.message}`);
        }
        this._overlayKeyId = global.display.connect('overlay-key', () => {
            if (Main.overview.visible) {
                Main.overview.hide();
                return;
            }
            this._toggleStart();
        });
    }

    _restoreOverlayKey() {
        if (this._overlayKeyId) {
            global.display.disconnect(this._overlayKeyId);
            this._overlayKeyId = 0;
        }
        if (this._blockedOverlayId) {
            try {
                global.display.unblock_signal_handler(this._blockedOverlayId);
            } catch (_e) {
                // handler is gone
            }
            this._blockedOverlayId = 0;
        }
    }

    _onSettingChanged(key) {
        if (key.startsWith('clock-')) {
            this._applyClockLayout();
            this._updateClock();
            return;
        }
        switch (key) {
        case 'theme':
            this._applyTheme();
            break;
        case 'search-mode':
        case 'search-width':
        case 'search-height':
            this._applySearchMode();
            break;
        case 'show-task-view':
            if (this._taskViewButton)
                this._taskViewButton.visible = this._gs.get_boolean('show-task-view');
            break;
        case 'taskbar-height':
            this._applyPanelSize();
            this._rebuildBars();
            break;
        case 'app-icon-size':
            this._applyPanelSize();
            this._rebuildApps();
            break;
        case 'start-icon-source':
        case 'start-icon-path':
        case 'icon-style':
            this._refreshPackIcons();
            break;
        case 'super-key':
            this._overrideOverlayKey();
            break;
        case 'panel-opacity':
        case 'start-opacity':
        case 'tray-opacity':
            this._applyOpacity();
            break;
        case 'icon-spacing':
        case 'start-highlight':
            this._applyTaskbarLook();
            break;
        case 'indicator-color':
            this._rebuildApps();
            break;
        case 'tray-view':
        case 'tray-columns':
        case 'tray-icon-size':
        case 'tray-spacing':
            for (const ui of this._trayUis) {
                if (ui.menu.isOpen)
                    this._renderTray(ui);
            }
            break;
        case 'show-desktop':
            this._setupShowDesktop();
            break;
        case 'hide-overview-dash':
            this._applyOverviewDash();
            break;
        case 'multi-monitor':
        case 'mm-show-start':
        case 'mm-show-apps':
        case 'mm-show-tray':
        case 'mm-show-clock':
        case 'mm-show-desktop':
            this._rebuildBars();
            break;
        case 'mm-apps-mode':
            this._rebuildApps();
            break;
        case 'show-tray':
            this._setupTray();
            break;
        case 'start-menu-width':
        case 'start-menu-height':
            this._applyMenuSize();
            if (this._menu?.isOpen)
                defer(() => this._rebuildPage(true));
            break;
        case 'all-view':
        case 'section-order':
        case 'show-pinned':
        case 'show-recommended':
            if (this._menu?.isOpen)
                defer(() => this._rebuildPage(true));
            break;
        default:
            if ((key.startsWith('category-') || key.startsWith('pinned-')) && this._menu?.isOpen)
                defer(() => this._rebuildPage(true));
            break;
        }
    }

    _loadPins() {
        const data = this._readJson('start-pins.json');
        if (Array.isArray(data))
            return data.filter(id => typeof id === 'string');
        const sys = Shell.AppSystem.get_default();
        return DEFAULT_START_PINS.filter(id => sys.lookup_app(id));
    }

    _savePins() {
        this._writeJson('start-pins.json', this._startPins);
    }

    _isStartPinned(id) {
        return this._startPins.includes(id);
    }

    _toggleStartPin(id) {
        if (this._isStartPinned(id))
            this._startPins = this._startPins.filter(p => p !== id);
        else
            this._startPins.push(id);
        this._savePins();
        if (this._menu?.isOpen)
            this._rebuildPage(true);
    }

    _toggleTaskbarPin(id) {
        const favs = AppFavorites.getAppFavorites();
        if (favs.isFavorite(id))
            favs.removeFavorite(id);
        else
            favs.addFavorite(id);
    }

    // ------------------------------------------------------------------
    // Start menu
    // ------------------------------------------------------------------

    _buildStartMenu() {
        this._startIcon = new St.Icon({gicon: this._startGicon(), icon_size: this._startIconSize()});
        this._startButton = new St.Button({
            style_class: 'forever-start-button',
            child: this._startIcon,
            reactive: true,
            can_focus: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
        });
        this._attachTooltip(this._startButton, 'Start');
        this._taskbar.add_child(this._startButton);

        this._anchor = new St.Widget({width: 1, height: 1, reactive: false});
        Main.uiGroup.add_child(this._anchor);
        this._positionAnchor();

        this._menu = new PopupMenu.PopupMenu(this._anchor, 0.5, St.Side.BOTTOM);
        this._menu.actor.add_style_class_name('forever-start-menu');
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();
        Main.panel.menuManager.addMenu(this._menu);

        this._wireStartButton(this._startButton, () => null);

        // Root stacks the main column and an overlay (used for flyout menus)
        this._root = new St.Widget({
            style_class: 'forever-start',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._menu.box.add_child(this._root);

        const column = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true});
        this._root.add_child(column);

        // Search
        const searchArea = new St.BoxLayout({style_class: 'forever-search-area', x_expand: true});
        this._search = new St.Entry({
            hint_text: 'Search for apps',
            style_class: 'forever-search',
            can_focus: true,
            x_expand: true,
        });
        this._search.set_primary_icon(new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'forever-search-icon',
        }));
        this._search.clutter_text.connect('text-changed', () => this._onSearchChanged());
        this._search.clutter_text.connect('activate', () => this._activateFirstResult());
        searchArea.add_child(this._search);
        column.add_child(searchArea);

        // Views: the page (Pinned / Recommended / All) and search results
        this._pageView = this._makeScroll();
        this._resultsView = this._makeScroll();
        column.add_child(this._pageView.scroll);
        column.add_child(this._resultsView.scroll);
        this._applyMenuSize();
        this._showView('page');

        // Footer: user on the left, power button on the right
        const footer = new St.BoxLayout({style_class: 'forever-footer', x_expand: true});
        this._userName = this._displayName();
        this._userButton = this._clickable('forever-user', () => {
            this._showFlyout(this._userEntries(), this._userButton, 'above-start');
        });
        this._userButton.y_align = Clutter.ActorAlign.CENTER;
        this._userButton.add_child(this._makeAvatar(32));
        this._userButton.add_child(new St.Label({
            text: this._userName,
            style_class: 'forever-user-name',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        footer.add_child(this._userButton);
        footer.add_child(new St.Widget({x_expand: true}));

        this._powerButton = new St.Button({
            style_class: 'forever-power',
            child: new St.Icon({icon_name: 'system-shutdown-symbolic', icon_size: 18}),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._powerButton.connect('clicked', () => {
            this._showFlyout(this._powerEntries(), this._powerButton, 'above-end');
        });
        footer.add_child(this._powerButton);
        column.add_child(footer);

        // Overlay for flyouts (power menu, right-click menus, category lists)
        this._overlay = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            x_expand: true,
            y_expand: true,
            reactive: true,
            visible: false,
        });
        this._overlay.connect('button-press-event', () => {
            this._hideFlyout();
            return Clutter.EVENT_STOP;
        });
        this._flyoutScroll = new St.ScrollView({
            style_class: 'forever-flyout-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._flyout = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'forever-flyout'});
        this._flyoutScroll.add_child(this._flyout);
        this._overlay.add_child(this._flyoutScroll);
        this._root.add_child(this._overlay);

        this._menu.connect('open-state-changed', (_menu, open) => {
            this._hideFlyout();
            if (open) {
                this._revealPanels(true);
                this._onMenuOpened();
                this._watchSuperKey();
            } else {
                this._startClosedAt = nowMs();
                this._unwatchSuperKey();
                this._revealPanels(false);
            }
        });
    }

    // Click handling for a Start button (the main one or one on another monitor)
    _wireStartButton(button, getMonitor) {
        // A click outside the menu closes it before the button sees the click,
        // so remember whether Start was open at the moment of the press.
        let wasOpenOnPress = false;
        button.connect('button-press-event', () => {
            wasOpenOnPress = this._menu.isOpen || nowMs() - (this._startClosedAt ?? 0) < 150;
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('clicked', (_b, mouseButton) => {
            if (mouseButton === 3) {
                if (button === this._startButton)
                    this._showWinXMenu();
            } else if (wasOpenOnPress) {
                this._menu.close();
            } else {
                this._positionAnchor(getMonitor());
                this._menu.open();
            }
        });
    }

    // Open or close Start. Used by the Super key and the search icon.
    _toggleStart() {
        if (!this._menu)
            return;
        if (this._menu.isOpen) {
            this._menu.close();
        } else if (nowMs() - (this._startClosedAt ?? 0) > 250) {
            this._positionAnchor(this._pointerBarMonitor());
            this._menu.open();
        }
    }

    // Games and other full-screen windows hide the taskbar. While Start is
    // open, show it on top so the clock and the system icons can be used.
    _revealPanels(on) {
        if (!this._gs?.get_boolean('fullscreen-reveal'))
            return;
        const lm = Main.layoutManager;
        if (on) {
            this._panelBox.show();
            for (const bar of this._bars)
                bar.root.show();
            return;
        }
        if (lm.primaryMonitor?.inFullscreen)
            this._panelBox.hide();
        for (const bar of this._bars) {
            if (lm.monitors[bar.index]?.inFullscreen)
                bar.root.hide();
        }
    }

    // While Start is open the menu holds the keyboard, and GNOME may not report
    // a second tap of Super. Watch for it directly: a Super key pressed and
    // released on its own closes Start.
    _watchSuperKey() {
        this._unwatchSuperKey();
        let superDown = false;
        this._superWatchId = global.stage.connect('captured-event', (_stage, event) => {
            const type = event.type();
            if (type !== Clutter.EventType.KEY_PRESS && type !== Clutter.EventType.KEY_RELEASE)
                return Clutter.EVENT_PROPAGATE;
            const sym = event.get_key_symbol();
            const isSuper = sym === Clutter.KEY_Super_L || sym === Clutter.KEY_Super_R;
            if (type === Clutter.EventType.KEY_PRESS) {
                superDown = isSuper;
            } else if (isSuper && superDown) {
                superDown = false;
                defer(() => this._menu?.isOpen && this._menu.close());
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _unwatchSuperKey() {
        if (this._superWatchId) {
            global.stage.disconnect(this._superWatchId);
            this._superWatchId = 0;
        }
    }

    // The account picture set in GNOME Settings (kept by AccountsService)
    _avatarPath() {
        const user = GLib.get_user_name();
        const candidates = [
            `/var/lib/AccountsService/icons/${user}`,
            GLib.build_filenamev([GLib.get_home_dir(), '.face']),
            GLib.build_filenamev([GLib.get_home_dir(), '.face.icon']),
        ];
        return candidates.find(path => GLib.file_test(path, GLib.FileTest.IS_REGULAR)) ?? null;
    }

    // A round picture of the user, or the generic person icon when there is none
    _makeAvatar(size) {
        const path = this._avatarPath();
        if (path) {
            return new St.Widget({
                style: `width: ${size}px; height: ${size}px; border-radius: ${size}px; ` +
                    `background-image: url("file://${path}"); background-size: ${size}px ${size}px;`,
                y_align: Clutter.ActorAlign.CENTER,
            });
        }
        return new St.Icon({
            icon_name: 'avatar-default-symbolic',
            style_class: 'forever-avatar',
            icon_size: size - 12,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _displayName() {
        const realName = GLib.get_real_name();
        return realName && realName !== 'Unknown' ? realName : GLib.get_user_name();
    }

    // --- System tray: an up arrow that lists background apps ----------

    _ensureTrayManager() {
        if (this._tray)
            return;
        this._tray = new TrayManager(() => this._onTrayChanged());
        this._tray.start();
    }

    _onTrayChanged() {
        const count = this._tray?.items.length ?? 0;
        for (const ui of [...this._trayUis]) {
            ui.button.visible = count > 0;
            if (count === 0 && ui.menu.isOpen)
                ui.menu.close();
            else if (ui.menu.isOpen && !ui.showingMenu)
                this._renderTray(ui);
        }
    }

    // One arrow button plus its popup. The main taskbar has one; every
    // extra monitor's taskbar can have its own.
    _makeTrayUi(container, index, barActor) {
        const button = new St.Button({
            style_class: 'forever-app-button forever-tray-button',
            child: new St.Icon({icon_name: 'pan-up-symbolic', icon_size: 16}),
            can_focus: true,
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: (this._tray?.items.length ?? 0) > 0,
        });
        this._attachTooltip(button, 'Show hidden icons');
        container.insert_child_at_index(button, index);

        const menu = new PopupMenu.PopupMenu(button, 0.5, St.Side.BOTTOM);
        menu.actor.add_style_class_name('forever-app-menu');
        menu.actor.add_style_class_name('forever-tray-menu');
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        Main.panel.menuManager.addMenu(menu);
        menu.box.style = this._bgStyle([48, 48, 48], [252, 252, 252], 'tray-opacity');

        const ui = {button, menu, barActor, showingMenu: false};
        menu.connect('open-state-changed', (_m, open) => {
            if (button.child)
                button.child.icon_name = open ? 'pan-down-symbolic' : 'pan-up-symbolic';
        });
        // A PopupMenu refuses to open while it has no items, so fill it first
        button.connect('clicked', () => {
            if (!menu.isOpen) {
                // Sit fully above the taskbar, not on top of it
                const [, buttonY] = button.get_transformed_position();
                const [, barY] = barActor.get_transformed_position();
                const gap = Math.max(0, Math.round(buttonY - barY)) + 8;
                menu.actor.style = `-boxpointer-gap: ${gap}px;`;
                this._renderTray(ui);
            }
            menu.toggle();
        });

        this._trayUis.push(ui);
        this._ensureTrayManager();
        return ui;
    }

    _destroyTrayUi(ui) {
        this._trayUis = this._trayUis.filter(u => u !== ui);
        try {
            Main.panel.menuManager.removeMenu(ui.menu);
        } catch (_e) {
            // already removed
        }
        ui.menu.destroy();
        ui.button.destroy();
    }

    _setupTray() {
        if (this._trayUi) {
            this._destroyTrayUi(this._trayUi);
            this._trayUi = null;
        }
        if (this._gs.get_boolean('show-tray'))
            this._trayUi = this._makeTrayUi(this._panel._rightBox, 0, this._panel);
    }

    _teardownTray() {
        for (const ui of [...(this._trayUis ?? [])])
            this._destroyTrayUi(ui);
        this._trayUis = [];
        this._trayUi = null;
        this._tray?.destroy();
        this._tray = null;
    }

    _renderTray(ui) {
        const menu = ui.menu;
        ui.showingMenu = false;
        menu.removeAll();

        const items = this._tray?.items ?? [];
        if (items.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('No background apps found.\nApps started before 4ever need a restart.', {reactive: false});
            empty.setSensitive(false);
            menu.addMenuItem(empty);
            return;
        }

        const gridMode = this._gs.get_string('tray-view') === 'grid';
        menu.actor.remove_style_class_name('forever-tray-list');
        if (!gridMode)
            menu.actor.add_style_class_name('forever-tray-list');

        if (gridMode) {
            const iconSize = this._gs.get_int('tray-icon-size');
            const cellSize = iconSize + 14;
            const gap = this._gs.get_int('tray-spacing');
            const perRow = Math.max(1, this._gs.get_int('tray-columns'));

            const holder = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            holder.style = 'padding: 4px; min-width: 0;';
            const grid = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                style: `spacing: ${gap}px;`,
            });
            let line = null;
            items.forEach((trayItem, i) => {
                if (i % perRow === 0) {
                    line = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, style: `spacing: ${gap}px;`});
                    grid.add_child(line);
                }
                const cell = new St.Button({
                    style_class: 'forever-tray-cell',
                    style: `width: ${cellSize}px; height: ${cellSize}px;`,
                    child: new St.Icon({gicon: trayItem.gicon(), icon_size: iconSize}),
                    reactive: true,
                    can_focus: true,
                    button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
                });
                this._attachTooltip(cell, trayItem.title || trayItem.id);
                cell.connect('clicked', (_c, mouseButton) => {
                    this._hideTooltip();
                    if (mouseButton === 3)
                        defer(() => this._showTrayItemMenu(ui, trayItem));
                    else
                        this._openTrayItem(ui, trayItem);
                });
                line.add_child(cell);
            });
            holder.add_child(grid);
            menu.addMenuItem(holder);
            return;
        }

        for (const trayItem of items) {
            const row = new PopupMenu.PopupBaseMenuItem();
            row.add_child(new St.Icon({gicon: trayItem.gicon(), icon_size: 22, style: 'margin-right: 10px;'}));
            row.add_child(new St.Label({
                text: trayItem.title || trayItem.id,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            }));
            row.connect('activate', () => this._openTrayItem(ui, trayItem));
            row.connect('button-press-event', (_r, event) => {
                if (event.get_button() !== 3)
                    return Clutter.EVENT_PROPAGATE;
                defer(() => this._showTrayItemMenu(ui, trayItem));
                return Clutter.EVENT_STOP;
            });
            menu.addMenuItem(row);
        }
    }

    async _openTrayItem(ui, trayItem) {
        ui.menu.close();
        try {
            if (trayItem.itemIsMenu)
                await trayItem.contextMenu(0, 0);
            else
                await trayItem.activate(0, 0);
        } catch (_e) {
            try {
                await trayItem.secondaryActivate(0, 0);
            } catch (e) {
                console.error(`[4ever] could not open ${trayItem.id}: ${e.message}`);
            }
        }
    }

    // Right-click on a tray app: show its own menu (Quit, Settings, ...)
    async _showTrayItemMenu(ui, trayItem) {
        const menu = ui.menu;
        let layout = null;
        try {
            layout = await trayItem.fetchMenu();
        } catch (e) {
            console.error(`[4ever] tray menu of ${trayItem.id}: ${e.message}`);
        }
        if (!layout || !menu.isOpen) {
            // No menu we can read: let the app show its own
            menu.close();
            trayItem.contextMenu(0, 0).catch(() => {});
            return;
        }

        ui.showingMenu = true;
        menu.removeAll();
        const back = new PopupMenu.PopupMenuItem(`\u2039  ${trayItem.title || 'Back'}`);
        back.connect('activate', () => defer(() => this._renderTray(ui)));
        menu.addMenuItem(back);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const add = (node, depth) => {
            const [id, props, children] = node;
            if (props.visible === false)
                return;
            if (props.type === 'separator') {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            } else {
                const label = cleanLabel(props.label);
                if (label) {
                    const item = new PopupMenu.PopupMenuItem(`${'    '.repeat(depth)}${label}`);
                    item.setSensitive(props.enabled !== false);
                    if (props['toggle-type'] && props['toggle-state'] === 1)
                        item.setOrnament(PopupMenu.Ornament.CHECK);
                    if (props['children-display'] !== 'submenu') {
                        item.connect('activate', () => {
                            menu.close();
                            trayItem.menuEvent(id).catch(() => {});
                        });
                    } else {
                        item.setSensitive(false);
                    }
                    menu.addMenuItem(item);
                }
            }
            for (const child of children ?? [])
                add(child, depth + 1);
        };
        for (const child of layout[2] ?? [])
            add(child, 0);
    }

    // --- Show desktop: the thin strip at the right end of the taskbar ---

    _makeShowDesktopButton() {
        const button = new St.Button({
            style_class: 'forever-show-desktop',
            reactive: true,
            can_focus: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._attachTooltip(button, 'Show desktop');
        button.connect('clicked', () => this._toggleShowDesktop());
        return button;
    }

    _setupShowDesktop() {
        this._showDesktopButton?.destroy();
        this._showDesktopButton = null;
        if (!this._gs.get_boolean('show-desktop'))
            return;
        this._showDesktopButton = this._makeShowDesktopButton();
        this._panel._rightBox.add_child(this._showDesktopButton);
    }

    // First click: minimize everything. Second click: bring it all back.
    _toggleShowDesktop() {
        this._hiddenWindows = this._hiddenWindows.filter(w => w.minimized);
        if (this._hiddenWindows.length > 0) {
            const windows = this._hiddenWindows;
            this._hiddenWindows = [];
            for (const w of windows) {
                try {
                    w.unminimize();
                } catch (_e) {
                    // window is gone
                }
            }
            return;
        }
        const workspace = global.workspace_manager.get_active_workspace();
        const windows = workspace.list_windows().filter(w =>
            !w.minimized && w.can_minimize() && !w.skip_taskbar &&
            w.get_window_type() === Meta.WindowType.NORMAL);
        for (const w of windows)
            w.minimize();
        this._hiddenWindows = windows;
    }

    // --- Taskbars on the other monitors ---------------------------------

    _barStyle(height, monitor) {
        return `height: ${height}px; width: ${monitor.width}px; ` +
            this._bgStyle([32, 32, 32], [243, 243, 243], 'panel-opacity');
    }

    _teardownBars() {
        for (const bar of this._bars ?? []) {
            if (bar.trayUi)
                this._destroyTrayUi(bar.trayUi);
            try {
                Main.layoutManager.removeChrome(bar.root);
            } catch (_e) {
                // already removed
            }
            bar.root.destroy();
        }
        this._bars = [];
    }

    _rebuildBars() {
        if (!this._gs)
            return;
        this._hideTooltip();
        this._teardownBars();
        if (!this._gs.get_boolean('multi-monitor'))
            return;

        const lm = Main.layoutManager;
        lm.monitors.forEach((monitor, index) => {
            if (index !== lm.primaryIndex)
                this._bars.push(this._makeBar(monitor, index));
        });
        this._applyTaskbarLook();
        this._applyClockLayout();
        this._updateClock();
    }

    _makeBar(monitor, index) {
        const height = this._gs.get_int('taskbar-height');
        const root = new St.Widget({
            style_class: 'forever-panel',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            style: this._barStyle(height, monitor),
        });
        root.set_size(monitor.width, height);
        root.set_position(monitor.x, monitor.y + monitor.height - height);
        Main.layoutManager.addChrome(root, {affectsStruts: true, trackFullscreen: true});

        const bar = {root, index, monitor, appButtons: []};

        bar.center = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.FILL,
        });
        root.add_child(bar.center);

        if (this._gs.get_boolean('mm-show-start')) {
            bar.startButton = new St.Button({
                style_class: 'forever-start-button',
                child: new St.Icon({gicon: this._startGicon(), icon_size: this._startIconSize()}),
                reactive: true,
                can_focus: true,
                button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
            });
            this._attachTooltip(bar.startButton, 'Start');
            this._wireStartButton(bar.startButton, () => index);
            bar.center.add_child(bar.startButton);
        }
        bar.appsBox = new St.BoxLayout({y_align: Clutter.ActorAlign.FILL});
        bar.center.add_child(bar.appsBox);

        bar.right = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.FILL,
        });
        root.add_child(bar.right);

        if (this._gs.get_boolean('mm-show-tray'))
            bar.trayUi = this._makeTrayUi(bar.right, 0, root);

        if (this._gs.get_boolean('mm-show-clock')) {
            bar.clockBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'forever-clock',
                y_align: Clutter.ActorAlign.CENTER,
            });
            bar.clockTime = new St.Label({style_class: 'forever-clock-time', x_align: Clutter.ActorAlign.END});
            bar.clockDate = new St.Label({style_class: 'forever-clock-date', x_align: Clutter.ActorAlign.END});
            bar.clockBox.add_child(bar.clockTime);
            bar.clockBox.add_child(bar.clockDate);
            bar.right.add_child(bar.clockBox);
        }

        if (this._gs.get_boolean('mm-show-desktop'))
            bar.right.add_child(this._makeShowDesktopButton());

        this._fillBarApps(bar);
        return bar;
    }

    _fillBarApps(bar) {
        for (const button of bar.appButtons)
            button.destroy();
        bar.appButtons = [];
        if (!this._gs.get_boolean('mm-show-apps'))
            return;
        const focused = Shell.WindowTracker.get_default().focus_app;
        for (const app of this._appList(bar.index)) {
            const button = this._makeAppButton(app, focused, bar.index);
            bar.appsBox.add_child(button);
            bar.appButtons.push(button);
        }
    }

    // --- Taskbar: search (hidden / icon / box), task view ------------

    _buildTaskbarExtras() {
        this._taskViewButton = new St.Button({
            style_class: 'forever-app-button',
            child: new St.Icon({gicon: this._packIcon('workspaces'), icon_size: this._packSize(22)}),
            can_focus: true,
            reactive: true,
        });
        this._taskViewButton.connect('clicked', () => Main.overview.toggle());
        this._attachTooltip(this._taskViewButton, 'Task view');
        this._taskbar.add_child(this._taskViewButton);
        this._taskViewButton.visible = this._gs.get_boolean('show-task-view');

        this._applySearchMode();
    }

    _applySearchMode() {
        this._searchWidget?.destroy();
        this._searchWidget = null;
        this._searchEntry = null;

        const mode = this._gs.get_string('search-mode');
        if (mode === 'hidden')
            return;

        let widget;
        if (mode === 'icon') {
            widget = new St.Button({
                style_class: 'forever-app-button',
                child: new St.Icon({gicon: this._packIcon('launcher'), icon_size: this._packSize(22)}),
                can_focus: true,
                reactive: true,
            });
            widget.connect('clicked', () => this._toggleStart());
            this._attachTooltip(widget, 'Search');
        } else {
            // A real search field: type here and the Start menu opens with results
            widget = new St.Entry({
                style_class: 'forever-taskbar-entry',
                hint_text: 'Search',
                can_focus: true,
                reactive: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            widget.set_primary_icon(new St.Icon({
                icon_name: 'edit-find-symbolic',
                style_class: 'forever-taskbar-entry-icon',
            }));
            widget.clutter_text.connect('text-changed', () => {
                const text = widget.get_text();
                if (!text)
                    return;
                widget.set_text('');
                this._searchFromTaskbar(text);
            });
            const boxHeight = this._gs.get_int('search-height');
            widget.style = `width: ${this._gs.get_int('search-width')}px; ` +
                `min-height: ${boxHeight - 2}px; padding: 0 12px; border-radius: ${Math.round(boxHeight / 2)}px;`;
            this._searchEntry = widget;
        }

        // Directly after the Start button
        this._taskbar.insert_child_at_index(widget, 1);
        this._searchWidget = widget;
    }

    _searchFromTaskbar(text) {
        if (this._menu.isOpen) {
            this._search.set_text(text);
            this._focusSearchEnd();
            return;
        }
        this._pendingQuery = text;
        this._menu.open();
    }

    _focusSearchEnd() {
        this._search.grab_key_focus();
        const text = this._search.clutter_text;
        text.set_cursor_position(-1);
        text.set_selection_bound(-1);
    }

    _setSearchMode(id) {
        this._gs.set_string('search-mode', id);
    }

    _setTheme(id) {
        this._gs.set_string('theme', id);
    }

    _onPanelPress(event) {
        if (event.get_button() !== 3)
            return Clutter.EVENT_PROPAGATE;
        const source = event.get_source();
        const panel = this._panel;
        const onBar = source === panel || source === panel._leftBox ||
            source === panel._centerBox || source === panel._rightBox;
        const inTaskbar = this._taskbar?.contains(source) && !this._searchEntry?.contains(source);
        if (!onBar && !inTaskbar)
            return Clutter.EVENT_PROPAGATE;
        this._showTaskbarMenu();
        return Clutter.EVENT_STOP;
    }

    _showTaskbarMenu() {
        if (!this._taskbarMenu) {
            const menu = new PopupMenu.PopupMenu(this._taskbar, 0.5, St.Side.BOTTOM);
            menu.actor.add_style_class_name('forever-app-menu');
            Main.uiGroup.add_child(menu.actor);
            menu.actor.hide();
            Main.panel.menuManager.addMenu(menu);
            this._taskbarMenu = menu;
        }

        const menu = this._taskbarMenu;
        menu.removeAll();

        const addChoices = (title, options, current, onPick) => {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(title));
            for (const [id, label] of options) {
                const item = new PopupMenu.PopupMenuItem(label);
                item.setOrnament(id === current ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
                item.connect('activate', () => defer(() => onPick(id)));
                menu.addMenuItem(item);
            }
        };
        addChoices('Search', SEARCH_MODES, this._gs.get_string('search-mode'), id => this._setSearchMode(id));
        addChoices('Theme', THEME_MODES, this._gs.get_string('theme'), id => this._setTheme(id));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('4ever settings', () => defer(() => this.openPreferences()));
        menu.toggle();
    }

    // --- Opening / views ----------------------------------------------

    _onMenuOpened() {
        this._search.set_text('');
        this._rebuildPage();
        this._showView('page');

        const adjustment = vadjustmentOf(this._pageView.scroll);
        adjustment?.set_value?.(0);

        // Text typed into the taskbar search box carries over into Start
        const pending = this._pendingQuery;
        this._pendingQuery = null;
        if (pending)
            this._search.set_text(pending);

        // The menu manager moves focus when a menu opens; claim it afterwards.
        defer(() => {
            if (this._menu?.isOpen)
                this._focusSearchEnd();
        });
    }

    _makeScroll() {
        const scroll = new St.ScrollView({
            style_class: 'forever-scroll',
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'forever-scroll-box',
        });
        scroll.add_child(box);
        scroll.clip_to_allocation = true;

        // The page only scrolls up and down. Anything that would push it
        // sideways (a drag, a touchpad swipe) is put straight back.
        const sideways = hadjustmentOf(scroll);
        if (sideways) {
            const lock = () => {
                if (sideways.value !== 0)
                    sideways.value = 0;
            };
            sideways.connect('notify::value', lock);
            sideways.connect('changed', lock);
        }
        return {scroll, box};
    }

    _showView(name) {
        this._view = name;
        this._pageView.scroll.visible = name === 'page';
        this._resultsView.scroll.visible = name === 'results';
    }

    _sectionHeader(title, rightWidget = null) {
        const header = new St.BoxLayout({style_class: 'forever-section-header', x_expand: true});
        header.add_child(new St.Label({
            text: title,
            style_class: 'forever-section-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (rightWidget)
            header.add_child(rightWidget);
        return header;
    }

    _allApps() {
        if (!this._allAppsCache) {
            const sys = Shell.AppSystem.get_default();
            this._allAppsCache = sys.get_installed()
                .filter(info => info.should_show())
                .sort((a, b) => a.get_name().localeCompare(b.get_name(), undefined, {sensitivity: 'base'}))
                .map(info => sys.lookup_app(info.get_id()))
                .filter(app => app);
        }
        return this._allAppsCache;
    }

    // --- Page: Pinned, Recommended, All ------------------------------

    // The order of the three sections, top to bottom, from the settings.
    // Anything missing or unknown is repaired so a section can never vanish.
    _sectionOrder() {
        const known = ['all', 'recommended', 'pinned'];
        const asked = this._gs.get_string('section-order').split(',').map(id => id.trim());
        const order = asked.filter((id, i) => known.includes(id) && asked.indexOf(id) === i);
        for (const id of known) {
            if (!order.includes(id))
                order.push(id);
        }
        return order;
    }

    _rebuildPage(keepScroll = false) {
        const box = this._pageView.box;
        const adjustment = vadjustmentOf(this._pageView.scroll);
        const scrollPosition = keepScroll ? (adjustment?.value ?? 0) : 0;

        box.destroy_all_children();
        for (const section of this._sectionOrder()) {
            if (section === 'pinned')
                this._addPinnedSection(box);
            else if (section === 'recommended')
                this._addRecommendedSection(box);
            else
                this._addAllSection(box);
        }

        if (keepScroll && scrollPosition > 0) {
            defer(() => {
                const adj = vadjustmentOf(this._pageView.scroll);
                adj?.set_value?.(scrollPosition);
            });
        }
    }

    _addPinnedSection(box) {
        if (!this._gs.get_boolean('show-pinned'))
            return;

        const sys = Shell.AppSystem.get_default();
        box.add_child(this._sectionHeader('Pinned'));
        const pinned = this._startPins.map(id => sys.lookup_app(id)).filter(app => app);
        if (pinned.length > 0) {
            box.add_child(this._makeGrid(pinned));
        } else {
            box.add_child(new St.Label({
                text: 'Nothing pinned yet. Right-click an app in All to pin it here.',
                style_class: 'forever-hint',
                x_align: Clutter.ActorAlign.START,
            }));
        }
    }

    _addRecommendedSection(box) {
        if (!this._gs.get_boolean('show-recommended'))
            return;

        box.add_child(this._sectionHeader('Recommended'));
        let recent = [];
        try {
            recent = Shell.AppUsage.get_default().get_most_used()
                .filter(app => app.get_app_info()?.should_show())
                .slice(0, RECOMMENDED_COUNT);
        } catch (_e) {
            recent = [];
        }

        if (recent.length === 0) {
            box.add_child(new St.Label({
                text: 'Apps you use often will show up here.',
                style_class: 'forever-hint',
                x_align: Clutter.ActorAlign.START,
            }));
            return;
        }

        const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        for (let i = 0; i < recent.length; i += 2) {
            const row = new St.BoxLayout({x_expand: true});
            for (const app of recent.slice(i, i + 2))
                row.add_child(this._makeListItem(app, {half: true, subtitle: 'Frequently used'}));
            list.add_child(row);
        }
        box.add_child(list);
    }

    _addAllSection(box) {
        box.add_child(this._sectionHeader('All', this._makeViewDropdown()));

        const apps = this._allApps();
        const view = this._gs.get_string('all-view');
        if (view === 'grid')
            box.add_child(this._makeGrid(apps));
        else if (view === 'list')
            box.add_child(this._makeAlphaList(apps));
        else
            box.add_child(this._makeCategoryView(apps));
    }

    // "View: Category v" drop-down. Fixed width, so switching never shifts the header.
    _makeViewDropdown() {
        const current = this._gs.get_string('all-view');
        const label = VIEW_MODES.find(([id]) => id === current)?.[1] ?? 'Category';

        const dropdown = this._clickable('forever-view-dropdown', () => {
            this._showFlyout(VIEW_MODES.map(([id, text]) => ({
                label: text,
                icon: id === current ? 'object-select-symbolic' : null,
                action: () => this._gs.set_string('all-view', id),
            })), dropdown, 'below-end');
        });
        dropdown.y_align = Clutter.ActorAlign.CENTER;
        dropdown.add_child(new St.Label({
            text: `View: ${label}`,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        dropdown.add_child(new St.Icon({
            icon_name: 'pan-down-symbolic',
            icon_size: 12,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return dropdown;
    }

    _makeGrid(apps) {
        const iconSize = this._gs.get_int('pinned-icon-size');
        // Never more columns than fit: each cell must hold the icon plus the
        // tile's own padding and margin (12px), with a little room to spare.
        const fit = Math.max(1, Math.floor(this._viewportWidth() / (iconSize + 20)));
        const columns = Math.min(this._gs.get_int('pinned-columns'), fit);
        const tileWidth = Math.floor(this._viewportWidth() / columns) - 12;

        const grid = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'forever-grid',
        });
        for (let i = 0; i < apps.length; i += columns) {
            const row = new St.BoxLayout({x_expand: true});
            for (const app of apps.slice(i, i + columns))
                row.add_child(this._makeTile(app, tileWidth, iconSize));
            grid.add_child(row);
        }
        return grid;
    }

    _makeAlphaList(apps) {
        const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        let letter = null;
        for (const app of apps) {
            const first = app.get_name().charAt(0).toUpperCase();
            const key = /[A-Z]/.test(first) ? first : '#';
            if (key !== letter) {
                letter = key;
                list.add_child(new St.Label({
                    text: key,
                    style_class: 'forever-letter',
                    x_align: Clutter.ActorAlign.START,
                }));
            }
            list.add_child(this._makeListItem(app));
        }
        return list;
    }

    _makeCategoryView(apps) {
        const groups = new Map();
        for (const app of apps) {
            const name = categoryOf(app);
            if (!groups.has(name))
                groups.set(name, []);
            groups.get(name).push(app);
        }
        const names = [...CATEGORY_RULES.map(([name]) => name), 'Other'].filter(name => groups.has(name));

        const layout = {
            size: this._gs.get_int('category-size'),
            iconSize: this._gs.get_int('category-icon-size'),
            gap: this._gs.get_int('category-gap'),
            rowGap: this._gs.get_int('category-row-gap'),
            align: this._gs.get_string('category-align'),
        };
        // Where the folders sit: left edge, middle or right edge of the content.
        // In the middle, the page's 14px scrollbar space on the right is
        // balanced by 14px on the left, so the folders line up with the middle
        // of the search bar.
        const centered = layout.align === 'center';
        const available = this._viewportWidth() - (centered ? 14 : 0);

        // A row is columns * (size + gap) wide: never put more on a row than fits.
        const fit = Math.max(1, Math.floor(available / (layout.size + layout.gap)));
        const columns = Math.min(this._gs.get_int('category-columns'), fit);

        const rowAlign = {
            left: Clutter.ActorAlign.START,
            center: Clutter.ActorAlign.CENTER,
            right: Clutter.ActorAlign.END,
        }[layout.align] ?? Clutter.ActorAlign.CENTER;

        const wrap = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        wrap.style = centered ? 'margin-left: 14px;' : '';
        for (let i = 0; i < names.length; i += columns) {
            // Not expanded: a row of one or two folders stays where it is aligned
            const row = new St.BoxLayout({x_align: rowAlign});
            for (const name of names.slice(i, i + columns))
                row.add_child(this._makeCategoryCard(name, groups.get(name), layout));
            wrap.add_child(row);
        }
        return wrap;
    }

    _makeCategoryCard(name, apps, layout) {
        const {size, iconSize, gap, rowGap, align} = layout;

        // The card has a 1px border and 8px padding on every side
        const inner = Math.max(24, size - 18);
        const cell = Math.floor(inner / 2);
        const icon = Math.max(12, Math.min(iconSize, cell));
        const margin = Math.max(0, Math.floor((cell - icon) / 2));

        const button = new St.Button({style_class: 'forever-category', can_focus: true, reactive: true});
        // Centered: half the gap on each side. Left or right: the folders sit
        // flush against that edge and the gap goes on the other side.
        let gapLeft = Math.floor(gap / 2);
        let gapRight = gap - gapLeft;
        if (align === 'left') {
            gapLeft = 0;
            gapRight = gap;
        } else if (align === 'right') {
            gapLeft = gap;
            gapRight = 0;
        }
        button.style = `width: ${size}px; margin: 0 ${gapRight}px ${rowGap}px ${gapLeft}px;`;
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});

        const card = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'forever-category-card',
            x_align: Clutter.ActorAlign.CENTER,
        });
        card.style = `width: ${inner}px; height: ${inner}px;`;
        const preview = apps.slice(0, 4);
        for (let r = 0; r < 2; r++) {
            const row = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
            for (const app of preview.slice(r * 2, r * 2 + 2)) {
                const appIcon = new St.Icon({
                    gicon: app.get_icon(),
                    icon_size: icon,
                    style_class: 'forever-category-icon',
                });
                appIcon.style = `margin: ${margin}px;`;
                row.add_child(appIcon);
            }
            card.add_child(row);
        }
        box.add_child(card);

        const label = new St.Label({
            text: name,
            style_class: 'forever-category-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.style = `max-width: ${size}px;`;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);
        button.set_child(box);

        button.connect('clicked', () => {
            this._showFlyout(apps.map(app => ({
                label: app.get_name(),
                gicon: app.get_icon(),
                action: () => this._launch(app),
            })), button, 'below');
        });
        return button;
    }

    _makeTile(app, width, iconSize) {
        const button = new St.Button({
            style_class: 'forever-tile',
            can_focus: true,
            reactive: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
        });
        button.style = `width: ${width}px;`;
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        box.add_child(new St.Icon({
            gicon: app.get_icon(),
            icon_size: iconSize,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        const label = new St.Label({
            text: app.get_name(),
            style_class: 'forever-tile-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.style = `max-width: ${width}px;`;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(label);
        button.set_child(box);
        button.connect('clicked', (_b, mouseButton) => this._onAppClicked(app, button, mouseButton));
        return button;
    }

    _makeListItem(app, {half = false, subtitle = null} = {}) {
        const item = this._clickable(
            half ? 'forever-list-item forever-list-item-half' : 'forever-list-item',
            button => this._onAppClicked(app, item, button),
            {allowRight: true});
        item.x_expand = !half;
        if (half) {
            // two per row; the item's own 20px of padding comes out of its half
            item.style = `width: ${Math.floor(this._viewportWidth() / 2) - 22}px;`;
        }

        item.add_child(new St.Icon({
            gicon: app.get_icon(),
            icon_size: 28,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const name = new St.Label({
            text: app.get_name(),
            style_class: 'forever-list-name',
            x_align: Clutter.ActorAlign.START,
        });
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(name);
        if (subtitle) {
            text.add_child(new St.Label({
                text: subtitle,
                style_class: 'forever-list-subtitle',
                x_align: Clutter.ActorAlign.START,
            }));
        }
        item.add_child(text);
        return item;
    }

    _onAppClicked(app, actor, mouseButton) {
        if (mouseButton === 3) {
            this._showFlyout(this._appContextEntries(app), actor, 'below-start');
            return;
        }
        this._launch(app);
    }

    _appContextEntries(app) {
        const id = app.get_id();
        const entries = [
            {
                label: this._isStartPinned(id) ? 'Unpin from Start' : 'Pin to Start',
                action: () => this._toggleStartPin(id),
            },
            {
                label: AppFavorites.getAppFavorites().isFavorite(id) ? 'Unpin from taskbar' : 'Pin to taskbar',
                action: () => this._toggleTaskbarPin(id),
            },
        ];
        return [...this._appActionEntries(app), ...entries];
    }

    // What GNOME's own app menu offers: New window, and the extra actions an
    // app lists in its .desktop file (for example "New private window").
    _appActionEntries(app) {
        const entries = [];
        const run = fn => () => {
            this._menu?.close();
            fn();
        };
        const running = app.state === Shell.AppState.RUNNING;
        if (running && app.can_open_new_window()) {
            entries.push({
                label: 'New window',
                action: run(() => app.open_new_window(-1)),
            });
        }
        const info = app.get_app_info();
        if (info && typeof info.list_actions === 'function') {
            for (const name of info.list_actions()) {
                if (name.toLowerCase().replace(/_/g, '-') === 'new-window' && entries.length > 0)
                    continue;
                const label = info.get_action_name(name);
                if (!label)
                    continue;
                entries.push({
                    label,
                    action: run(() => info.launch_action(name, global.create_app_launch_context(0, -1))),
                });
            }
        }
        return entries;
    }

    _launch(app) {
        this._menu.close();
        app.activate();
    }

    // --- Search ------------------------------------------------------

    _onSearchChanged() {
        const text = this._search.get_text().trim();
        this._searchToken = (this._searchToken ?? 0) + 1;
        if (this._providerTimer) {
            GLib.source_remove(this._providerTimer);
            this._providerTimer = 0;
        }
        this._providerSections = new Map();
        if (!text) {
            this._results = [];
            this._showView('page');
            return;
        }

        const sys = Shell.AppSystem.get_default();
        const seen = new Set();
        const apps = [];
        try {
            for (const group of Gio.DesktopAppInfo.search(text)) {
                for (const id of group) {
                    if (seen.has(id))
                        continue;
                    seen.add(id);
                    const app = sys.lookup_app(id);
                    if (app?.get_app_info()?.should_show())
                        apps.push(app);
                }
            }
        } catch (e) {
            console.error(`[4ever] search failed: ${e.message}`);
        }
        this._results = apps.slice(0, MAX_SEARCH_RESULTS);

        const box = this._resultsView.box;
        box.destroy_all_children();
        this._appsTitle = new St.Label({
            text: this._results.length > 0 ? 'Apps' : 'Searching…',
            style_class: 'forever-section-title forever-results-title',
            x_align: Clutter.ActorAlign.START,
        });
        box.add_child(this._appsTitle);
        for (const app of this._results)
            box.add_child(this._makeListItem(app));
        this._providerBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        box.add_child(this._providerBox);
        this._showView('results');

        // Files, folders, documents and more come from GNOME's search providers
        const token = this._searchToken;
        this._providerTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._providerTimer = 0;
            this._searchProviders(text, token);
            return GLib.SOURCE_REMOVE;
        });
    }

    _searchProviders(text, token) {
        try {
            this._providers ??= loadProviders();
        } catch (e) {
            console.error(`[4ever] could not load search providers: ${e.message}`);
            this._providers = [];
        }
        const terms = text.split(/\s+/).filter(Boolean);
        let pending = this._providers.length;
        const settle = () => {
            if (token !== this._searchToken)
                return;
            if (this._providers.length > 0 && --pending > 0)
                return;
            if (this._providerSections.size === 0 && this._results.length === 0 && this._appsTitle)
                this._appsTitle.text = `No results for “${text}”`;
            else if (this._results.length === 0 && this._appsTitle)
                this._appsTitle.visible = false;
        };
        if (this._providers.length === 0) {
            settle();
            return;
        }
        this._providers.forEach((provider, index) => {
            queryProvider(provider, terms)
                .then(found => {
                    if (token !== this._searchToken || !found)
                        return;
                    this._providerSections.set(index, found);
                    this._renderProviderResults(terms);
                })
                .catch(() => {})
                .finally(settle);
        });
    }

    _renderProviderResults(terms) {
        const box = this._providerBox;
        if (!box)
            return;
        box.destroy_all_children();
        const order = [...this._providerSections.keys()].sort((a, b) => a - b);
        for (const index of order) {
            const {provider, results, total} = this._providerSections.get(index);
            box.add_child(new St.Label({
                text: provider.app.get_name(),
                style_class: 'forever-section-title forever-results-title',
                x_align: Clutter.ActorAlign.START,
            }));
            for (const result of results)
                box.add_child(this._makeProviderRow(provider, result, terms));
            if (total > results.length) {
                const more = this._clickable('forever-list-item', () => {
                    this._menu.close();
                    launchSearch(provider, terms, global.get_current_time()).catch(() => {});
                });
                more.add_child(new St.Label({
                    text: `Show ${total - results.length} more in ${provider.app.get_name()}`,
                    style_class: 'forever-list-subtitle',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                box.add_child(more);
            }
        }
    }

    _makeProviderRow(provider, result, terms) {
        const row = this._clickable('forever-list-item', () => this._activateProviderResult(provider, result, terms));
        row.x_expand = true;
        row.add_child(new St.Icon({
            gicon: result.gicon ?? provider.app.get_icon(),
            icon_size: 28,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const name = new St.Label({text: result.name, style_class: 'forever-list-name', x_align: Clutter.ActorAlign.START});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(name);
        if (result.description) {
            const description = new St.Label({
                text: result.description,
                style_class: 'forever-list-subtitle',
                x_align: Clutter.ActorAlign.START,
            });
            description.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
            text.add_child(description);
        }
        row.add_child(text);
        return row;
    }

    _activateProviderResult(provider, result, terms) {
        this._menu.close();
        activateResult(provider, result.id, terms, global.get_current_time())
            .catch(e => console.error(`[4ever] could not open ${result.name}: ${e.message}`));
    }

    _activateFirstResult() {
        if (this._view !== 'results')
            return;
        if (this._results?.length > 0) {
            this._launch(this._results[0]);
            return;
        }
        // No app matched: open the first file, folder or other result
        const first = [...(this._providerSections?.keys() ?? [])].sort((a, b) => a - b)[0];
        const section = first !== undefined ? this._providerSections.get(first) : null;
        if (section?.results.length > 0) {
            const terms = this._search.get_text().trim().split(/\s+/).filter(Boolean);
            this._activateProviderResult(section.provider, section.results[0], terms);
        }
    }

    // --- Flyouts (power menu, profile menu, right-click menus) -------

    _powerActions() {
        return {
            sleep: {
                label: 'Sleep',
                icon: 'weather-clear-night-symbolic',
                action: () => this._run('systemctl suspend'),
            },
            shutdown: {
                label: 'Shut down',
                icon: 'system-shutdown-symbolic',
                action: () => this._run('gnome-session-quit --power-off'),
            },
            restart: {
                label: 'Restart',
                icon: 'system-reboot-symbolic',
                action: () => this._run('gnome-session-quit --reboot'),
            },
            lock: {
                label: 'Lock',
                icon: 'system-lock-screen-symbolic',
                action: () => Main.screenShield?.lock(true),
            },
            signout: {
                label: 'Sign out',
                icon: 'system-log-out-symbolic',
                action: () => this._run('gnome-session-quit --logout'),
            },
        };
    }

    _powerEntries() {
        const a = this._powerActions();
        return [a.sleep, a.shutdown, a.restart, 'separator', a.lock, a.signout];
    }

    _userEntries() {
        const a = this._powerActions();
        const entries = [{header: true, title: this._userName, subtitle: 'Local account'}, 'separator'];
        if (hasProgram('gnome-control-center')) {
            entries.push({
                label: 'Change account settings',
                icon: 'avatar-default-symbolic',
                action: () => this._run('gnome-control-center system'),
            });
        }
        entries.push(a.lock, a.signout);
        return entries;
    }

    _run(command) {
        this._menu?.close();
        spawn(command);
    }

    _makeFlyoutHeader(entry) {
        const header = new St.BoxLayout({style_class: 'forever-flyout-header', x_expand: true});
        header.add_child(this._makeAvatar(36));
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.add_child(new St.Label({
            text: entry.title,
            style_class: 'forever-flyout-title',
            x_align: Clutter.ActorAlign.START,
        }));
        if (entry.subtitle) {
            text.add_child(new St.Label({
                text: entry.subtitle,
                style_class: 'forever-list-subtitle',
                x_align: Clutter.ActorAlign.START,
            }));
        }
        header.add_child(text);
        return header;
    }

    _showFlyout(entries, anchor, placement) {
        this._flyout.destroy_all_children();
        const anyIcon = entries.some(e => e !== 'separator' && (e.icon || e.gicon));
        for (const entry of entries) {
            if (entry === 'separator') {
                this._flyout.add_child(new St.Widget({style_class: 'forever-flyout-separator', x_expand: true}));
                continue;
            }
            if (entry.header) {
                this._flyout.add_child(this._makeFlyoutHeader(entry));
                continue;
            }

            const item = this._clickable('forever-flyout-item', () => {
                this._hideFlyout();
                entry.action();
            });
            item.x_expand = true;

            if (entry.gicon) {
                item.add_child(new St.Icon({
                    gicon: entry.gicon,
                    icon_size: 20,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            } else if (entry.icon) {
                item.add_child(new St.Icon({
                    icon_name: entry.icon,
                    icon_size: 16,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            } else if (anyIcon) {
                item.add_child(new St.Widget({style_class: 'forever-flyout-icon-gap'}));
            }
            item.add_child(new St.Label({
                text: entry.label,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            this._flyout.add_child(item);
        }

        this._overlay.show();

        const panel = this._flyoutScroll;
        const [rootX, rootY] = this._root.get_transformed_position();
        const [anchorX, anchorY] = anchor.get_transformed_position();
        const [, width] = panel.get_preferred_width(-1);
        const [, height] = panel.get_preferred_height(width);

        let x;
        let y;
        switch (placement) {
        case 'above-end':
            x = anchorX - rootX + anchor.width - width;
            y = anchorY - rootY - height - 8;
            break;
        case 'above-start':
            x = anchorX - rootX;
            y = anchorY - rootY - height - 8;
            break;
        case 'below-start':
            x = anchorX - rootX + 24;
            y = anchorY - rootY + anchor.height - 4;
            break;
        default:
            x = anchorX - rootX + anchor.width / 2 - width / 2;
            y = anchorY - rootY + anchor.height - 6;
        }
        x = Math.max(8, Math.min(x, this._root.width - width - 8));
        y = Math.max(8, Math.min(y, this._root.height - height - 8));
        panel.set_position(Math.round(x), Math.round(y));
    }

    _hideFlyout() {
        this._overlay?.hide();
    }

    // --- Right-click menu on the Start button ------------------------

    _showWinXMenu() {
        if (!this._winxMenu) {
            const menu = new PopupMenu.PopupMenu(this._startButton, 0.5, St.Side.BOTTOM);
            menu.actor.add_style_class_name('forever-winx-menu');
            Main.uiGroup.add_child(menu.actor);
            menu.actor.hide();
            Main.panel.menuManager.addMenu(menu);
            this._winxMenu = menu;
        }

        const menu = this._winxMenu;
        menu.removeAll();

        const action = (label, fn) => menu.addAction(label, () => defer(fn));
        const first = bins => bins.find(hasProgram);
        const hasCC = hasProgram('gnome-control-center');

        if (hasCC) {
            action('Installed apps', () => spawn('gnome-control-center applications'));
            action('Power options', () => spawn('gnome-control-center power'));
        }
        if (hasProgram('gnome-logs'))
            action('Event viewer', () => spawn('gnome-logs'));
        if (hasCC) {
            action('System', () => spawn('gnome-control-center system'));
            action('Network connections', () => spawn('gnome-control-center network'));
        }
        if (hasProgram('gnome-disks'))
            action('Disk management', () => spawn('gnome-disks'));
        const terminal = first(['ptyxis', 'kgx', 'gnome-terminal', 'konsole', 'xterm']);
        if (terminal)
            action('Terminal', () => spawn(terminal));

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const monitor = first(['gnome-system-monitor', 'resources', 'missioncenter']);
        if (monitor)
            action('Task manager', () => spawn(monitor));
        if (hasCC)
            action('Settings', () => spawn('gnome-control-center'));
        if (hasProgram('nautilus'))
            action('File explorer', () => spawn('nautilus'));
        action('Search', () => this._menu.open());
        action('Run', () => Main.openRunDialog?.());

        const power = new PopupMenu.PopupSubMenuMenuItem('Shut down or sign out');
        const a = this._powerActions();
        for (const entry of [a.signout, a.sleep, a.shutdown, a.restart])
            power.menu.addAction(entry.label, () => defer(entry.action));
        menu.addMenuItem(power);

        action('Desktop', () => {
            const workspace = global.workspace_manager.get_active_workspace();
            for (const win of workspace.list_windows()) {
                if (!win.skip_taskbar)
                    win.minimize();
            }
        });

        menu.toggle();
    }

    // ------------------------------------------------------------------
    // Taskbar apps
    // ------------------------------------------------------------------

    _clearAppMenus() {
        for (const menu of this._appMenus ?? []) {
            try {
                Main.panel.menuManager.removeMenu(menu);
            } catch (_e) {
                // already removed
            }
            menu.destroy();
        }
        this._appMenus = [];
    }

    _showAppMenu(button, app) {
        if (!button._foreverMenu) {
            const menu = new PopupMenu.PopupMenu(button, 0.5, St.Side.BOTTOM);
            menu.actor.add_style_class_name('forever-app-menu');
            Main.uiGroup.add_child(menu.actor);
            menu.actor.hide();
            Main.panel.menuManager.addMenu(menu);
            this._appMenus.push(menu);
            button._foreverMenu = menu;
        }

        const menu = button._foreverMenu;
        const id = app.get_id();
        menu.removeAll();
        const appActions = this._appActionEntries(app);
        for (const entry of appActions)
            menu.addAction(entry.label, () => defer(entry.action));
        if (appActions.length > 0)
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(
            AppFavorites.getAppFavorites().isFavorite(id) ? 'Unpin from taskbar' : 'Pin to taskbar',
            () => defer(() => this._toggleTaskbarPin(id)));
        menu.addAction(
            this._isStartPinned(id) ? 'Unpin from Start' : 'Pin to Start',
            () => defer(() => this._toggleStartPin(id)));
        const windows = app.get_windows();
        if (windows.length > 0) {
            menu.addAction(windows.length > 1 ? 'Close all windows' : 'Close window', () => {
                for (const win of windows)
                    win.delete(global.get_current_time());
            });
        }
        menu.toggle();
    }

    _isFixedTaskbarChild(child) {
        return child === this._startButton ||
            child === this._searchWidget ||
            child === this._taskViewButton;
    }

    // The apps to show: favourites and running apps. On another monitor the
    // list can be limited to the apps that have a window on that monitor.
    _appList(monitorIndex) {
        const onlyHere = monitorIndex !== null && this._gs.get_string('mm-apps-mode') === 'monitor';
        const apps = new Map();
        if (!onlyHere) {
            for (const app of AppFavorites.getAppFavorites().getFavorites())
                apps.set(app.get_id(), app);
        }
        for (const app of Shell.AppSystem.get_default().get_running())
            apps.set(app.get_id(), app);
        const list = [...apps.values()];
        if (!onlyHere)
            return list;
        return list.filter(app => app.get_windows().some(w => w.get_monitor() === monitorIndex));
    }

    _makeAppButton(app, focused, monitorIndex) {
        const running = app.state === Shell.AppState.RUNNING;
        let styleClass = 'forever-app-button';
        if (running)
            styleClass += ' running';
        const isActive = running && focused && focused.get_id() === app.get_id();
        if (isActive)
            styleClass += ' active';

        const iconSize = this._gs.get_int('app-icon-size');
        // Icon with a coloured bar under it while the app is running
        const content = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style: `height: ${iconSize + 6}px;`,
        });
        content.add_child(new St.Icon({
            gicon: app.get_icon(),
            icon_size: iconSize,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        }));
        if (running) {
            const bar = new St.Widget({
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.END,
                style: `width: ${isActive ? 18 : 6}px; height: 3px; border-radius: 2px; ` +
                    `background-color: ${this._indicatorColor()};`,
            });
            bar.opacity = isActive ? 255 : 150;
            content.add_child(bar);
        }
        const btn = new St.Button({
            style_class: styleClass,
            style: `padding: 3px ${Math.round(iconSize * 0.42)}px;`,
            child: content,
            reactive: true,
            can_focus: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
        });
        btn.connect('clicked', (_b, mouseButton) => {
            if (mouseButton === 3) {
                this._showAppMenu(btn, app);
                return;
            }
            const windows = app.get_windows();
            if (windows.length === 0) {
                app.activate();
                return;
            }
            const target = (monitorIndex !== null
                ? windows.find(w => w.get_monitor() === monitorIndex)
                : null) ?? windows[0];
            if (target.has_focus() && !target.minimized)
                target.minimize();
            else
                Main.activateWindow(target);
        });
        this._attachTooltip(btn, app.get_name());
        return btn;
    }

    _rebuildApps() {
        if (!this._taskbar)
            return;
        this._clearAppMenus();
        this._hideTooltip();

        // Remove everything except the fixed buttons (Start, Search, Task view)
        for (const child of this._taskbar.get_children()) {
            if (!this._isFixedTaskbarChild(child))
                child.destroy();
        }

        const focused = Shell.WindowTracker.get_default().focus_app;
        for (const app of this._appList(null))
            this._taskbar.add_child(this._makeAppButton(app, focused, null));
        for (const bar of this._bars)
            this._fillBarApps(bar);
    }
}
