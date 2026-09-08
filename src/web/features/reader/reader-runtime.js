(() => {
  document.documentElement.classList.add("reader-enhanced");

  const readerRoot = document.querySelector("[data-reader-mode]");
  const previewUpdatedAt = Number(
    readerRoot instanceof HTMLElement
      ? readerRoot.dataset.previewUpdatedAt
      : Number.NaN,
  );
  const previewBuildId =
    readerRoot instanceof HTMLElement
      ? readerRoot.dataset.previewBuildId
      : null;
  const currentPageId = Number(
    readerRoot instanceof HTMLElement
      ? readerRoot.dataset.readerPageId
      : Number.NaN,
  );
  const previewMode =
    readerRoot instanceof HTMLElement &&
    readerRoot.dataset.readerMode === "preview" &&
    Number.isSafeInteger(previewUpdatedAt) &&
    previewUpdatedAt >= 0 &&
    typeof previewBuildId === "string" &&
    /^ver_[A-Za-z0-9_-]{16,80}$/u.test(previewBuildId) &&
    Number.isSafeInteger(currentPageId) &&
    currentPageId > 0;

  const previewMessage = (type, extra = {}) => {
    if (!previewMode || window.parent === window) return;
    window.parent.postMessage(
      {
        type,
        source_updated_at: previewUpdatedAt,
        build_id: previewBuildId,
        page_id: currentPageId,
        ...extra,
      },
      "*",
    );
  };

  const fragment = () => {
    if (!window.location.hash) return null;
    try {
      return decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return null;
    }
  };

  const restoreFocus = new WeakMap();
  const closeDrawer = (dialog) => {
    if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
  };
  for (const trigger of document.querySelectorAll(
    "[data-reader-drawer-trigger]",
  )) {
    if (!(trigger instanceof HTMLButtonElement)) continue;
    const dialog = document.getElementById(
      trigger.getAttribute("aria-controls") || "",
    );
    if (!(dialog instanceof HTMLDialogElement)) continue;
    trigger.addEventListener("click", () => {
      restoreFocus.set(dialog, trigger);
      trigger.setAttribute("aria-expanded", "true");
      dialog.showModal();
    });
    dialog.addEventListener("close", () => {
      trigger.setAttribute("aria-expanded", "false");
      restoreFocus.get(dialog)?.focus({ preventScroll: true });
    });
  }
  const breakpoint = window.matchMedia("(min-width: 56.001rem)");
  const closeAtDesktop = () => {
    if (!breakpoint.matches) return;
    for (const dialog of document.querySelectorAll("[data-reader-drawer]")) {
      closeDrawer(dialog);
    }
  };
  breakpoint.addEventListener("change", closeAtDesktop);
  closeAtDesktop();

  const focusHashTarget = () => {
    const blockId = fragment();
    if (!blockId) return;
    const target = document.getElementById(blockId);
    if (!(target instanceof HTMLElement)) return;
    if (target.tabIndex < 0) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  };
  window.addEventListener("hashchange", focusHashTarget);
  if (window.location.hash) requestAnimationFrame(focusHashTarget);

  const outlineLinks = Array.from(
    document.querySelectorAll("a[data-outline-link]"),
  );
  const outlineIds = Array.from(
    new Set(
      outlineLinks
        .map((link) => link.getAttribute("data-outline-link"))
        .filter(Boolean),
    ),
  );
  const setOutlineLocation = (blockId) => {
    for (const link of outlineLinks) {
      if (link.getAttribute("data-outline-link") === blockId) {
        link.setAttribute("aria-current", "location");
      } else {
        link.removeAttribute("aria-current");
      }
    }
  };
  let outlineScheduled = false;
  const updateOutlineLocation = () => {
    outlineScheduled = false;
    if (outlineIds.length === 0) {
      previewMessage("mirawind-preview-location", { fragment: fragment() });
      return;
    }
    const topbar = document.querySelector(".reader-topbar");
    const threshold =
      (topbar instanceof HTMLElement
        ? topbar.getBoundingClientRect().height
        : 64) + 24;
    let activeId = outlineIds[0];
    const hashId = fragment() || "";
    for (const blockId of outlineIds) {
      const heading = document.getElementById(blockId);
      if (!(heading instanceof HTMLElement)) continue;
      if (heading.getBoundingClientRect().top <= threshold) activeId = blockId;
      else break;
    }
    if (hashId && outlineIds.includes(hashId)) {
      const hashHeading = document.getElementById(hashId);
      if (
        hashHeading instanceof HTMLElement &&
        hashHeading.getBoundingClientRect().top > threshold
      ) {
        activeId = hashId;
      }
    }
    setOutlineLocation(activeId);
    previewMessage("mirawind-preview-location", { fragment: activeId });
  };
  const scheduleOutlineLocation = () => {
    if (outlineScheduled) return;
    outlineScheduled = true;
    requestAnimationFrame(updateOutlineLocation);
  };
  window.addEventListener("hashchange", scheduleOutlineLocation);
  window.addEventListener("resize", scheduleOutlineLocation);
  window.addEventListener("scroll", scheduleOutlineLocation, { passive: true });
  scheduleOutlineLocation();

  const mermaidFrames = document.querySelectorAll("[data-mermaid-diagram]");
  if (mermaidFrames.length > 0) {
    const moduleUrl =
      readerRoot instanceof HTMLElement
        ? readerRoot.dataset.readerMermaidScript
        : undefined;
    if (moduleUrl) {
      import(moduleUrl)
        .then(({ renderMermaidDiagrams }) => renderMermaidDiagrams(document))
        .catch(() => {
          for (const frame of mermaidFrames) {
            if (!(frame instanceof HTMLElement)) continue;
            frame.dataset.mermaidState = "failed";
            const status = frame.querySelector("[data-mermaid-status]");
            if (status instanceof HTMLElement) {
              status.textContent = "图表无法渲染，已保留源码。";
            }
          }
        });
    }
  }

  const fallbackCopy = (value) => {
    const buffer = document.createElement("textarea");
    buffer.className = "visually-hidden";
    buffer.readOnly = true;
    buffer.value = value;
    document.body.append(buffer);
    try {
      buffer.select();
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      buffer.remove();
    }
  };
  const copyCode = async (value) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
      return fallbackCopy(value);
    } catch {
      return fallbackCopy(value);
    }
  };
  for (const button of document.querySelectorAll("[data-copy-code]")) {
    if (!(button instanceof HTMLButtonElement)) continue;
    button.addEventListener("click", async () => {
      const frame = button.closest(".code-frame");
      const code = frame?.querySelector("pre code");
      if (!(code instanceof HTMLElement)) return;
      const value = code.textContent || "";
      const copied = await copyCode(value);
      button.focus({ preventScroll: true });
      if (!copied) {
        button.dataset.copyState = "failed";
        button.textContent = "重试复制";
        button.setAttribute("aria-label", "复制失败，重试复制代码");
        return;
      }
      button.dataset.copyState = "complete";
      button.textContent = "已复制";
      button.setAttribute("aria-label", "代码已复制");
      window.setTimeout(() => {
        delete button.dataset.copyState;
        button.textContent = "复制";
        button.setAttribute("aria-label", "复制代码");
      }, 1_600);
    });
  }

  document.addEventListener("click", (event) => {
    if (
      !previewMode ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    const origin = event.target instanceof Element ? event.target : null;
    if (
      !origin ||
      origin.closest(
        "a, button, input, select, textarea, summary, [data-reader-interactive]",
      )
    ) {
      return;
    }
    const block =
      origin.closest("table")?.closest("[data-block-id]") ??
      origin.closest("[data-block-id]");
    if (!(block instanceof HTMLElement) || /^H[1-4]$/u.test(block.tagName)) {
      return;
    }
    const blockId = block.dataset.blockId || "";
    if (!/^blk_[A-Za-z0-9_-]{16,80}$/u.test(blockId)) return;
    previewMessage("mirawind-preview-select-block", {
      block_id: blockId,
      fragment: blockId,
    });
  });

  document.addEventListener("click", (event) => {
    if (
      !previewMode ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    const target =
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(target instanceof HTMLAnchorElement)) return;
    const url = new URL(target.href, window.location.href);
    const match = url.pathname.match(
      /^\/api\/manage\/books\/[1-9]\d*\/preview\/(ver_[A-Za-z0-9_-]{16,80})\/pages\/([1-9]\d*)$/u,
    );
    if (match && match[1] === previewBuildId) {
      event.preventDefault();
      previewMessage("mirawind-preview-navigate", {
        fragment: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
        page_id: Number(match[2]),
      });
      return;
    }
    if (
      url.origin === window.location.origin &&
      url.pathname === window.location.pathname &&
      url.search === window.location.search &&
      url.hash
    ) {
      return;
    }
    event.preventDefault();
  });

  document.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (document.querySelector("dialog[open]")) return;
    const path = event.composedPath();
    if (
      path.some((item) => {
        if (!(item instanceof HTMLElement)) return false;
        const tag = item.tagName;
        return (
          [
            "A",
            "BUTTON",
            "INPUT",
            "SELECT",
            "TEXTAREA",
            "SUMMARY",
            "DETAILS",
            "CODE",
            "PRE",
          ].includes(tag) ||
          item.isContentEditable ||
          item.hasAttribute("role") ||
          item.tabIndex >= 0 ||
          item.hasAttribute("data-reader-interactive")
        );
      })
    ) {
      return;
    }
    const selector =
      event.key === "ArrowLeft" ? "a[rel='prev']" : "a[rel='next']";
    const href = document.querySelector(selector)?.getAttribute("href");
    if (!href) return;
    event.preventDefault();
    const link = new URL(href, window.location.href);
    if (previewMode) {
      const match = link.pathname.match(/\/pages\/([1-9]\d*)$/u);
      if (!match) return;
      previewMessage("mirawind-preview-navigate", {
        fragment: link.hash ? decodeURIComponent(link.hash.slice(1)) : null,
        page_id: Number(match[1]),
      });
      return;
    }
    window.location.assign(link);
  });

  for (const container of document.querySelectorAll(
    "[data-book-search-container]",
  )) {
    if (
      !(container instanceof HTMLElement) ||
      container.dataset.searchInitialized === "true"
    ) {
      continue;
    }
    const form = container.querySelector("[data-book-search]");
    const output = container.querySelector("[data-search-results]");
    const notice = container.querySelector("[data-search-notice]");
    if (
      !(form instanceof HTMLFormElement) ||
      !(output instanceof HTMLOListElement) ||
      !(notice instanceof HTMLElement)
    ) {
      continue;
    }
    container.dataset.searchInitialized = "true";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const query = new FormData(form).get("q");
      if (typeof query !== "string" || !query.trim()) return;
      output.replaceChildren();
      notice.textContent = "正在搜索…";
      try {
        const endpoint = new URL(
          form.dataset.endpoint || "",
          window.location.origin,
        );
        endpoint.searchParams.set("q", query);
        const response = await fetch(endpoint, {
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error("SEARCH_FAILED");
        const payload = await response.json();
        notice.textContent =
          payload.notice || (payload.results.length ? "" : "没有匹配结果。");
        for (const result of payload.results) {
          const item = document.createElement("li");
          const link = document.createElement("a");
          const snippet = document.createElement("p");
          link.href = String(result.href);
          link.textContent = String(result.title);
          snippet.textContent = String(result.snippet);
          item.append(link, snippet);
          output.append(item);
        }
      } catch {
        notice.textContent = "搜索暂时不可用，请稍后重试。";
      }
    });
  }

  previewMessage("mirawind-preview-ready", { fragment: fragment() });
})();
