#!/usr/bin/env python3
"""Drive the demo page in the system WebKitGTK (the engine Tauri embeds on Linux)
and run the checks in checks.js inside it.

Usage: python3 test/webkitgtk/run.py [http://localhost:5180/]
Needs a display (Wayland or X11) because WebKitGTK renders through GTK.
Exit code 0 when every check passes.
"""
import json
import os
import sys

# The offscreen GTK window only gets a GL context on the X11 backend.
os.environ["GDK_BACKEND"] = "x11"  # the session may set wayland; the offscreen window needs X11 for GL

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5180/"
HERE = os.path.dirname(os.path.abspath(__file__))
CHECKS = open(os.path.join(HERE, "checks.js")).read()

settings = WebKit2.Settings(
    enable_webgl=True,
    enable_developer_extras=True,
    enable_write_console_messages_to_stdout=True,
)
view = WebKit2.WebView(settings=settings)
win = Gtk.OffscreenWindow()
win.set_default_size(1000, 700)
win.add(view)
win.show_all()

result = {"ok": False}


def finish(code):
    Gtk.main_quit()
    sys.exit(code)


def on_poll(v, task):
    try:
        js = v.evaluate_javascript_finish(task)
        text = js.to_string()
    except Exception as e:  # noqa: BLE001
        print("harness error:", e)
        finish(2)
        return
    if not text:
        GLib.timeout_add(250, poll)
        return
    payload = json.loads(text)
    print(json.dumps(payload, indent=2))
    finish(0 if payload.get("ok") else 1)


def poll():
    view.evaluate_javascript("window.__edgelitResult || ''", -1, None, None, None, on_poll)
    return False


def run_checks():
    # checks.js is the body of an async function; the result is parked on
    # window because evaluate_javascript cannot return a Promise.
    src = (
        "(async () => { " + CHECKS + " })().then("
        "r => { window.__edgelitResult = JSON.stringify(r) },"
        "e => { window.__edgelitResult = JSON.stringify({ok:false, error: String(e && e.message || e) + ' | ' + String(e && e.stack || '')}) })"
    )
    view.evaluate_javascript(src, -1, None, None, None, None)
    GLib.timeout_add(500, poll)
    return False


def on_load(v, event):
    if event == WebKit2.LoadEvent.FINISHED:
        GLib.timeout_add(1500, run_checks)


view.connect("load-changed", on_load)
view.connect("load-failed", lambda *a: (print("load failed", a[2:]), finish(2)))
view.load_uri(URL)
GLib.timeout_add(60000, lambda: (print("timeout"), finish(3)))
Gtk.main()
