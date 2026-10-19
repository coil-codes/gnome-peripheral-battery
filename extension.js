// SPDX-License-Identifier: GPL-2.0-or-later
// Peripheral Battery: wireless peripheral battery % on the left of the top bar.
// Talks to UPower over D-Bus (like the shell's own power indicator). UPowerGlib is avoided on purpose:
// libupower-glib 1.91.3's get_devices2() hands gjs objects it then finalizes (segfault in gjs 1.90).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS = 'org.freedesktop.UPower';
const PATH = '/org/freedesktop/UPower';
const DEVICE_IFACE = 'org.freedesktop.UPower.Device';

const LOW = 20;
const CRITICAL = 10;
// UpDeviceKind values: mouse, keyboard, touchpad, pen, gaming input, headset, headphones, other audio.
const KIND = {MOUSE: 5, KEYBOARD: 6, GAMING_INPUT: 12, PEN: 13, TOUCHPAD: 14, HEADSET: 17, HEADPHONES: 19, OTHER_AUDIO: 21};
const PERIPHERAL_KINDS = new Set(Object.values(KIND));
const STATE_CHARGING = 1;
const STATE_NAMES = ['unknown', 'charging', 'discharging', 'empty', 'fully charged', 'pending charge', 'pending discharge'];
// Bluetooth devices (e.g. the GMK87 in BT mode) vanish from UPower when switched to another mode; keep their
// last reading on screen, dimmed, for up to this long. Saved across logins in $XDG_STATE_HOME.
const STALE_MAX_AGE_S = 14 * 24 * 3600;
const STALE_OPACITY = 120;

function prop(proxy, name) {
    return proxy.get_cached_property(name)?.unpack();
}

function iconFor(proxy) {
    // Some dongles (e.g. the VXE mouse) are reported as KEYBOARD, so trust the model name first.
    const model = (prop(proxy, 'Model') ?? '').toLowerCase();
    if (model.includes('mouse')) return 'input-mouse-symbolic';
    if (model.includes('keyboard')) return 'input-keyboard-symbolic';
    switch (prop(proxy, 'Type')) {
    case KIND.MOUSE: return 'input-mouse-symbolic';
    case KIND.KEYBOARD: return 'input-keyboard-symbolic';
    case KIND.GAMING_INPUT: return 'input-gaming-symbolic';
    case KIND.HEADSET:
    case KIND.HEADPHONES: return 'audio-headphones-symbolic';
    default: return 'battery-symbolic';
    }
}

function isShown(proxy) {
    return prop(proxy, 'IsPresent') && !prop(proxy, 'PowerSupply') && PERIPHERAL_KINDS.has(prop(proxy, 'Type'));
}

function isBluetooth(proxy) {
    return (prop(proxy, 'NativePath') ?? '').startsWith('/org/bluez/');
}

function ageText(seconds) {
    if (seconds < 120) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 2 * 86400) return `${Math.floor(seconds / 3600)} h ago`;
    return `${Math.floor(seconds / 86400)} days ago`;
}

export default class PeripheralBattery extends Extension {
    enable() {
        this._button = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box pbat'});
        this._button.add_child(this._box);
        this._button.visible = false;
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'left');

        this._proxies = new Map();
        this._stateFile = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_state_dir(), 'peripheral-battery', 'last.json']));
        this._lastSeen = this._loadState();
        // Keeps the "N min ago" text and the 14-day expiry current while nothing else changes.
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 60, () => {
            this._queueSync();
            return GLib.SOURCE_CONTINUE;
        });
        this._cancellable = new Gio.Cancellable();
        this._bus = Gio.DBus.system;
        this._busSubs = [
            this._bus.signal_subscribe(BUS, BUS, 'DeviceAdded', PATH, null, Gio.DBusSignalFlags.NONE,
                (_c, _s, _p, _i, _n, params) => this._track(params.deepUnpack()[0])),
            this._bus.signal_subscribe(BUS, BUS, 'DeviceRemoved', PATH, null, Gio.DBusSignalFlags.NONE,
                (_c, _s, _p, _i, _n, params) => this._untrack(params.deepUnpack()[0])),
        ];
        this._bus.call(BUS, PATH, BUS, 'EnumerateDevices', null, new GLib.VariantType('(ao)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable, (bus, res) => {
                try {
                    const [paths] = bus.call_finish(res).deepUnpack();
                    paths.forEach(p => this._track(p));
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) logError(e, this.uuid);
                }
            });
    }

    disable() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._syncId) GLib.source_remove(this._syncId);
        this._syncId = 0;
        if (this._tickId) GLib.source_remove(this._tickId);
        this._tickId = 0;
        for (const id of this._busSubs ?? []) this._bus.signal_unsubscribe(id);
        this._busSubs = null;
        this._bus = null;
        for (const {proxy, id} of this._proxies?.values() ?? []) proxy.disconnect(id);
        this._proxies = null;
        this._lastSeen = null;
        this._stateFile = null;
        this._button?.destroy();
        this._button = null;
        this._box = null;
    }

    _track(path) {
        if (!this._proxies || this._proxies.has(path)) return;
        this._proxies.set(path, null); // reserve while the proxy loads
        Gio.DBusProxy.new(this._bus, Gio.DBusProxyFlags.NONE, null, BUS, path, DEVICE_IFACE,
            this._cancellable, (_o, res) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) logError(e, this.uuid);
                    this._proxies?.delete(path);
                    return;
                }
                if (!this._proxies?.has(path)) return; // removed or disabled meanwhile
                const id = proxy.connect('g-properties-changed', () => this._queueSync());
                this._proxies.set(path, {proxy, id});
                this._queueSync();
            });
    }

    _untrack(path) {
        const entry = this._proxies?.get(path);
        entry?.proxy.disconnect(entry.id);
        this._proxies?.delete(path);
        this._queueSync();
    }

    _queueSync() {
        // Coalesce bursts of property changes into one redraw.
        if (this._syncId || !this._box) return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _loadState() {
        try {
            const [, bytes] = this._stateFile.load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            return typeof data === 'object' && data ? data : {};
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) logError(e, this.uuid);
            return {};
        }
    }

    _saveState() {
        try {
            this._stateFile.get_parent().make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) logError(e, this.uuid);
        }
        try {
            this._stateFile.replace_contents(new TextEncoder().encode(JSON.stringify(this._lastSeen)),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            logError(e, this.uuid);
        }
    }

    _addRow(icon, pct, state, label, stale) {
        const item = new St.BoxLayout({style_class: 'pbat'});
        if (stale) item.opacity = STALE_OPACITY;
        else if (state === STATE_CHARGING) item.add_style_class_name('pbat-charging');
        else if (pct <= CRITICAL) item.add_style_class_name('pbat-critical');
        else if (pct <= LOW) item.add_style_class_name('pbat-low');
        item.add_child(new St.Icon({icon_name: icon, style_class: 'system-status-icon pbat-icon'}));
        item.add_child(new St.Label({
            text: `${pct}%`, style_class: 'pbat-label', y_align: Clutter.ActorAlign.CENTER,
        }));
        this._box.add_child(item);
        this._button.menu.addMenuItem(new PopupMenu.PopupMenuItem(label, {reactive: false}));
    }

    _sync() {
        this._box.destroy_all_children();
        this._button.menu.removeAll();

        const now = Math.floor(Date.now() / 1000);
        const live = [...this._proxies.values()].filter(e => e).map(e => e.proxy).filter(isShown);
        const liveKeys = new Set();
        let dirty = false;

        const rows = [];
        for (const dev of live) {
            const pct = Math.round(prop(dev, 'Percentage') ?? 0);
            const state = prop(dev, 'State') ?? 0;
            const model = prop(dev, 'Model') || 'Device';
            const icon = iconFor(dev);
            rows.push({icon, pct, state, stale: false, label: `${model}: ${pct}% (${STATE_NAMES[state] ?? 'unknown'})`});
            if (isBluetooth(dev)) {
                const key = prop(dev, 'NativePath');
                liveKeys.add(key);
                const prev = this._lastSeen[key];
                // Only rewrite the file when the reading changes, or hourly to keep the age honest.
                if (!prev || prev.pct !== pct || now - prev.time >= 3600) {
                    this._lastSeen[key] = {model, icon, pct, time: now};
                    dirty = true;
                }
            }
        }

        for (const [key, last] of Object.entries(this._lastSeen)) {
            if (liveKeys.has(key)) continue;
            const age = now - last.time;
            if (age > STALE_MAX_AGE_S) {
                delete this._lastSeen[key];
                dirty = true;
                continue;
            }
            rows.push({icon: last.icon, pct: last.pct, state: 0, stale: true,
                label: `${last.model}: ${last.pct}% (last seen over Bluetooth, ${ageText(age)})`});
        }
        if (dirty) this._saveState();

        rows.sort((a, b) => a.icon.localeCompare(b.icon));
        for (const r of rows) this._addRow(r.icon, r.pct, r.state, r.label, r.stale);
        this._button.visible = rows.length > 0;
    }
}
