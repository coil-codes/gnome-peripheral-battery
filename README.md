# Peripheral Battery

A GNOME Shell 51 extension that shows the battery level of wireless peripherals (mice, keyboards,
game controllers, pens, touchpads, headsets) on the left of the top bar. Click it for per-device details.

- Reads devices straight from UPower over D-Bus. It doesn't use `libupower-glib`.
- Colours: amber at 20% or below, red at 10% or below, green icon while charging.
- Bluetooth devices that drop off UPower (for example a keyboard switched to its 2.4 GHz or wired mode) keep
  their last reading, dimmed, for up to 14 days. That cache lives in
  `$XDG_STATE_HOME/peripheral-battery/last.json` and stores only model name, percentage and time.
- The indicator hides itself when no peripheral reports a battery.

## Install from source

```sh
gnome-extensions pack --force .
gnome-extensions install --force peripheral-battery@coil-codes.github.io.shell-extension.zip
```

Log out and back in (Wayland), then:

```sh
gnome-extensions enable peripheral-battery@coil-codes.github.io
```

## License

GPL-2.0-or-later
