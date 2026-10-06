# Linux Printing Support

A friendly print dialog for Linux. Open a file, see exactly how it'll come out, and print it with no terminal and no drivers.

- **Live preview.** The app lays the pages out itself and the preview is rendered from the exact file sent to the printer.
- **Two-sided printing**, flipping on the long or short edge. Printers that can't flip paper get a guided manual mode: it prints the fronts, then tells you how to turn the stack over.
- **Layout:** auto / portrait / landscape, 1–16 pages per sheet, fit / fill / 100% / custom scale, and margin presets or custom margins in mm.
- **Pages:** all, odd, even, or ranges like `1-3, 5, 8-`, plus copies, collation and reverse order.
- **Color or black & white**, and draft / normal / high quality.
- **Printer status** with ink levels, paper-out and jam warnings, a print queue with cancel, and a one-click *Fix printing problems* button.
- **Any file:** PDF, images, Word/Excel/PowerPoint/OpenDocument, text and EPUB. Office files are converted through LibreOffice.

## Which printers work?

Any **driverless** printer, which covers nearly every printer sold since about 2010 that has the AirPrint, Mopria or IPP Everywhere logo. That includes most Canon PIXMA/MAXIFY/MegaTank, HP, Epson EcoTank, Brother and Samsung models.

- **Wi-Fi / network printers** are found automatically.
- **USB printers** work through [`ipp-usb`](https://github.com/OpenPrinting/ipp-usb), which the installer sets up. You don't need the manufacturer's Linux driver.

Printers aren't entered by hand. *Printer menu → Add a printer…* scans the network and USB, and *Add* sets the printer up (it asks for your password once). Paper sizes, two-sided support and color modes are read from the printer itself.

## Install

```sh
git clone <this repo> && cd linux-printing-support
./install.sh
```

The installer works on Arch, Debian/Ubuntu, Fedora and openSUSE. It installs CUPS, `ipp-usb`, Avahi and LibreOffice, then the app itself (through [uv](https://docs.astral.sh/uv/)), and adds it to your app launcher and to *Open with* for documents.

```sh
./install.sh --app-only    # just the app; you already have CUPS and ipp-usb
./install.sh --uninstall
```

## Use

- Open **Linux Printing Support** from your apps, or run `linux-printing-support file.pdf`.
- Drag a file onto the window, or press **Ctrl+O**. **Ctrl+P** prints.
- `linux-printing-support --no-window` runs just the server and prints a local URL to open in any browser.

## "It says printing but nothing comes out"

On Linux this usually means the printer was set up through the old `usb://` method. With driverless USB printers that queue hangs and holds the USB port, so nothing else can print either. Fix it like this:

1. Click *Fix printing problems* in the printer menu. It stops the stuck process and restarts `ipp-usb`.
2. Remove the old queue (`sudo lpadmin -x NAME`) and add the printer again from *Add a printer…*, which uses `ipp-usb`.

## How it works

A small Python server (stdlib `http.server` + [PyMuPDF](https://pymupdf.readthedocs.io/)) runs on `127.0.0.1` with a random token and opens the UI in a chromeless browser window. Printing goes through the standard CUPS tools (`lp`, `lpstat`, `ipptool`, `lpadmin` via `pkexec`), so it works with any CUPS setup and needs no compiled bindings.

```
src/linux_printing_support/
  __init__.py   launcher (server + app window)
  server.py     local HTTP API
  layout.py     file conversion, imposition, preview rendering, manual duplex
  cups.py       printers, capabilities, jobs, discovery, repair
  static/       the UI (plain HTML/CSS/JS, no build step)
```
