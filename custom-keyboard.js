/**
 * ================================================================
 *  custom-keyboard.js
 *  Standalone custom on-screen keyboard for the chat message box.
 *  - Fully self-contained: injects its own CSS + DOM.
 *  - Connects to index.html purely by element IDs (#msgInput,
 *    #inputBar, #main) — no changes needed inside index.html's own
 *    <script> block. Just include this file with a <script> tag.
 *  - Colors are picked up from index.html's CSS variables
 *    (--accent, --glass-bg-strong, --glass-border, --text-light,
 *    --font) with sensible fallbacks, since custom properties are
 *    global to the whole document.
 *  - A toggle button lets the user switch back to the phone's own
 *    (native) keyboard at any time. Preference is remembered.
 *  - No emoji anywhere — every key/icon is a clean inline SVG.
 *
 *  WHY `disabled` INSTEAD OF `readonly` (cross-browser fix):
 *  A `readOnly` + `inputmode="none"` combo to block the native
 *  keyboard is NOT reliable everywhere — Samsung Internet, MIUI's
 *  browser, and several Android keyboard apps ignore `inputmode`
 *  and pop the native keyboard up anyway. `disabled` is respected
 *  by every browser: a disabled field can never receive focus, so
 *  there's no path left for any keyboard to appear.
 *
 *  WHY A SEPARATE "DISPLAY" LAYER (mid-text editing + visible cursor):
 *  Disabled inputs don't reliably expose selectionStart/setSelectionRange
 *  across browsers, so we can't ask the real <input> where the cursor
 *  is. Instead, while custom mode is on we hide the real input and show
 *  a plain div in its place that renders the same text with a visible
 *  blinking caret. Cursor position is tracked as a plain JS integer
 *  (`cursorPos`), and tapping anywhere in that div moves the caret to
 *  the tapped character using `caretRangeFromPoint` /
 *  `caretPositionFromPoint` (both are read-only "where would the text
 *  cursor land here" browser APIs — they don't require focusing or
 *  editing anything, so they work fine alongside a disabled input).
 *  Every key press still updates the real (hidden) `#msgInput.value`
 *  and fires an `input` event, so the rest of the app (typing
 *  indicator, send logic, etc.) keeps working completely unchanged.
 *
 *  MOBILE FIX NOTES (this revision):
 *   1. #ckDisplay was `display:flex` with no wrapping, so on longer
 *      text the three inner spans (before/caret/after) overflowed the
 *      box horizontally instead of wrapping like real text — pushing
 *      the caret out of view. Fixed with `flex-wrap: wrap`.
 *   2. The caret was never rendered at all when the input was empty
 *      (an early `return` skipped straight past the caret markup),
 *      so on a fresh/empty message box there was simply no cursor to
 *      see. Fixed: caret now always renders, with the placeholder
 *      text following it (like a real focused empty input).
 *   3. The caret span itself could "steal" a tap (since it's a real,
 *      hit-testable element sitting between the before/after spans),
 *      which made caretRangeFromPoint resolve to nothing useful and
 *      fall back to a crude left-half/right-half guess — this is why
 *      tapping mid-word to position the cursor felt random. Fixed by
 *      giving the caret `pointer-events: none`, so taps always land on
 *      the actual text spans underneath and resolve to an exact
 *      character offset.
 * ================================================================
 */
(function () {
  "use strict";

  const STORAGE_KEY = "chatKeyboardMode"; // "custom" | "native"

  // ---- Icons (all inline SVG, no emoji) ----
  const KEY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12"/></svg>';
  const BACKSPACE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/></svg>';
  const SHIFT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 4l8 8h-5v8H9v-8H4z"/></svg>';
  const ENTER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>';
  const GLOBE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a14 14 0 0 1 3.5 9A14 14 0 0 1 12 21a14 14 0 0 1-3.5-9A14 14 0 0 1 12 3z"/></svg>';

  const LAYOUT_LETTERS_ROWS = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["{shift}", "z", "x", "c", "v", "b", "n", "m", "{backspace}"],
  ];

  const LAYOUT_NUMBERS_ROWS = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["@", "#", "₹", "&", "*", "(", ")", "-", "'"],
    ["{ABC}", "%", "+", "=", "/", ";", ":", "\"", "{backspace}"],
  ];

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #keyboardToggleBtn.active {
        background: var(--accent-soft, rgba(178,148,245,0.18));
        border-color: rgba(178,148,245,0.4);
        color: var(--accent, #b294f5);
      }

      /* The visible stand-in for #msgInput while custom mode is on.
         Sized/styled to match the real input exactly so swapping
         between them is seamless. flex-wrap is critical here: without
         it, long text pushes the caret straight out of the visible
         box instead of wrapping like real text. */
      #ckDisplay {
        display: none;
        flex: 1 1 60px;
        min-width: 60px;
        padding: 12px 16px;
        border-radius: 24px;
        border: 1px solid var(--glass-border, rgba(255,255,255,0.1));
        background: rgba(255,255,255,0.06);
        color: var(--text-light, #f5f4fb);
        font-family: var(--font, inherit);
        font-size: 16px;
        line-height: 1.3;
        white-space: pre-wrap;
        word-break: break-word;
        cursor: text;
        -webkit-user-select: none;
        user-select: none;
        touch-action: manipulation;
      }
      #ckDisplay.show {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        align-content: center;
        max-height: 40vh;
        overflow-y: auto;
      }
      #ckDisplay .ckBefore, #ckDisplay .ckAfter { white-space: pre-wrap; }
      #ckDisplay .ckPlaceholder { color: var(--text-muted, #9b9bb0); white-space: pre-wrap; }
      #ckDisplay .ckCaret {
        display: inline-block;
        width: 3px;
        min-height: 20px;
        height: 1.2em;
        background: var(--accent, #b294f5);
        margin: 0 -1px;
        vertical-align: text-bottom;
        pointer-events: none; /* let taps pass through to the real text underneath/around it */
        flex-shrink: 0;
        opacity: 1;
        /* Forces its own GPU compositing layer. On some mobile browsers
           (notably iOS Safari) a thin animated inline-block sitting
           inside a flex+backdrop-filter ancestor can silently fail to
           paint at all. This, combined with JS-driven blinking instead
           of a CSS animation (see blinkCaret() below), makes the caret
           reliably visible on every device. */
        transform: translateZ(0);
        -webkit-transform: translateZ(0);
        backface-visibility: hidden;
      }

      #customKeyboard {
        flex-shrink: 0;
        max-height: 0;
        overflow: hidden;
        background: var(--glass-bg-strong, rgba(16,16,26,0.9));
        border-top: 1px solid var(--glass-border, rgba(255,255,255,0.1));
        backdrop-filter: blur(20px);
        transition: max-height 0.22s ease;
        padding: 0 6px;
        padding-bottom: env(safe-area-inset-bottom);
      }
      #customKeyboard.open {
        max-height: 280px;
        padding-top: 8px;
      }
      #customKeyboard .ckRow {
        display: flex;
        gap: 5px;
        margin-bottom: 6px;
      }
      #customKeyboard .ckKey {
        flex: 1;
        min-width: 0;
        height: 42px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(255,255,255,0.07);
        border: 1px solid var(--glass-border, rgba(255,255,255,0.1));
        border-radius: 9px;
        color: var(--text-light, #f5f4fb);
        font-family: var(--font, inherit);
        font-size: 15px;
        font-weight: 500;
        cursor: pointer;
        user-select: none;
        touch-action: manipulation;
        transition: background 0.1s ease, transform 0.05s ease;
      }
      #customKeyboard .ckKey:active {
        background: rgba(255,255,255,0.16);
        transform: scale(0.94);
      }
      #customKeyboard .ckKey.ckWide { flex: 1.8; }
      #customKeyboard .ckKey.ckSpace { flex: 5; }
      #customKeyboard .ckKey.ckPunct { flex: 0.7; }
      #customKeyboard .ckKey.ckAccent {
        background: linear-gradient(135deg, var(--accent, #b294f5), #6d4fc9);
        color: #fff;
        border: none;
      }
      #customKeyboard .ckKey.ckActive {
        background: var(--accent-soft, rgba(178,148,245,0.28));
        color: var(--accent, #b294f5);
      }

      /* Mobile-only: make keys bigger, like a real phone keyboard.
         Laptop/desktop sizing above is untouched. */
      @media (max-width: 768px) {
        #customKeyboard.open {
          max-height: 320px;
        }
        #customKeyboard .ckRow {
          gap: 6px;
          margin-bottom: 7px;
        }
        #customKeyboard .ckKey {
          height: 50px;
          font-size: 19px;
          font-weight: 600;
          border-radius: 10px;
        }
        #customKeyboard .ckKey svg {
          width: 20px;
          height: 20px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function buildKeyboardIconButton() {
    const btn = document.createElement("button");
    btn.className = "iconBtn";
    btn.id = "keyboardToggleBtn";
    btn.type = "button";
    btn.title = "Custom keyboard on/off";
    btn.innerHTML = KEY_ICON;
    return btn;
  }

  function init() {
    const msgInput = document.getElementById("msgInput");
    const inputBar = document.getElementById("inputBar");
    const sendBtn = document.getElementById("sendBtn");
    const main = document.getElementById("main");
    if (!msgInput || !inputBar || !sendBtn || !main) return; // wrong page / not ready

    injectStyles();

    // ---- Toggle button, inserted right before the Send button ----
    const toggleBtn = buildKeyboardIconButton();
    inputBar.insertBefore(toggleBtn, sendBtn);

    // ---- Visible display (stand-in for msgInput, shows caret) ----
    const display = document.createElement("div");
    display.id = "ckDisplay";
    inputBar.insertBefore(display, msgInput);

    // ---- Keyboard panel, inserted right after the input bar ----
    const panel = document.createElement("div");
    panel.id = "customKeyboard";
    inputBar.insertAdjacentElement("afterend", panel);

    let mode = "native"; // default: phone's own keyboard
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "custom" || saved === "native") mode = saved;
    } catch (e) {}

    let layer = "letters"; // "letters" | "numbers"
    let shiftOn = false;
    let cursorPos = msgInput.value.length;
    let backspaceHoldTimer = null;
    let backspaceRepeatTimer = null;
    let caretBlinkOn = true;
    let historyTrapped = false; // true while we've pushed a dummy history entry to catch the back button

    // ---- Back-button trap ----
    // While the custom keyboard panel is open, pressing the phone's
    // back button (or doing the Android back-gesture) would normally
    // navigate away from the whole chat, because our panel isn't a
    // real on-screen keyboard the browser knows how to dismiss on its
    // own. We push one extra history entry the moment the panel opens;
    // pressing back then just pops that entry (fires `popstate`) instead
    // of leaving the page, and we use that event to close the panel —
    // exactly like a native keyboard being dismissed.
    function openKeyboardPanelUI() {
      panel.classList.add("open");
      layer = "letters";
      shiftOn = false;
      renderLayer();
      setTimeout(scrollChatToBottom, 240);
      if (!historyTrapped) {
        try { history.pushState({ ckKeyboardOpen: true }, ""); } catch (e) {}
        historyTrapped = true;
      }
    }

    function closeKeyboardPanelUI(fromBackButton) {
      panel.classList.remove("open");
      stopBackspaceRepeat();
      if (historyTrapped) {
        historyTrapped = false;
        if (!fromBackButton) {
          // Panel closed some other way (toggle button, globe key) while
          // our dummy history entry is still sitting there — clean it up
          // ourselves so a real back-press later isn't wasted on it.
          try { history.back(); } catch (e) {}
        }
      }
    }

    window.addEventListener("popstate", () => {
      if (panel.classList.contains("open")) {
        closeKeyboardPanelUI(true);
      }
    });

    // JS-driven blink instead of a CSS animation. A CSS `animation` on a
    // thin inline-block sitting inside a flex + backdrop-filter ancestor
    // is exactly the kind of element some mobile browsers (iOS Safari
    // in particular) can silently fail to ever paint. Toggling opacity
    // from JS on a fixed interval sidesteps that entirely — it works
    // identically on every browser because it doesn't depend on the
    // browser's CSS animation/compositing pipeline at all.
    setInterval(() => {
      caretBlinkOn = !caretBlinkOn;
      const caretEl = display.querySelector(".ckCaret");
      if (caretEl) caretEl.style.opacity = caretBlinkOn ? "1" : "0";
    }, 530);

    function chatWindowEl() {
      return document.getElementById("chatWindow");
    }
    function scrollChatToBottom() {
      const cw = chatWindowEl();
      if (cw) cw.scrollTop = cw.scrollHeight;
    }

    // ---- Rendering the visible caret + text ----
    // Always renders the caret span, even for empty text — otherwise
    // there's simply nothing on screen to show the user where typing
    // will land.
    function renderDisplay() {
      const val = msgInput.value;
      cursorPos = Math.max(0, Math.min(cursorPos, val.length));
      const before = val.slice(0, cursorPos);
      const after = val.slice(cursorPos);
      const ph = msgInput.getAttribute("placeholder") || "";

      display.innerHTML =
        `<span class="ckBefore">${escapeHtml(before)}</span>` +
        `<span class="ckCaret"></span>` +
        `<span class="ckAfter">${escapeHtml(after)}</span>` +
        (!val && ph ? `<span class="ckPlaceholder">${escapeHtml(ph)}</span>` : "");

      // Always start each render fully visible (not mid-blink-off), so
      // typing/tapping never leaves the caret looking like it vanished.
      caretBlinkOn = true;
      const caretEl = display.querySelector(".ckCaret");
      if (caretEl) caretEl.style.opacity = "1";
    }

    function setText(newVal, newCursorPos) {
      msgInput.value = newVal;
      cursorPos = newCursorPos;
      msgInput.dispatchEvent(new Event("input", { bubbles: true }));
      renderDisplay();
    }

    function insertAtCursor(text) {
      const val = msgInput.value;
      const next = val.slice(0, cursorPos) + text + val.slice(cursorPos);
      setText(next, cursorPos + text.length);
    }

    function doBackspaceOnce() {
      if (cursorPos <= 0) return;
      const val = msgInput.value;
      const next = val.slice(0, cursorPos - 1) + val.slice(cursorPos);
      setText(next, cursorPos - 1);
    }

    function doEnter() {
      // Let the app's own keydown listener handle sending — this keeps
      // this file fully decoupled from index.html's internal JS.
      msgInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }

    // ---- Tap-to-position: find which character was tapped and move
    // the caret there. Uses the browser's own hit-testing (no manual
    // width measuring needed), works the same for taps and clicks.
    // The caret span has pointer-events:none (see CSS) specifically so
    // it never intercepts the tap itself — only the real text spans
    // (or the placeholder) can be hit. ----
    function offsetFromRange(range) {
      if (!range) return null;
      const container = range.startContainer;
      const node = container.nodeType === 3 ? container.parentNode : container;
      const beforeSpan = display.querySelector(".ckBefore");
      const afterSpan = display.querySelector(".ckAfter");
      const placeholderSpan = display.querySelector(".ckPlaceholder");

      if (beforeSpan && (node === beforeSpan || beforeSpan.contains(node))) {
        return range.startOffset;
      }
      if (afterSpan && (node === afterSpan || afterSpan.contains(node))) {
        return (beforeSpan ? beforeSpan.textContent.length : 0) + range.startOffset;
      }
      if (placeholderSpan && (node === placeholderSpan || placeholderSpan.contains(node))) {
        return 0; // empty input — only valid position is 0
      }
      return null;
    }

    function handleDisplayTap(e) {
      if (mode === "custom" && !panel.classList.contains("open")) {
        openKeyboardPanelUI();
      }
      const point = e.changedTouches ? e.changedTouches[0] : e;
      let range = null;
      if (document.caretRangeFromPoint) {
        range = document.caretRangeFromPoint(point.clientX, point.clientY);
      } else if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(point.clientX, point.clientY);
        if (pos && pos.offsetNode) {
          range = document.createRange();
          range.setStart(pos.offsetNode, pos.offset);
        }
      }
      const offset = offsetFromRange(range);
      if (offset !== null) {
        cursorPos = offset;
      } else {
        // Fallback for browsers without either API, or a tap that landed
        // in empty padding space: pick whichever end of the text is
        // visually closer to the tap, per line, using the actual
        // bounding boxes of the before/after spans instead of the whole
        // box (much more accurate on wrapped, multi-line text).
        const beforeSpan = display.querySelector(".ckBefore");
        const afterSpan = display.querySelector(".ckAfter");
        const beforeLen = beforeSpan ? beforeSpan.textContent.length : 0;
        const afterLen = afterSpan ? afterSpan.textContent.length : 0;
        const beforeRect = beforeSpan ? beforeSpan.getBoundingClientRect() : null;
        const afterRect = afterSpan ? afterSpan.getBoundingClientRect() : null;

        function dist(rect) {
          if (!rect || (rect.width === 0 && rect.height === 0)) return Infinity;
          const cx = Math.max(rect.left, Math.min(point.clientX, rect.right));
          const cy = Math.max(rect.top, Math.min(point.clientY, rect.bottom));
          return Math.hypot(point.clientX - cx, point.clientY - cy);
        }

        cursorPos = dist(beforeRect) <= dist(afterRect) ? beforeLen : beforeLen + afterLen;
      }
      renderDisplay();
    }

    display.addEventListener("click", handleDisplayTap);
    display.addEventListener("touchend", (e) => {
      handleDisplayTap(e);
      e.preventDefault();
    }, { passive: false });

    // ---- Backspace: single tap deletes one char, press-and-hold
    // repeats automatically (matches native keyboard behaviour). ----
    function stopBackspaceRepeat() {
      clearTimeout(backspaceHoldTimer);
      clearInterval(backspaceRepeatTimer);
      backspaceHoldTimer = null;
      backspaceRepeatTimer = null;
    }
    function startBackspaceRepeat() {
      doBackspaceOnce();
      stopBackspaceRepeat();
      backspaceHoldTimer = setTimeout(() => {
        backspaceRepeatTimer = setInterval(doBackspaceOnce, 90);
      }, 400);
    }

    function makeKey(className, html, onClick) {
      const key = document.createElement("div");
      key.className = `ckKey ${className || ""}`.trim();
      key.innerHTML = html;
      if (onClick) key.addEventListener("click", onClick);
      return key;
    }

    function getBottomRow() {
      // Bottom-left key toggles to whichever layer we're NOT currently on.
      const layerToggleToken = layer === "letters" ? "{123}" : "{ABC}";
      return [layerToggleToken, "{globe}", ",", "{space}", ".", "{enter}"];
    }

    function renderLayer() {
      panel.innerHTML = "";
      const rows = [...(layer === "letters" ? LAYOUT_LETTERS_ROWS : LAYOUT_NUMBERS_ROWS), getBottomRow()];

      rows.forEach((row) => {
        const rowEl = document.createElement("div");
        rowEl.className = "ckRow";
        row.forEach((token) => {
          let key;
          if (token === "{shift}") {
            key = makeKey(shiftOn ? "ckActive" : "", SHIFT_ICON, () => {
              shiftOn = !shiftOn;
              renderLayer();
            });
          } else if (token === "{backspace}") {
            key = makeKey("", BACKSPACE_ICON);
            key.addEventListener("touchstart", (e) => { startBackspaceRepeat(); e.preventDefault(); }, { passive: false });
            key.addEventListener("touchend", stopBackspaceRepeat);
            key.addEventListener("touchcancel", stopBackspaceRepeat);
            key.addEventListener("mousedown", startBackspaceRepeat);
            key.addEventListener("mouseup", stopBackspaceRepeat);
            key.addEventListener("mouseleave", stopBackspaceRepeat);
          } else if (token === "{123}") {
            key = makeKey("ckWide", "123", () => { layer = "numbers"; renderLayer(); });
          } else if (token === "{ABC}") {
            key = makeKey("ckWide", "ABC", () => { layer = "letters"; renderLayer(); });
          } else if (token === "{globe}") {
            key = makeKey("", GLOBE_ICON, () => setMode("native"));
            key.title = "Phone ka apna keyboard";
          } else if (token === "{space}") {
            key = makeKey("ckSpace", "space", () => insertAtCursor(" "));
          } else if (token === "{enter}") {
            key = makeKey("ckWide ckAccent", ENTER_ICON, doEnter);
          } else if (token === "," || token === ".") {
            key = makeKey("ckPunct", token, () => insertAtCursor(token));
          } else {
            const char = shiftOn && layer === "letters" ? token.toUpperCase() : token;
            key = makeKey("", char, () => {
              insertAtCursor(char);
              if (shiftOn) { shiftOn = false; renderLayer(); }
            });
          }
          rowEl.appendChild(key);
        });
        panel.appendChild(rowEl);
      });
    }

    function setMode(newMode) {
      mode = newMode;
      try { localStorage.setItem(STORAGE_KEY, mode); } catch (e) {}
      toggleBtn.classList.toggle("active", mode === "custom");

      if (mode === "custom") {
        // Blur first so any already-open native keyboard closes before
        // we disable the field (some browsers ignore a disabled/readonly
        // change on an element that still thinks it's focused).
        msgInput.blur();
        msgInput.disabled = true;
        msgInput.classList.add("ckInputHidden");
        msgInput.style.display = "none";
        display.classList.add("show");
        cursorPos = msgInput.value.length; // start at end, like opening a normal keyboard
        renderDisplay();
        openKeyboardPanelUI();
      } else {
        closeKeyboardPanelUI(false);
        msgInput.disabled = false;
        msgInput.style.display = "";
        display.classList.remove("show");
        // Refocus so the native keyboard pops back up immediately.
        setTimeout(() => msgInput.focus(), 30);
      }
    }

    toggleBtn.addEventListener("click", () => {
      setMode(mode === "custom" ? "native" : "custom");
    });

    setMode(mode); // apply saved/default preference on load
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();