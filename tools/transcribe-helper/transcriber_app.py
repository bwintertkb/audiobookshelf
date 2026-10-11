"""ABS Transcriber: create read-along transcripts for the books on your Audiobookshelf server on this computer's GPU.

Sign in, pick books without a transcript, and the app downloads each book's audio, transcribes it with
faster-whisper on the GPU, uploads the transcript to the server and deletes the downloaded audio.
"Add EPUB…" uploads an EPUB from this computer to a book and makes its transcript from the ebook's text, so the
narration is highlighted in the book in the ebook reader.

Start it with "ABS Transcriber.bat" (no console window) or: .venv\\Scripts\\python transcriber_app.py
Settings (server address, user name, options; never the password) are kept in app-settings.json next to this file.
"""

import json
import logging
import queue
import sys
import threading
import time
import tkinter as tk
from logging.handlers import RotatingFileHandler
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

HERE = Path(__file__).resolve().parent
SETTINGS_PATH = HERE / "app-settings.json"
DEFAULT_SERVER = "http://192.168.0.240:13378"
STATUS_TEXT = {
    "waiting": "Waiting",
    "preparing": "Starting",
    "downloading": "Downloading audio",
    "queued": "Waiting for the GPU",
    "transcribing": "Transcribing",
    "aligning": "Matching the ebook text",
    "uploading": "Uploading",
    "done": "Done",
    "error": "Failed",
    "upload_failed": "Upload failed",
    "cancelled": "Cancelled",
}

logger = logging.getLogger("transcriber_app")


def status_text(task):
    if task.status == "queued" and task.stage == "preparing":
        return "Preparing the audio"
    if task.status == "transcribing" and task.stage == "starting":
        return "Starting transcription"
    return STATUS_TEXT.get(task.status, task.status)


def duration_text(seconds):
    seconds = int(seconds or 0)
    hours, rest = divmod(seconds, 3600)
    return f"{hours} h {rest // 60:02d} min" if hours else f"{rest // 60} min"


def load_settings():
    try:
        return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_settings(settings):
    try:
        SETTINGS_PATH.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    except OSError as error:
        logger.warning("Could not save settings: %s", error)


class TranscriberWindow:
    def __init__(self, root, controller):
        self.root = root
        self.controller = controller
        self.settings = load_settings()
        self.results = queue.Queue()  # (callback, value) from background threads
        self.busy = False
        self.book_rows = {}  # tree item id -> Book
        self.task_rows = {}  # id(task) -> tree item id
        self.shown_messages = 0

        root.title("ABS Transcriber")
        root.geometry(self.settings.get("geometry") or "1100x760")
        root.minsize(820, 560)
        root.protocol("WM_DELETE_WINDOW", self.close)
        style = ttk.Style(root)
        if "vista" in style.theme_names():
            style.theme_use("vista")
        style.configure("Treeview", rowheight=24)

        self._build_server(root)
        self._build_books(root)
        self._build_queue(root)
        self._build_status(root)
        self.set_signed_in(False)
        self.root.after(200, self.tick)
        if self.settings.get("username"):
            self.password.focus_set()

    # ------------------------------------------------------------------ layout
    def _build_server(self, root):
        frame = ttk.LabelFrame(root, text="Audiobookshelf server", padding=8)
        frame.pack(fill="x", padx=10, pady=(10, 4))
        self.server = tk.StringVar(value=self.settings.get("server") or DEFAULT_SERVER)
        self.username = tk.StringVar(value=self.settings.get("username") or "")
        self.password_var = tk.StringVar()
        ttk.Label(frame, text="Address").grid(row=0, column=0, sticky="w")
        self.server_entry = ttk.Entry(frame, textvariable=self.server, width=38)
        self.server_entry.grid(row=0, column=1, padx=(4, 12), sticky="we")
        ttk.Label(frame, text="User").grid(row=0, column=2, sticky="w")
        self.username_entry = ttk.Entry(frame, textvariable=self.username, width=16)
        self.username_entry.grid(row=0, column=3, padx=(4, 12))
        ttk.Label(frame, text="Password").grid(row=0, column=4, sticky="w")
        self.password = ttk.Entry(frame, textvariable=self.password_var, show="•", width=16)
        self.password.grid(row=0, column=5, padx=(4, 12))
        self.password.bind("<Return>", lambda e: self.sign_in())
        self.sign_in_button = ttk.Button(frame, text="Sign in", command=self.sign_in)
        self.sign_in_button.grid(row=0, column=6)
        self.sign_out_button = ttk.Button(frame, text="Sign out", command=self.sign_out)
        self.sign_out_button.grid(row=0, column=7, padx=(6, 0))
        self.server_status = ttk.Label(frame, text="", foreground="#555")
        self.server_status.grid(row=1, column=0, columnspan=8, sticky="w", pady=(6, 0))
        frame.columnconfigure(1, weight=1)

    def _build_books(self, root):
        frame = ttk.LabelFrame(root, text="Books", padding=8)
        frame.pack(fill="both", expand=True, padx=10, pady=4)
        bar = ttk.Frame(frame)
        bar.pack(fill="x")
        ttk.Label(bar, text="Search").pack(side="left")
        self.search = tk.StringVar()
        self.search.trace_add("write", lambda *a: self.show_books())
        ttk.Entry(bar, textvariable=self.search, width=30).pack(side="left", padx=(4, 12))
        self.only_missing = tk.BooleanVar(value=self.settings.get("onlyMissing", True))
        ttk.Checkbutton(bar, text="Only books without a transcript", variable=self.only_missing, command=self.show_books).pack(side="left")
        self.refresh_button = ttk.Button(bar, text="Refresh", command=self.load_books)
        self.refresh_button.pack(side="right")
        self.book_count = ttk.Label(bar, text="", foreground="#555")
        self.book_count.pack(side="right", padx=10)

        columns = ("author", "length", "ebook", "transcript")
        tree_frame = ttk.Frame(frame)
        tree_frame.pack(fill="both", expand=True, pady=6)
        self.books_tree = ttk.Treeview(tree_frame, columns=columns, selectmode="extended")
        self.books_tree.heading("#0", text="Title")
        self.books_tree.column("#0", width=380)
        for column, title, width, anchor in (("author", "Author", 200, "w"), ("length", "Length", 100, "e"), ("ebook", "Ebook", 70, "center"), ("transcript", "Transcript", 90, "center")):
            self.books_tree.heading(column, text=title)
            self.books_tree.column(column, width=width, anchor=anchor, stretch=column == "author")
        scroll = ttk.Scrollbar(tree_frame, orient="vertical", command=self.books_tree.yview)
        self.books_tree.configure(yscrollcommand=scroll.set)
        self.books_tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        self.books_tree.bind("<Double-1>", lambda e: self.transcribe_selected())
        self.books_tree.bind("<<TreeviewSelect>>", lambda e: self.update_buttons())

        options = ttk.Frame(frame)
        options.pack(fill="x")
        self.use_ebook = tk.BooleanVar(value=self.settings.get("useEbook", True))
        ttk.Checkbutton(options, text="Use the ebook's text when the book has an EPUB (read-along in the ebook reader)", variable=self.use_ebook).pack(side="left")
        self.transcribe_button = ttk.Button(options, text="Transcribe selected", command=self.transcribe_selected)
        self.transcribe_button.pack(side="right")
        self.add_ebook_button = ttk.Button(options, text="Add EPUB…", command=self.add_ebook)
        self.add_ebook_button.pack(side="right", padx=(0, 6))
        from transcribe_helper.languages import WHISPER_LANGUAGES

        self.languages = [("book", "Book's language (else detect)"), ("detect", "Detect from the audio")] + sorted(WHISPER_LANGUAGES.items(), key=lambda item: item[1])
        self.language = ttk.Combobox(options, state="readonly", width=28, values=[name for _, name in self.languages])
        self.language.current(0)
        self.language.pack(side="right", padx=(4, 12))
        ttk.Label(options, text="Language").pack(side="right")

    def _build_queue(self, root):
        frame = ttk.LabelFrame(root, text="Transcription queue", padding=8)
        frame.pack(fill="x", padx=10, pady=4)
        columns = ("status", "progress", "speed", "remaining", "details")
        self.queue_tree = ttk.Treeview(frame, columns=columns, height=5, selectmode="browse")
        self.queue_tree.heading("#0", text="Book")
        self.queue_tree.column("#0", width=280)
        for column, title, width in (("status", "Status", 150), ("progress", "Progress", 80), ("speed", "Speed", 90), ("remaining", "Remaining", 90), ("details", "Details", 330)):
            self.queue_tree.heading(column, text=title)
            self.queue_tree.column(column, width=width, stretch=column == "details")
        self.queue_tree.pack(fill="x")
        self.queue_tree.bind("<<TreeviewSelect>>", lambda e: self.update_buttons())
        bar = ttk.Frame(frame)
        bar.pack(fill="x", pady=(6, 0))
        self.progress = ttk.Progressbar(bar, mode="determinate", maximum=1000)
        self.progress.pack(side="left", fill="x", expand=True, padx=(0, 12))
        self.clear_button = ttk.Button(bar, text="Clear finished", command=self.clear_finished)
        self.clear_button.pack(side="right")
        self.retry_button = ttk.Button(bar, text="Retry", command=self.retry_selected)
        self.retry_button.pack(side="right", padx=6)
        self.cancel_button = ttk.Button(bar, text="Cancel", command=self.cancel_selected)
        self.cancel_button.pack(side="right")

    def _build_status(self, root):
        frame = ttk.Frame(root, padding=(10, 0, 10, 8))
        frame.pack(fill="x")
        self.log = tk.Text(frame, height=5, wrap="word", state="disabled", relief="flat", background=root.cget("background"), font=("Segoe UI", 9))
        self.log.pack(fill="x")
        self.gpu_status = ttk.Label(frame, text="", foreground="#555")
        self.gpu_status.pack(anchor="w", pady=(4, 0))

    # ------------------------------------------------------------------ background work
    def run_in_background(self, work, on_done, label):
        if self.busy:
            return
        self.busy = True
        self.server_status.configure(text=label)
        self.update_buttons()

        def runner():
            try:
                self.results.put((on_done, work(), None))
            except Exception as error:  # reported in the window
                self.results.put((on_done, None, error))

        threading.Thread(target=runner, daemon=True).start()

    def tick(self):
        while not self.results.empty():
            on_done, value, error = self.results.get()
            self.busy = False
            on_done(value, error)
            self.update_buttons()
        self.show_tasks()
        self.show_messages()
        self.show_gpu()
        self.root.after(500, self.tick)

    # ------------------------------------------------------------------ server
    def sign_in(self):
        server, username, password = self.server.get().strip(), self.username.get().strip(), self.password_var.get()
        if not server or not username:
            messagebox.showwarning("ABS Transcriber", "Enter the server address and your user name.")
            return

        def done(user, error):
            if error:
                self.server_status.configure(text=f"Sign-in failed: {error}")
                return
            self.password_var.set("")  # not kept in the window either
            self.settings.update(server=self.controller.client.base_url, username=username)
            save_settings(self.settings)
            self.server.set(self.controller.client.base_url)
            self.set_signed_in(True)
            self.load_books()

        self.run_in_background(lambda: self.controller.sign_in(server, username, password), done, f"Signing in to {server}…")

    def sign_out(self):
        if any(t.status in ("preparing", "downloading") for t in self.controller.tasks):
            if not messagebox.askyesno("ABS Transcriber", "Audio is being downloaded. Sign out anyway? Books still waiting in the queue start when you sign in again."):
                return
        self.controller.sign_out()
        self.set_signed_in(False)
        self.books_tree.delete(*self.books_tree.get_children())
        self.book_rows.clear()
        self.book_count.configure(text="")

    def set_signed_in(self, signed_in):
        self.signed_in = signed_in
        for widget in (self.server_entry, self.username_entry, self.password):
            widget.configure(state="disabled" if signed_in else "normal")
        if signed_in:
            client = self.controller.client
            self.server_status.configure(text=f"Signed in to {client.base_url} as {client.user.get('username')}")
        elif not self.busy:
            self.server_status.configure(text="Sign in to list the books on your server.")
        self.update_buttons()

    def load_books(self):
        def done(books, error):
            if error:
                self.server_status.configure(text=f"Could not load the books: {error}")
                return
            self.set_signed_in(True)
            self.show_books()

        self.run_in_background(self.controller.load_books, done, "Loading the books…")

    # ------------------------------------------------------------------ books
    def show_books(self):
        selected = {self.book_rows[i].id for i in self.books_tree.selection() if i in self.book_rows}
        self.books_tree.delete(*self.books_tree.get_children())
        self.book_rows.clear()
        query = self.search.get().strip().lower()
        books = self.controller.books
        shown = 0
        for book in books:
            if self.only_missing.get() and book.has_transcript:
                continue
            if query and query not in book.title.lower() and query not in book.author.lower():
                continue
            row = self.books_tree.insert("", "end", text=book.title, values=(book.author, duration_text(book.duration), book.ebook_format.upper() or "–", "Yes" if book.has_transcript else "–"))
            self.book_rows[row] = book
            if book.id in selected:
                self.books_tree.selection_add(row)
            shown += 1
        missing = sum(1 for b in books if not b.has_transcript)
        self.book_count.configure(text=f"{shown} shown · {len(books)} books, {missing} without a transcript")
        self.settings["onlyMissing"] = self.only_missing.get()
        save_settings(self.settings)

    def transcribe_selected(self):
        books = [self.book_rows[i] for i in self.books_tree.selection() if i in self.book_rows]
        if not books or not self.signed_in:
            return
        replacing = [b for b in books if b.has_transcript]
        if replacing and not messagebox.askyesno("ABS Transcriber", f"{len(replacing)} of the selected books already have a transcript. Replace it?"):
            return
        language = self.languages[self.language.current()][0]
        added = [book for book in books if self.controller.add(book, use_ebook=self.use_ebook.get(), language=language)]
        self.settings["useEbook"] = self.use_ebook.get()
        save_settings(self.settings)
        if len(added) < len(books):
            self.server_status.configure(text=f"{len(books) - len(added)} of the selected books are already in the queue")

    def add_ebook(self):
        """Upload an EPUB from this computer to the selected book, then transcribe the book with the EPUB's text"""
        books = [self.book_rows[i] for i in self.books_tree.selection() if i in self.book_rows]
        if len(books) != 1 or not self.signed_in or self.busy:
            return
        book = books[0]
        if book.has_epub:
            messagebox.showinfo("ABS Transcriber", f"'{book.title}' already has an EPUB. Use \"Transcribe selected\" to make its transcript from the ebook's text.")
            return
        path = filedialog.askopenfilename(parent=self.root, title=f"Choose the EPUB of '{book.title}'", filetypes=[("EPUB ebooks", "*.epub")], initialdir=self.settings.get("ebookDir") or None)
        if not path:
            return
        path = Path(path)
        self.settings["ebookDir"] = str(path.parent)
        save_settings(self.settings)
        language = self.languages[self.language.current()][0]

        def uploaded(task, error):
            self.set_signed_in(True)
            if error:
                self.server_status.configure(text=f"Adding the EPUB failed: {error}")
                messagebox.showerror("ABS Transcriber", f"Adding {path.name} to '{book.title}' failed:\n\n{error}")
                return
            self.server_status.configure(text=f"Added {path.name} to '{book.title}'" + ("; its transcript is in the queue" if task else ""))
            self.show_books()

        def inspected(info, error):
            self.set_signed_in(True)
            if error:
                messagebox.showerror("ABS Transcriber", str(error))
                return
            lines = [f"Add {path.name} to '{book.title}' on the server?", "", f"EPUB title: {info['title'] or '(none)'}", f"{info['words']:,} words"]
            if not info["titleMatches"]:
                lines += ["", "The EPUB's title is not like the book's. Check it is the same book: its text has to match the narration."]
            if book.ebook_format:
                lines += ["", f"The EPUB becomes the main ebook; the book's {book.ebook_format.upper()} stays as an extra ebook."]
            lines += ["", "Then the transcript is made from the EPUB's text, for read-along in the ebook reader" + (" (it replaces the current transcript)." if book.has_transcript else ".")]
            if not messagebox.askyesno("ABS Transcriber", "\n".join(lines), icon="question" if info["titleMatches"] else "warning"):
                return
            self.run_in_background(lambda: self.controller.add_ebook(book, path, language=language), uploaded, f"Uploading {path.name}…")

        self.run_in_background(lambda: self.controller.inspect_ebook(book, path), inspected, f"Reading {path.name}…")

    # ------------------------------------------------------------------ queue
    def selected_task(self):
        selection = self.queue_tree.selection()
        if not selection:
            return None
        return next((t for t in self.controller.tasks if self.task_rows.get(id(t)) == selection[0]), None)

    def cancel_selected(self):
        task = self.selected_task()
        if task and messagebox.askyesno("ABS Transcriber", f"Cancel '{task.book.title}'?"):
            self.controller.cancel(task)

    def retry_selected(self):
        task = self.selected_task()
        if task:
            self.controller.retry(task)

    def clear_finished(self):
        self.controller.clear_finished()

    def show_tasks(self):
        tasks = list(self.controller.tasks)
        live = set()
        for task in tasks:
            key = id(task)
            live.add(key)
            status = status_text(task)
            if task.status == "downloading":
                progress = f"{task.download_progress * 100:.0f}%"
            elif task.status == "queued" and task.stage_progress is not None:
                progress = f"{task.stage_progress * 100:.0f}%"
            elif task.status in ("transcribing", "aligning", "uploading", "done"):
                progress = f"{task.progress * 100:.0f}%"
            else:
                progress = ""
            speed = f"{task.speed:.0f}x real time" if task.speed and task.status == "transcribing" else ""
            remaining = duration_text(task.eta_sec) if task.eta_sec and task.status == "transcribing" else ""
            details = task.error or task.message or ("ebook text" if task.mode == "ebook" else "speech") + f" · {duration_text(task.book.duration)}"
            values = (status, progress, speed, remaining, details)
            if key in self.task_rows and self.queue_tree.exists(self.task_rows[key]):
                self.queue_tree.item(self.task_rows[key], values=values)
            else:
                self.task_rows[key] = self.queue_tree.insert("", "end", text=task.book.title, values=values)
        for key in [k for k in self.task_rows if k not in live]:
            if self.queue_tree.exists(self.task_rows[key]):
                self.queue_tree.delete(self.task_rows[key])
            del self.task_rows[key]
        current = (
            next((t for t in tasks if t.status in ("transcribing", "aligning")), None)
            or next((t for t in tasks if t.status == "queued" and t.stage_progress is not None), None)
            or next((t for t in tasks if t.status == "downloading"), None)
        )
        if current:
            value = {"downloading": current.download_progress, "queued": current.stage_progress}.get(current.status, current.progress)
            self.progress.configure(value=(value or 0) * 1000)
        else:
            self.progress.configure(value=0)
        # Books whose transcript was just uploaded leave the "without a transcript" list
        if self.signed_in and any(t.status == "done" and not getattr(t, "_shown_done", False) for t in tasks):
            for t in tasks:
                if t.status == "done":
                    t._shown_done = True
            self.show_books()
        self.update_buttons()

    def show_messages(self):
        messages = list(self.controller.messages)
        if len(messages) == self.shown_messages:
            return
        self.shown_messages = len(messages)
        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        for at, text in messages[-40:]:
            self.log.insert("end", f"{time.strftime('%H:%M:%S', time.localtime(at))}  {text}\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def show_gpu(self):
        status = self.controller.model_status
        gpu = status["gpu"] or {}
        name = gpu.get("name") or ("no CUDA GPU" if not gpu.get("available") else "GPU")
        state = {"loading": "loading the speech model…", "ready": "speech model ready", "error": f"speech model failed: {status['error']}", "not_loaded": "speech model not loaded"}.get(status["state"], status["state"])
        self.gpu_status.configure(text=f"{name} · {status['model']} · {state}")

    def update_buttons(self):
        signed_in = getattr(self, "signed_in", False)
        self.sign_in_button.configure(state="disabled" if signed_in or self.busy else "normal")
        self.sign_out_button.configure(state="normal" if signed_in and not self.busy else "disabled")
        self.refresh_button.configure(state="normal" if signed_in and not self.busy else "disabled")
        self.transcribe_button.configure(state="normal" if signed_in and self.books_tree.selection() else "disabled")
        self.add_ebook_button.configure(state="normal" if signed_in and not self.busy and len(self.books_tree.selection()) == 1 else "disabled")
        task = self.selected_task()
        self.cancel_button.configure(state="normal" if task and task.status in ("waiting", "preparing", "downloading", "queued", "transcribing", "aligning") else "disabled")
        self.retry_button.configure(state="normal" if task and task.status in ("error", "upload_failed", "cancelled") and signed_in else "disabled")
        self.clear_button.configure(state="normal" if any(t.status in ("done", "cancelled") for t in self.controller.tasks) else "disabled")

    def close(self):
        active = [t for t in self.controller.tasks if t.status in ("waiting", "preparing", "downloading", "queued", "transcribing", "aligning", "uploading")]
        if active and not messagebox.askyesno("ABS Transcriber", f"{len(active)} book(s) are still in the queue. Quit and stop them? Files that were finished are kept and skipped next time."):
            return
        self.settings["geometry"] = self.root.geometry()
        save_settings(self.settings)
        self.server_status.configure(text="Stopping…")
        self.root.update_idletasks()
        self.controller.stop()
        self.root.destroy()


def create_controller():
    from transcribe_helper.app_controller import TranscriberController
    from transcribe_helper.config import load_config
    from transcribe_helper.gpu import get_gpu_info
    from transcribe_helper.transcriber import Transcriber, audio_preparer

    config = load_config()
    # Separate from the helper service's cache: the app deletes leftover downloads when it starts
    config.cache_dir = str(Path(config.cache_dir) / "app")
    gpu_info = {"available": False, "error": "CPU mode", "name": "CPU"} if config.device == "cpu" else get_gpu_info()

    def transcriber_factory(model_name):
        if config.device == "cuda" and not gpu_info.get("available"):
            raise RuntimeError(gpu_info.get("error") or "CUDA is not available")
        return Transcriber(model_name, device=config.device, compute_type=config.effective_compute_type, download_root=config.model_dir or None, batch_size=config.batch_size)

    return TranscriberController(config, transcriber_factory, gpu_info=gpu_info, audio_preparer=audio_preparer(config.batch_size))


def setup_logging():
    log_dir = HERE / "cache"
    log_dir.mkdir(exist_ok=True)
    handler = RotatingFileHandler(log_dir / "transcriber-app.log", maxBytes=2_000_000, backupCount=2, encoding="utf-8")
    handlers = [handler] + ([logging.StreamHandler()] if sys.stderr else [])
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", handlers=handlers)


def main():
    setup_logging()
    try:
        import truststore  # verify HTTPS with the Windows certificate store

        truststore.inject_into_ssl()
    except ImportError:
        pass
    if sys.platform == "win32":
        try:
            import ctypes

            ctypes.windll.shcore.SetProcessDpiAwareness(1)  # sharp text on high-DPI screens
        except (AttributeError, OSError):
            pass
    root = tk.Tk()
    controller = create_controller()
    controller.start()

    def report_error(exc_type, exc, tb):
        logger.error("Unexpected error", exc_info=(exc_type, exc, tb))
        messagebox.showerror("ABS Transcriber", f"Unexpected error: {exc}")

    root.report_callback_exception = report_error
    window = TranscriberWindow(root, controller)
    window.root.mainloop()


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    main()
