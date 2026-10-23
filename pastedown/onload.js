// Writers of text/plain disagree on line layout (Chromium puts one line break after
// a heading, Firefox two and indents lists and quotes), so only what's on each line
// has to match.
const lines = text => text.replace(/\s*\n\s*/g, "\n").trim();

// The Markdown, if it says more than text/plain and text/plain is just the HTML's
// text as Chromium or Firefox writes it, else text/plain. Whichever browser pastes,
// the copy could have come from either, or from an app built on one.
function convert(html, plain) {
  const { body } = new DOMParser().parseFromString(html, "text/html");
  const text = lines(plain);

  // Chromium marks a copy that starts or ends at a line break, which isn't text.
  for (const br of body.querySelectorAll("br.Apple-interchange-newline")) {
    br.remove();
  }

  const markdown = render(body, "markdown");

  // Both write a no-break space as a space.
  const same = rendering => lines(rendering.replaceAll("\u00a0", " ")) === text;

  return !same(markdown) && (same(render(body, "chromium")) || same(render(body, "firefox"))) ? markdown : plain;
}

function paste(target, text) {
  const data = new DataTransfer();
  data.setData("text/plain", text);

  // Chrome takes clipboardData, Firefox only the older dataType/data pair.
  const event = new ClipboardEvent("paste", { clipboardData: data, dataType: "text/plain", data: text, bubbles: true, cancelable: true, composed: true });

  // Browsers do nothing with an untrusted paste, so if no handler took it, type it.
  if (target.dispatchEvent(event)) {
    document.execCommand("insertText", false, text);
  }
}

// Ctrl+Shift+V pastes plain text, which becomes Markdown when the clipboard has
// some. Browsers leave text/html out of that paste, so cancel it and read the
// clipboard instead, except where reading it fails: insecure pages have no
// navigator.clipboard, and Chromium won't let cross-origin frames read unless their
// embedder allows it.
addEventListener("keydown", event => {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() != "v"
    || !navigator.clipboard || document.featurePolicy?.allowsFeature("clipboard-read") === false) {
    return;
  }

  event.preventDefault();
  const target = event.composedPath()[0];

  navigator.clipboard.read().then(async items => {
    const read = type => items.find(item => item.types.includes(type))?.getType(type).then(blob => blob.text()) ?? "";
    const [html, plain] = await Promise.all([read("text/html"), read("text/plain")]);
    let text = plain;

    // A converter bug shouldn't cost the paste.
    try {
      text = html ? convert(html, plain) : plain;
    } catch (error) {
      console.warn("pastedown:", error);
    }

    if (text) {
      paste(target, text);
    }
  }).catch(error => console.warn("pastedown:", error));
}, true);

// HTML to Markdown, or to the plain text a browser would write for it. Adapted
// from Turndown 7.2.4 and turndown-plugin-gfm 1.0.2 by Dom Christie, and
// collapse-whitespace by Luc Thevenard.

// Only elements that Markdown renderers (cmark-gfm, markdown-it, marked, micromark)
// emit get handled. Anything else is an inline container, so HTML that isn't
// rendered Markdown, like lines of <div>s, doesn't match its text/plain.
const BLOCKS = new Set(["blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "section", "table", "tbody", "td", "th", "thead", "tr", "ul"]);
const VOIDS = new Set(["br", "hr", "img", "input"]);
const KEPT_WHEN_BLANK = new Set(["td", "th"]);
const TABLES = new Set(["table", "tbody", "td", "th", "thead", "tr"]);

const isBlock = node => BLOCKS.has(node.localName);
const isVoid = node => VOIDS.has(node.localName);

const isBlank = node => !isVoid(node) && !KEPT_WHEN_BLANK.has(node.localName) && !node.textContent.trim()
  && ![...VOIDS, ...KEPT_WHEN_BLANK].some(name => node.getElementsByTagName(name).length);

// From collapse-whitespace: whitespace collapsed as a browser renders it,
// everywhere but inside <pre>, with spaces trimmed where breaks(node).
function collapseWhitespace(root, breaks) {
  let prevText = null;
  let keepLeadingSpace = false;
  let prev = null;
  let node = next(prev, root);

  while (node !== root) {
    if (node.nodeType === Node.TEXT_NODE) {
      let text = node.data.replace(/[ \r\n\t]+/g, " ");

      if ((!prevText || prevText.data.endsWith(" ")) && !keepLeadingSpace && text.startsWith(" ")) {
        text = text.slice(1);
      }

      if (!text) {
        node = remove(node);
        continue;
      }

      node.data = text;
      prevText = node;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (breaks(node) || node.localName === "br") {
        if (prevText) {
          prevText.data = prevText.data.replace(/ $/, "");
        }

        prevText = null;
        keepLeadingSpace = false;
      } else if (isVoid(node)) {
        prevText = null;
        keepLeadingSpace = true;
      } else if (prevText) {
        keepLeadingSpace = false;
      }
    } else {
      node = remove(node);
      continue;
    }

    const following = next(prev, node);
    prev = node;
    node = following;
  }

  if (prevText) {
    prevText.data = prevText.data.replace(/ $/, "");

    if (!prevText.data) {
      remove(prevText);
    }
  }
}

function remove(node) {
  const following = node.nextSibling ?? node.parentNode;
  node.remove();
  return following;
}

// Depth first, skipping what's inside <pre>.
function next(prev, node) {
  return prev?.parentNode === node || node.localName === "pre"
    ? node.nextSibling ?? node.parentNode
    : node.firstChild ?? node.nextSibling ?? node.parentNode;
}

// A loop, since /\n+$/ backtracks badly on long text.
function trimTrailingNewlines(text) {
  let end = text.length;

  while (text[end - 1] === "\n") {
    end--;
  }

  return text.slice(0, end);
}

const trimNewlines = text => trimTrailingNewlines(text.replace(/^\n+/, ""));

// Blocks ask for up to two newlines on each side, and neighbors share them. The
// parts are joined only at the end, since reading the end of a string built up with
// + copies all of it.
function contents(node, markdown) {
  const parts = [];
  let newlines = 0;

  for (const child of node.childNodes) {
    const addition = child.nodeType === Node.TEXT_NODE ? child.data
      : child.nodeType === Node.ELEMENT_NODE ? element(child, markdown) : "";
    const after = addition.replace(/^\n+/, "");
    const part = trimTrailingNewlines(after);

    if (part) {
      parts.push("\n\n".slice(0, Math.max(newlines, addition.length - after.length)), part);
      newlines = after.length - part.length;
    } else {
      newlines = Math.max(newlines, addition.length);
    }
  }

  return parts.join("") + "\n\n".slice(0, newlines);
}

function element(node, markdown) {
  const [leading, trailing] = isBlock(node) ? ["", ""] : flanking(node);

  // Blank, but maybe a space, like the <span> </span> Chromium copies between tags.
  if (isBlank(node)) {
    return isBlock(node) ? "\n\n" : leading + trailing;
  }

  // Code is literal: markup inside it isn't Markdown.
  let content = markdown && node.localName === "code" ? literal(node) : contents(node, markdown);

  if (leading || trailing) {
    content = content.trim();
  }

  return leading + (markdown ? toMarkdown(node, content) : toText(node, content)) + trailing;
}

// An inline element's edge whitespace goes outside its markup, unless the text
// beside it already has some.
function flanking(node) {
  const [, leading, leadingAscii, leadingOther, trailing, trailingOther, trailingAscii] =
    /^(([ \t\r\n]*)(\s*))(?:(?=\S)[\s\S]*\S)?((\s*?)([ \t\r\n]*))$/.exec(node.textContent);

  return [
    leadingAscii && spaced(node.previousSibling, / $/) ? leadingOther : leading,
    trailingAscii && spaced(node.nextSibling, /^ /) ? trailingOther : trailing,
  ];
}

const spaced = (sibling, edge) => sibling?.nodeType === Node.TEXT_NODE ? edge.test(sibling.data)
  : sibling?.nodeType === Node.ELEMENT_NODE && !isBlock(sibling) && edge.test(sibling.textContent);

function toText(node, content) {
  switch (node.localName) {
    case "br":
      return "\n";
    case "img":
      return node.getAttribute("alt") ?? "";
    case "td":
    case "th":
      return (node.previousElementSibling ? "\t" : "") + content;
    case "tr":
      return `\n${content}\n`;
    default:
      return isBlock(node) ? `\n\n${content}\n\n` : content;
  }
}

function toMarkdown(node, content) {
  const href = node.getAttribute("href");

  switch (node.localName) {
    // A backslash break, after a space so a \ before it can't escape it. Headings
    // and table cells are one line, and a break can't end a block.
    case "br":
      return node.closest("h1, h2, h3, h4, h5, h6, td, th") ? " " : continues(node) ? " \\\n" : "";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `\n\n${"#".repeat(Number(node.localName[1]))} ${content}\n\n`;
    case "blockquote":
      return `\n\n${trimNewlines(content).replace(/^/gm, "> ")}\n\n`;
    case "ul":
    case "ol":
      return node.parentNode.localName === "li" && node.parentNode.lastElementChild === node ? `\n${content}` : `\n\n${content}\n\n`;
    case "li":
      return listItem(node, content);
    case "pre":
      return codeBlock(node);
    case "hr":
      return "\n\n---\n\n";
    case "a":
      return !href || sameUrl(node.textContent, href) ? content : `[${content}](${destination(href)})`;
    case "em":
      return content.trim() ? `*${content}*` : "";
    case "strong":
      return content.trim() ? `**${content}**` : "";
    case "del":
    case "s":
      return `~~${content}~~`;
    case "code":
      return inlineCode(content);
    case "img":
      return node.getAttribute("src") ? `![${altText(node.getAttribute("alt") ?? "")}](${destination(node.getAttribute("src"))})` : "";
    // GFM tables have to start with a header, so the first row is it. A | in a cell
    // would end the cell, so it's the one thing that gets a backslash. A cell spanning
    // columns ends in MultiMarkdown's extra |s, which GFM reads as empty cells.
    case "td":
    case "th":
      return `${node.previousElementSibling ? "" : "|"} ${content.trim().replace(/\s*\n\s*/g, " ").replaceAll("|", "\\|")} |${"|".repeat(node.colSpan - 1)}`;
    case "tr":
      return `\n${content}${node === node.closest("table")?.rows[0] ? `\n|${" --- |".repeat([...node.cells].reduce((columns, cell) => columns + cell.colSpan, 0))}` : ""}`;
    case "thead":
    case "tbody":
      return content;
    default:
      return isBlock(node) ? `\n\n${content}\n\n` : content;
  }
}

const sameUrl = (a, b) => {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
};

// Escapes don't show in a link's destination or an image's alt, so those get what
// they need to come through as is: a ) would end a destination, and alt is Markdown.
const destination = url => url.replace(/[\\()]/g, "\\$&").replace(/\s/g, encodeURIComponent);
const altText = text => text.replace(/\s+/g, " ").replace(/[!-/:-@[-`{-~]/g, "\\$&");

// Whether inline content follows node before its block ends.
function continues(node) {
  for (; node && !isBlock(node); node = node.parentNode) {
    for (let next = node.nextSibling; next; next = next.nextSibling) {
      if (isBlock(next)) {
        return false;
      }

      if (next.textContent.trim() || next.localName === "img" || next.querySelector?.("img")) {
        return true;
      }
    }
  }

  return false;
}

function listItem(node, content) {
  const list = node.parentNode;
  const marker = list.localName === "ol" ? `${Number(list.getAttribute("start") || 1) + [...list.children].indexOf(node)}. ` : "- ";
  const loose = content.endsWith("\n");

  // Renderers put a task's box at the start of its item, before or inside its <p>.
  const box = node.querySelector("input[type=checkbox]");
  const task = box?.closest("li") === node ? `[${box.checked ? "x" : " "}] ` : "";

  content = task + trimNewlines(content).trimStart() + (loose ? "\n" : "");
  return marker + content.replace(/\n(?=[^\n])/g, `\n${" ".repeat(marker.length)}`) + (node.nextSibling ? "\n" : "");
}

// Every <pre> gets a fence, with the language from a language-* class or from
// GitHub's highlight-source-* wrapper.
function codeBlock(node) {
  const code = node.querySelector("code") ?? node;
  const match = /language-(\S+)|highlight-(?:text|source)-([a-z0-9]+)/.exec(`${code.className} ${node.className} ${node.parentNode.className}`);
  const text = literal(code).replace(/\n$/, "");
  const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/^`{3,}/gm), run => run[0].length + 1)));

  return `\n\n${fence}${match?.[1] ?? match?.[2] ?? ""}\n${text}\n${fence}\n\n`;
}

// Code's text, with the <br>s some highlighters (Docusaurus's) end its lines with.
function literal(node) {
  node = node.cloneNode(true);

  for (const br of node.querySelectorAll("br")) {
    br.replaceWith("\n");
  }

  return node.textContent;
}

function inlineCode(content) {
  if (!content) {
    return "";
  }

  content = content.replace(/\r?\n|\r/g, " ");
  const padding = /^`|^ .*?[^ ].* $|`$/.test(content) ? " " : "";
  const runs = content.match(/`+/g) ?? [];
  let delimiter = "`";

  while (runs.includes(delimiter)) {
    delimiter += "`";
  }

  return delimiter + padding + content + padding + delimiter;
}

// Nothing marks a rowspan in Markdown, so each row a cell spans down into gets an
// empty cell in its place, keeping the cells after it in their columns.
function padRowspans(table) {
  const rows = [...table.rows];
  const covered = rows.map(() => new Set());

  for (const [r, row] of rows.entries()) {
    for (let i = 0, column = 0; i < row.cells.length || covered[r].has(column); i++) {
      if (covered[r].has(column)) {
        row.insertCell(i);
        column++;
        continue;
      }

      const cell = row.cells[i];

      for (let below = r + 1; below < Math.min(r + cell.rowSpan, rows.length); below++) {
        for (let c = column; c < column + cell.colSpan; c++) {
          covered[below].add(c);
        }
      }

      column += cell.colSpan;
    }
  }
}

// As "markdown", or as the text/plain "chromium" or "firefox" writes. Chromium
// writes what layout shows, keeping a space on each side of an image. Firefox
// writes from the DOM, collapsing spaces through images, which it writes as their
// alt, and through table cells.
function render(root, mode) {
  root = root.cloneNode(true);

  if (mode === "firefox") {
    for (const img of root.querySelectorAll("img")) {
      img.replaceWith(img.alt);
    }
  }

  if (mode === "markdown") {
    for (const table of root.querySelectorAll("table")) {
      padRowspans(table);
    }
  }

  if (root.firstChild) {
    collapseWhitespace(root, mode === "firefox" ? node => isBlock(node) && !TABLES.has(node.localName) : isBlock);
  }

  return contents(root, mode === "markdown").trim();
}
