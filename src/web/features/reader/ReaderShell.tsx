import { BookSearch } from "./BookSearch";
import {
  readerBreadcrumbs,
  type ReaderOutlineLink,
  type ReaderPageModel,
} from "@/modules/reader/application/reader-api";
import { TableOfContents } from "./TableOfContents";
import { readerMermaidScriptUrl, readerScriptUrl } from "@/styles/assets";

function PageOutline(props: {
  readonly currentHeadingId: string | null;
  readonly outline: readonly ReaderOutlineLink[];
  readonly showHeading?: boolean;
}) {
  const baseLevel =
    props.outline.length > 0
      ? Math.min(...props.outline.map((heading) => heading.level))
      : 1;
  return (
    <nav aria-label="本页提纲" className="reader-outline">
      {props.showHeading !== false && <h2>本页提纲</h2>}
      <ol>
        {props.outline.map((heading) => (
          <li
            key={heading.blockId}
            style={{
              marginInlineStart: `${Math.max(0, heading.level - baseLevel) * 0.7}rem`,
            }}
          >
            <a
              aria-current={
                heading.blockId === props.currentHeadingId
                  ? "location"
                  : undefined
              }
              data-outline-link={heading.blockId}
              href={heading.href}
            >
              {heading.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function ReaderShell(props: ReaderPageModel) {
  const breadcrumbs = readerBreadcrumbs(props.toc, props.currentTocHeadingId);
  const published = props.mode !== "preview";
  const readerMain = (
    <main
      className={published ? "reader-main" : "reader-main reader-preview-main"}
      id="main-content"
      style={
        published
          ? undefined
          : {
              margin: "0 auto",
              maxWidth: "52rem",
              padding: "0.75rem 1.5rem 2.5rem",
            }
      }
    >
      <article
        className="reader-document"
        dangerouslySetInnerHTML={{ __html: props.bodyHtml }}
      />
      <nav aria-label="翻页" className="reader-page-nav">
        {props.previousHref ? (
          <a href={props.previousHref} rel="prev">
            ← 上一页
          </a>
        ) : (
          <span />
        )}
        {props.nextHref ? (
          <a href={props.nextHref} rel="next">
            下一页 →
          </a>
        ) : (
          <span />
        )}
      </nav>
    </main>
  );
  if (!published) {
    return (
      <>
        <a className="reader-skip-link" href="#main-content">
          跳到正文
        </a>
        <div
          className="reader-preview-root"
          data-preview-updated-at={props.previewUpdatedAt}
          data-preview-build-id={props.previewBuildId}
          data-reader-mermaid-script={readerMermaidScriptUrl}
          data-reader-mode="preview"
          data-reader-page-id={props.currentPageId}
          data-reader-page-owner={props.pageOwnerHeadingId ?? undefined}
          style={{ minHeight: "100vh" }}
        >
          {readerMain}
        </div>
        <script defer src={readerScriptUrl} />
      </>
    );
  }
  return (
    <>
      <a className="reader-skip-link" href="#main-content">
        跳到正文
      </a>
      <header
        className="reader-topbar"
        data-reader-mermaid-script={readerMermaidScriptUrl}
        data-reader-mode="published"
        data-reader-page-id={props.currentPageId}
        data-reader-page-owner={props.pageOwnerHeadingId ?? undefined}
      >
        <a className="reader-library-link" href="/library">
          返回书库
        </a>
        <nav aria-label="当前位置" className="reader-breadcrumb">
          <a className="reader-book-title" href={props.firstPageHref}>
            {props.bookTitle}
          </a>
          {breadcrumbs.map((crumb, index) => (
            <span className="reader-breadcrumb-part" key={crumb.blockId}>
              <span aria-hidden="true" className="reader-breadcrumb-separator">
                ›
              </span>
              <a
                aria-current={
                  index === breadcrumbs.length - 1 ? "location" : undefined
                }
                href={crumb.href}
              >
                {crumb.title}
              </a>
            </span>
          ))}
        </nav>
        <div className="reader-desktop-tools">
          <BookSearch bookKey={props.bookKey} />
          {props.originalDownloads.map((download) => (
            <a download href={download.href} key={download.href} rel="nofollow">
              {download.label}
            </a>
          ))}
        </div>
      </header>
      <nav aria-label="阅读工具" className="reader-mobile-actions">
        {[
          ["reader-mobile-toc", "目录"],
          ["reader-mobile-outline", "本文"],
          ["reader-mobile-search", "搜索"],
          ["reader-mobile-downloads", "下载"],
        ].map(([id, label]) => (
          <button
            aria-controls={id}
            aria-expanded="false"
            data-reader-drawer-trigger
            key={id}
            type="button"
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="reader-layout">
        <TableOfContents
          currentHeadingId={props.currentTocHeadingId}
          currentPageId={props.currentPageId}
          toc={props.toc}
        />
        {readerMain}
        <PageOutline
          currentHeadingId={props.pageOwnerHeadingId}
          outline={props.outline}
        />
      </div>
      <dialog
        aria-labelledby="reader-mobile-toc-heading"
        data-reader-drawer
        id="reader-mobile-toc"
      >
        <div className="reader-drawer-heading">
          <h2 id="reader-mobile-toc-heading">目录</h2>
          <form method="dialog">
            <button type="submit">关闭</button>
          </form>
        </div>
        <TableOfContents
          currentHeadingId={props.currentTocHeadingId}
          currentPageId={props.currentPageId}
          showHeading={false}
          toc={props.toc}
        />
      </dialog>
      <dialog
        aria-labelledby="reader-mobile-outline-heading"
        data-reader-drawer
        id="reader-mobile-outline"
      >
        <div className="reader-drawer-heading">
          <h2 id="reader-mobile-outline-heading">本文</h2>
          <form method="dialog">
            <button type="submit">关闭</button>
          </form>
        </div>
        <PageOutline
          currentHeadingId={props.pageOwnerHeadingId}
          outline={props.outline}
          showHeading={false}
        />
      </dialog>
      <dialog
        aria-labelledby="reader-mobile-search-heading"
        data-reader-drawer
        id="reader-mobile-search"
      >
        <div className="reader-drawer-heading">
          <h2 id="reader-mobile-search-heading">搜索</h2>
          <form method="dialog">
            <button type="submit">关闭</button>
          </form>
        </div>
        <BookSearch bookKey={props.bookKey} />
      </dialog>
      <dialog
        aria-labelledby="reader-mobile-downloads-heading"
        data-reader-drawer
        id="reader-mobile-downloads"
      >
        <div className="reader-drawer-heading">
          <h2 id="reader-mobile-downloads-heading">下载</h2>
          <form method="dialog">
            <button type="submit">关闭</button>
          </form>
        </div>
        {props.originalDownloads.length > 0 ? (
          <ul>
            {props.originalDownloads.map((download) => (
              <li key={download.href}>
                <a download href={download.href} rel="nofollow">
                  {download.label}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p>暂无下载</p>
        )}
      </dialog>
      <script defer src={readerScriptUrl} />
    </>
  );
}
