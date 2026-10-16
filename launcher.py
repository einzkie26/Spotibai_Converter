from __future__ import annotations

import os
import argparse
import json
import socket
import sys
import tempfile
import queue
import threading
import tkinter as tk
from tkinter import messagebox, scrolledtext, ttk
import webbrowser

from launcher_core import DesktopController, NO_WINDOW, ROOT, SUPPORTED, check_requirements, find_python, health, spawn_external


class Launcher(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Spotibai · Setup & start")
        self.geometry("760x740")
        self.minsize(660, 670)
        self.configure(background="#f4f1e9")
        self.messages = queue.Queue()
        self.controller = DesktopController(log=lambda value: self.messages.put(("log", value)))
        self.busy = False
        self.requirements_ready = False
        self.base_python = None
        self._build()
        self.protocol("WM_DELETE_WINDOW", self.close)
        self.after(100, self._drain)
        self.after(250, self.check)

    def _build(self):
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("TFrame", background="#f4f1e9")
        style.configure("TLabel", background="#f4f1e9", foreground="#18201f", font=("Segoe UI", 10))
        style.configure("Title.TLabel", font=("Segoe UI", 26, "bold"))
        style.configure("Step.TLabel", font=("Segoe UI", 12, "bold"))
        style.configure("Muted.TLabel", foreground="#68716d")
        style.configure("TButton", font=("Segoe UI", 10), padding=(12, 8))
        style.configure("Start.TButton", background="#d9f36b", foreground="#18201f")
        main = ttk.Frame(self, padding=26)
        main.pack(fill="both", expand=True)
        ttk.Label(main, text="Spotibai", style="Title.TLabel").pack(anchor="w")
        ttk.Label(main, text="A few easy steps. Your music stays on this computer.", style="Muted.TLabel").pack(anchor="w", pady=(2, 20))
        self.python_label = self._step(main, "1   Check Python", "Looking for a compatible Python installation...")
        self.python_button = ttk.Button(main, text="Install Python 3.13", command=self.install_python)
        self.requirements_label = self._step(main, "2   Install app requirements", "The installer prepares the app, audio tools, and stem separation packages.")
        ttk.Label(main, text="First installation needs internet and may take several minutes.", style="Muted.TLabel").pack(anchor="w")
        self.install_button = ttk.Button(main, text="Install or repair requirements", command=self.install)
        self.install_button.pack(anchor="w", pady=(9, 17))
        self.server_label = self._step(main, "3   Start your local app", "Start the app, then your browser will open automatically.")
        buttons = ttk.Frame(main)
        buttons.pack(fill="x", pady=(8, 8))
        self.start_button = ttk.Button(buttons, text="Start app", style="Start.TButton", command=self.start)
        self.start_button.pack(side="left")
        self.open_button = ttk.Button(buttons, text="Open app", command=lambda: webbrowser.open(self.controller.url))
        self.open_button.pack(side="left", padx=9)
        self.stop_button = ttk.Button(buttons, text="Stop app", command=self.stop)
        self.stop_button.pack(side="left")
        self.status = ttk.Label(main, text="Checking setup...", wraplength=690, style="Muted.TLabel")
        self.status.pack(anchor="w", pady=(8, 6))
        self.progress = ttk.Progressbar(main, mode="indeterminate")
        self.progress.pack(fill="x", pady=(0, 8))
        self.check_button = ttk.Button(main, text="Check again", command=self.check)
        self.check_button.pack(anchor="w", pady=(0, 8))
        self.details_button = ttk.Button(main, text="Show setup details", command=self.toggle_details)
        self.details_button.pack(anchor="w")
        self.details = scrolledtext.ScrolledText(main, height=7, font=("Consolas", 9), wrap="word", state="disabled")
        self._sync()

    @staticmethod
    def _step(parent, title, description):
        ttk.Label(parent, text=title, style="Step.TLabel").pack(anchor="w", pady=(8, 5))
        label = ttk.Label(parent, text=description, wraplength=690)
        label.pack(anchor="w", pady=(0, 5))
        return label

    def _sync(self):
        owned = self.controller.server and self.controller.server.poll() is None
        running = bool(owned or self.controller.external)
        for button in (self.check_button, self.install_button, self.start_button, self.python_button):
            button.configure(state="disabled" if self.busy else "normal")
        if not self.base_python or running:
            self.install_button.configure(state="disabled")
        if not self.requirements_ready or running:
            self.start_button.configure(state="disabled")
        self.open_button.configure(state="normal" if running else "disabled")
        self.stop_button.configure(state="normal" if owned and not self.busy else "disabled")

    def _task(self, text, function, callback):
        if self.busy:
            return
        self.busy = True
        self.status.configure(text=text)
        self.progress.start(14)
        self._sync()

        def work():
            try:
                self.messages.put(("done", (callback, function(), None)))
            except Exception as exc:
                self.messages.put(("done", (callback, None, str(exc))))
        threading.Thread(target=work, daemon=True).start()

    def _drain(self):
        while not self.messages.empty():
            kind, value = self.messages.get_nowait()
            if kind == "log":
                self.details.configure(state="normal")
                self.details.insert("end", value + "\n")
                if int(self.details.index("end-1c").split(".")[0]) > 500:
                    self.details.delete("1.0", "100.0")
                self.details.see("end")
                self.details.configure(state="disabled")
            elif kind == "done":
                callback, result, error = value
                self.busy = False
                self.progress.stop()
                if error:
                    self.status.configure(text=error)
                    messagebox.showerror("Spotibai", error, parent=self)
                else:
                    callback(result)
                self._sync()
        self.after(100, self._drain)

    def check(self):
        def work():
            executable, info = find_python()
            ready, message = check_requirements()
            return executable, info, ready, message, health(self.controller.port or 5000)

        def done(result):
            executable, info, ready, message, running = result
            self.base_python = info["base"] if info else None
            self.python_label.configure(text=f"Ready · Python {'.'.join(map(str, info['version']))}" if info else f"Required: {SUPPORTED}.")
            if info:
                self.python_button.pack_forget()
            else:
                self.python_button.pack(after=self.python_label, anchor="w", pady=6)
            self.requirements_ready = ready
            self.requirements_label.configure(text=message)
            if running:
                self.controller.port = self.controller.port or 5000
                if not self.controller.server or self.controller.server.poll() is not None:
                    self.controller.external = True
                self.server_label.configure(text=f"Running at {self.controller.url}" + (" · Started outside this window" if self.controller.external else ""))
            else:
                self.controller.external = False
                self.server_label.configure(text="Ready to start locally." if ready else "Complete steps 1 and 2 first.")
            self.status.configure(text="Setup ready. Click Start app." if ready and not running else "App running. Click Open app." if running else "Install or repair requirements to continue.")
        self._task("Checking Python, requirements, and local server...", work, done)

    def install_python(self):
        if os.name == "nt":
            spawn_external(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ROOT / "launch.ps1"), "-InstallPythonOnly"], creationflags=NO_WINDOW)
            self.status.configure(text="Complete Python installation in the setup window, then click Check again.")
        else:
            webbrowser.open("https://www.python.org/downloads/")

    def install(self):
        if self.base_python:
            self._task("Installing requirements. Keep this window open; this may take several minutes...",
                       lambda: self.controller.install(self.base_python), lambda _: self.check())

    def start(self):
        def done(url):
            self.server_label.configure(text=f"Running at {url}")
            self.status.configure(text="App running. You can return here to stop it.")
            webbrowser.open(url)
        self._task("Starting the local app...", self.controller.start, done)

    def stop(self):
        if messagebox.askyesno("Stop Spotibai?", "This stops ongoing conversions and stem preparation. Stop the app?", parent=self):
            def done(_):
                self.server_label.configure(text="App stopped. Your saved Library is kept.")
                self.status.configure(text="Click Start app whenever you're ready.")
            self._task("Stopping the local app...", self.controller.stop, done)

    def toggle_details(self):
        if self.details.winfo_manager():
            self.details.pack_forget()
            self.details_button.configure(text="Show setup details")
        else:
            self.details.pack(fill="both", expand=True, pady=(7, 0))
            self.details_button.configure(text="Hide setup details")

    def close(self):
        if self.busy:
            messagebox.showinfo("Setup in progress", "Wait for the current setup step to finish before closing this window.", parent=self)
            return
        if self.controller.server and self.controller.server.poll() is None:
            choice = messagebox.askyesnocancel("Close Spotibai", "Stop the local app and close?\n\nYes: stop ongoing work and close.\nNo: keep the app running and minimize this window.", parent=self)
            if choice is None:
                return
            if not choice:
                self.iconify()
                return
            self.controller.stop()
        self.destroy()


def diagnose(output, check_server=False):
    """Optional support check: no downloads or installation, and no user music is touched."""
    report = {"frozen": bool(getattr(sys, "frozen", False)), "root": str(ROOT), "ok": False}
    controller = None
    try:
        missing = [name for name in ("app.py", "requirements.txt", "setup.ps1", "launch.ps1",
            "conversion_engine.py", "stem_readiness.py", "templates/index.html", "templates/library.html", "static/library.js")
            if not (ROOT / name).is_file()]
        if missing:
            raise RuntimeError("App files missing: " + ", ".join(missing))
        window = tk.Tk()
        window.withdraw()
        window.update_idletasks()
        window.destroy()
        report["desktop_ui"] = True
        executable, info = find_python()
        report["python"] = {"executable": str(executable), **info} if info else None
        report["requirements_ready"], report["requirements_message"] = check_requirements()
        if check_server:
            from pathlib import Path
            with tempfile.TemporaryDirectory(prefix="spotibai-exe-check-") as folder:
                with socket.socket() as probe:
                    probe.bind(("127.0.0.1", 0))
                    port = probe.getsockname()[1]
                controller = DesktopController()
                try:
                    controller.start(port, extra_env={"CONVOTIFY_LIBRARY_DIR": folder, "CONVOTIFY_JOBS_DIR": folder,
                        "CONVOTIFY_READINESS_FILE": str(Path(folder) / "readiness.json")})
                    report["server"] = health(controller.port)
                finally:
                    controller.stop()
                report["server_stopped"] = health(port) is None
                if not report["server_stopped"]:
                    raise RuntimeError("The diagnostic server did not stop.")
        report["ok"] = True
    except Exception as exc:
        report["error"] = str(exc)
    from pathlib import Path
    Path(output).write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Spotibai desktop setup")
    parser.add_argument("--diagnose", metavar="REPORT.json", help="Write a setup diagnostic report without installing anything")
    parser.add_argument("--check-server", action="store_true", help="Also start and stop an isolated diagnostic server")
    options = parser.parse_args()
    if options.diagnose:
        raise SystemExit(diagnose(options.diagnose, options.check_server))
    Launcher().mainloop()
