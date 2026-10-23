# ![pastedown icon](pastedown/assets/icon32.png) pastedown

Paste rich text as Markdown. Ctrl+Shift+V pastes italics, links, lists, code, and tables as Markdown instead of dropping them; Ctrl+V pastes as usual.

pastedown does the Right Thing whenever possible:

- Keeps `text/plain` when it says more than the HTML (e.g. code from VS Code)
- Hands pages a normal paste event, so editors' own paste handling still runs
- Reads the clipboard only on Ctrl+Shift+V, since browsers strip that paste's HTML
- No escapes in visible text, no dependencies, no build step: it's one content script
- Works in Chrome and Firefox, even on pages enforcing Trusted Types
- No network access, no tracking

No Web Store, sorry. Clone/download, Extensions > Load Unpacked.
