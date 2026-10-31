import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ForeverPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const handlers = [];
        window.connect('close-request', () => {
            for (const id of handlers)
                settings.disconnect(id);
            handlers.length = 0;
            return false;
        });
        window.set_default_size(640, 760);

        const watch = (key, callback) => {
            handlers.push(settings.connect(`changed::${key}`, callback));
        };

        const switchRow = (title, subtitle, key) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        const comboRow = (title, subtitle, key, options) => {
            const row = new Adw.ComboRow({
                title,
                subtitle,
                model: Gtk.StringList.new(options.map(([, label]) => label)),
            });
            const sync = () => {
                const index = options.findIndex(([id]) => id === settings.get_string(key));
                if (index >= 0 && row.selected !== index)
                    row.selected = index;
            };
            sync();
            row.connect('notify::selected', () => {
                const choice = options[row.selected];
                if (choice && settings.get_string(key) !== choice[0])
                    settings.set_string(key, choice[0]);
            });
            watch(key, sync);
            return row;
        };

        const spinRow = (title, subtitle, key, min, max, step) => {
            const row = new Adw.SpinRow({
                title,
                subtitle,
                adjustment: new Gtk.Adjustment({
                    lower: min,
                    upper: max,
                    step_increment: step,
                    page_increment: step * 5,
                    value: settings.get_int(key),
                }),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        const page = (title, icon, groups) => {
            const p = new Adw.PreferencesPage({title, icon_name: icon});
            for (const group of groups)
                p.add(group);
            window.add(p);
        };

        const group = (title, description, rows) => {
            const g = new Adw.PreferencesGroup({title, description});
            for (const row of rows)
                g.add(row);
            return g;
        };

        // Colour of the bar under running apps
        const colorRow = new Adw.ActionRow({
            title: 'Running-app bar colour',
            subtitle: 'The bar under apps that are open. Reset to follow the theme.',
        });
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        const syncColor = () => {
            const rgba = new Gdk.RGBA();
            const chosen = settings.get_string('indicator-color');
            if (!/^#[0-9a-fA-F]{6}$/.test(chosen) || !rgba.parse(chosen))
                rgba.parse('#60cdff');
            colorButton.rgba = rgba;
        };
        syncColor();
        watch('indicator-color', syncColor);
        colorButton.connect('notify::rgba', () => {
            const c = colorButton.rgba;
            const hex = '#' + [c.red, c.green, c.blue]
                .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
            if (settings.get_string('indicator-color').toLowerCase() !== hex)
                settings.set_string('indicator-color', hex);
        });
        const colorReset = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: 'Follow the theme',
            valign: Gtk.Align.CENTER,
        });
        colorReset.add_css_class('flat');
        colorReset.connect('clicked', () => settings.reset('indicator-color'));
        colorRow.add_suffix(colorButton);
        colorRow.add_suffix(colorReset);

        // ---------------- Taskbar ----------------
        page('Taskbar', 'view-continuous-symbolic', [
            group('Size', null, [
                spinRow('Taskbar height', 'In pixels. The default is 48.', 'taskbar-height', 32, 96, 2),
                spinRow('App icon size', 'Size of the icons on the taskbar, in pixels.', 'app-icon-size', 16, 48, 2),
                spinRow('Space between icons', 'In pixels.', 'icon-spacing', 0, 24, 1),
            ]),
            group('Look', null, [
                colorRow,
                switchRow('Highlight the Start button', 'Gives Start its own background so it stands out from the other icons.', 'start-highlight'),
            ]),
            group('Search', null, [
                comboRow('Taskbar search', 'Hide it, show only a magnifier, or show the full search box.', 'search-mode', [
                    ['hidden', 'Hidden'],
                    ['icon', 'Search icon only'],
                    ['box', 'Search box'],
                ]),
                spinRow('Search box height', 'In pixels, used when the search box is shown.', 'search-height', 24, 48, 2),
                spinRow('Search box width', 'In pixels, used when the search box is shown.', 'search-width', 60, 400, 10),
            ]),
            group('Buttons and keys', null, [
                switchRow('Show Task view button', 'The button that shows all your open windows.', 'show-task-view'),
                switchRow('Show hidden-icons arrow', 'An arrow next to the system icons that lists apps running in the background (Discord, Telegram…).', 'show-tray'),
                comboRow('Hidden-icons view', 'Icons in a grid, or icons with their names.', 'tray-view', [
                    ['grid', 'Grid of icons'],
                    ['list', 'Icons with names'],
                ]),
                spinRow('Hidden icons per row', 'The box grows or shrinks to fit.', 'tray-columns', 1, 8, 1),
                spinRow('Hidden icon size', 'In pixels.', 'tray-icon-size', 16, 48, 2),
                spinRow('Space between hidden icons', 'In pixels.', 'tray-spacing', 0, 16, 1),
                switchRow('Skip the overview at login', 'Go straight to the desktop after logging in instead of GNOME\u2019s overview.', 'skip-login-overview'),
                switchRow('Show desktop strip', 'The thin strip at the right end of the taskbar. Click it to minimize everything, click again to bring it back.', 'show-desktop'),
                switchRow('Taskbar over full-screen apps', 'While Start is open, show the taskbar on top of games and other full-screen windows.', 'fullscreen-reveal'),
                switchRow('Hide the dash in Task view', 'Removes the row of pinned and running apps along the bottom of the Task view.', 'hide-overview-dash'),
                switchRow('Super key opens Start',
                    'Pressing the Super (Windows) key opens the Start menu instead of the GNOME overview.',
                    'super-key'),
            ]),
        ]);

        // ---------------- Monitors ----------------
        page('Monitors', 'video-display-symbolic', [
            group('Extra monitors', 'Put a taskbar on every other monitor, and choose what is on it.', [
                switchRow('Taskbar on every monitor', null, 'multi-monitor'),
            ]),
            group('What to show on the extra taskbars', null, [
                switchRow('Start button', null, 'mm-show-start'),
                switchRow('App icons', null, 'mm-show-apps'),
                comboRow('Apps shown', 'Only the apps that have a window on that monitor, or the same apps as the main taskbar.', 'mm-apps-mode', [
                    ['monitor', 'Only apps on that monitor'],
                    ['all', 'Same as the main taskbar'],
                ]),
                switchRow('Hidden-icons arrow', null, 'mm-show-tray'),
                switchRow('Clock', null, 'mm-show-clock'),
                switchRow('Show desktop strip', null, 'mm-show-desktop'),
            ]),
        ]);

        // ---------------- Start menu ----------------
        const iconRow = new Adw.ActionRow({title: 'Custom image'});
        const syncIconRow = () => {
            const path = settings.get_string('start-icon-path');
            iconRow.subtitle = path ? GLib.path_get_basename(path) : 'No image chosen';
        };
        syncIconRow();
        watch('start-icon-path', syncIconRow);

        const chooseButton = new Gtk.Button({label: 'Choose…', valign: Gtk.Align.CENTER});
        chooseButton.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Choose a Start button image'});
            const filter = new Gtk.FileFilter({name: 'Images'});
            filter.add_mime_type('image/*');
            const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
            filters.append(filter);
            dialog.set_filters(filters);
            dialog.open(window, null, (dlg, result) => {
                try {
                    const file = dlg.open_finish(result);
                    settings.set_string('start-icon-path', file.get_path());
                    settings.set_string('start-icon-source', 'custom');
                } catch (_e) {
                    // dialog was cancelled
                }
            });
        });
        const resetButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: 'Go back to the 4ever icon',
            valign: Gtk.Align.CENTER,
        });
        resetButton.add_css_class('flat');
        resetButton.connect('clicked', () => {
            settings.set_string('start-icon-path', '');
            settings.set_string('start-icon-source', 'pack');
        });
        iconRow.add_suffix(chooseButton);
        iconRow.add_suffix(resetButton);

        // Section order: move Pinned, Recommended and All up or down
        const sectionNames = [['all', 'All apps'], ['recommended', 'Recommended'], ['pinned', 'Pinned']];
        const readSectionOrder = () => {
            const asked = settings.get_string('section-order').split(',').map(id => id.trim());
            const order = asked.filter((id, i) => sectionNames.some(([known]) => known === id) &&
                asked.indexOf(id) === i);
            for (const [id] of sectionNames) {
                if (!order.includes(id))
                    order.push(id);
            }
            return order;
        };

        const orderGroup = group('Section order',
            'The section at the top is the first one you see when Start opens.', []);
        const sectionRows = new Map();
        let shownRows = [];
        const positions = ['Top', 'Middle', 'Bottom'];

        const moveSection = (id, step) => {
            const order = readSectionOrder();
            const from = order.indexOf(id);
            const to = from + step;
            if (to < 0 || to >= order.length)
                return;
            [order[from], order[to]] = [order[to], order[from]];
            settings.set_string('section-order', order.join(','));
        };

        for (const [id, title] of sectionNames) {
            const row = new Adw.ActionRow({title});
            const up = new Gtk.Button({
                icon_name: 'go-up-symbolic',
                tooltip_text: 'Move up',
                valign: Gtk.Align.CENTER,
            });
            const down = new Gtk.Button({
                icon_name: 'go-down-symbolic',
                tooltip_text: 'Move down',
                valign: Gtk.Align.CENTER,
            });
            up.add_css_class('flat');
            down.add_css_class('flat');
            up.connect('clicked', () => moveSection(id, -1));
            down.connect('clicked', () => moveSection(id, 1));
            row.add_suffix(up);
            row.add_suffix(down);
            sectionRows.set(id, {row, up, down});
        }

        const renderSectionOrder = () => {
            const order = readSectionOrder();
            for (const row of shownRows)
                orderGroup.remove(row);
            shownRows = [];
            order.forEach((id, index) => {
                const {row, up, down} = sectionRows.get(id);
                row.subtitle = positions[index] ?? '';
                up.sensitive = index > 0;
                down.sensitive = index < order.length - 1;
                orderGroup.add(row);
                shownRows.push(row);
            });
        };
        renderSectionOrder();
        watch('section-order', renderSectionOrder);

        const layoutKeys = [
            'section-order', 'start-menu-width', 'start-menu-height', 'pinned-columns', 'pinned-icon-size',
            'category-align', 'category-columns', 'category-size', 'category-icon-size', 'category-gap', 'category-row-gap',
        ];
        const resetLayoutRow = new Adw.ActionRow({
            title: 'Reset layout',
            subtitle: 'Put the menu size, grid and folder settings back to their defaults.',
        });
        const resetLayoutButton = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
        resetLayoutButton.connect('clicked', () => {
            for (const key of layoutKeys)
                settings.reset(key);
        });
        resetLayoutRow.add_suffix(resetLayoutButton);

        page('Start menu', 'view-app-grid-symbolic', [
            group('Start button', null, [
                comboRow('Icon', 'The 4ever icon, your distribution\u2019s logo (picked up automatically), or your own image.', 'start-icon-source', [
                    ['pack', '4ever icon'],
                    ['os', 'Distribution logo'],
                    ['custom', 'Custom image'],
                ]),
                comboRow('4ever icon style', 'Used for the Start button, the search icon and Task view.', 'icon-style', [
                    ['transparent', 'Transparent'],
                    ['dark', 'Dark'],
                    ['light', 'Light'],
                    ['ember', 'Ember'],
                    ['auto', 'Match the theme'],
                ]),
                iconRow,
            ]),
            group('Contents', null, [
                switchRow('Show Pinned', 'The apps you pinned to Start.', 'show-pinned'),
                switchRow('Show Recommended', 'The apps you use most.', 'show-recommended'),
                comboRow('All apps view', 'How the full app list is shown.', 'all-view', [
                    ['category', 'Category'],
                    ['grid', 'Grid'],
                    ['list', 'List'],
                ]),
            ]),
            orderGroup,
            group('Menu size', 'Everything inside the menu is fitted to this width, so nothing can slide sideways.', [
                spinRow('Menu width', 'In pixels.', 'start-menu-width', 560, 1000, 10),
                spinRow('Menu height', 'Height of the scrolling area, in pixels.', 'start-menu-height', 320, 800, 10),
            ]),
            group('Pinned and Grid view', null, [
                spinRow('Apps per row', null, 'pinned-columns', 3, 10, 1),
                spinRow('Icon size', 'In pixels.', 'pinned-icon-size', 24, 64, 2),
            ]),
            group('Category folders', 'Folders are square. The number per row is limited by the menu width.', [
                comboRow('Folder position', 'Where the folders sit in the menu.', 'category-align', [
                    ['left', 'Left'],
                    ['center', 'Center'],
                    ['right', 'Right'],
                ]),
                spinRow('Folders per row', null, 'category-columns', 2, 8, 1),
                spinRow('Folder size', 'Width and height of each folder, in pixels.', 'category-size', 64, 180, 2),
                spinRow('Icon size inside folders', 'In pixels.', 'category-icon-size', 16, 64, 2),
                spinRow('Space between folders', 'Sideways, in pixels.', 'category-gap', 0, 60, 2),
                spinRow('Space between rows', 'In pixels.', 'category-row-gap', 0, 60, 2),
                resetLayoutRow,
            ]),
        ]);

        // ---------------- Clock ----------------
        const timeZoneRow = new Adw.EntryRow({
            title: 'Time zone (for example Europe/London). Leave empty for this computer’s.',
            show_apply_button: true,
            text: settings.get_string('clock-timezone'),
        });
        const applyTimeZone = () => {
            const value = timeZoneRow.get_text().trim();
            let valid = value === '';
            if (!valid) {
                try {
                    valid = GLib.TimeZone.new_identifier
                        ? GLib.TimeZone.new_identifier(value) !== null
                        : true;
                } catch (_e) {
                    valid = false;
                }
            }
            if (valid) {
                timeZoneRow.remove_css_class('error');
                settings.set_string('clock-timezone', value);
            } else {
                timeZoneRow.add_css_class('error');
            }
        };
        timeZoneRow.connect('apply', applyTimeZone);
        timeZoneRow.connect('entry-activated', applyTimeZone);

        page('Clock', 'preferences-system-time-symbolic', [
            group('Layout', null, [
                comboRow('Clock layout', 'How the time and date sit on the taskbar.', 'clock-layout', [
                    ['stacked', 'Time above date'],
                    ['inline', 'Time and date on one line'],
                    ['time', 'Time only'],
                ]),
            ]),
            group('Time', null, [
                comboRow('Time format', null, 'clock-time-format', [
                    ['system', 'Follow system'],
                    ['12h', '12 hour'],
                    ['24h', '24 hour'],
                ]),
                switchRow('Show seconds', null, 'clock-seconds'),
                timeZoneRow,
            ]),
            group('Date', null, [
                comboRow('Date format', null, 'clock-date-format', [
                    ['system', 'Follow system'],
                    ['iso', '2026-10-30'],
                    ['dmy', '30/10/2026'],
                    ['mdy', '10/30/2026'],
                    ['long', 'Fri 30 Oct'],
                ]),
            ]),
        ]);

        // ---------------- Appearance ----------------
        page('Appearance', 'applications-graphics-symbolic', [
            group('Transparency', '100 is solid, 0 is fully see-through. Each one is independent.', [
                spinRow('Taskbar', 'Percent opaque.', 'panel-opacity', 0, 100, 1),
                spinRow('Start menu', 'Percent opaque.', 'start-opacity', 0, 100, 1),
                spinRow('Hidden-icons box', 'Percent opaque.', 'tray-opacity', 0, 100, 1),
            ]),
            group('Theme', null, [
                comboRow('Look', 'Light, dark, or follow the GNOME style.', 'theme', [
                    ['system', 'Follow system'],
                    ['light', 'Light'],
                    ['dark', 'Dark'],
                ]),
            ]),
        ]);
    }
}
