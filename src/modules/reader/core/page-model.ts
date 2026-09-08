import type { ReaderTocLink } from "./navigation";

export interface ReaderOutlineLink {
  readonly blockId: string;
  readonly href: string;
  readonly level: number;
  readonly title: string;
}

export interface ReaderPageModel {
  readonly bodyHtml: string;
  readonly bookKey: string;
  readonly bookTitle: string;
  readonly currentTocHeadingId: string | null;
  readonly currentPageId: number;
  readonly firstPageHref: string;
  readonly mode?: "preview" | "published";
  readonly nextHref: string | null;
  readonly originalDownloads: readonly {
    readonly href: string;
    readonly label: string;
  }[];
  readonly outline: readonly ReaderOutlineLink[];
  readonly pageOwnerHeadingId: string | null;
  readonly previousHref: string | null;
  readonly previewUpdatedAt?: number;
  readonly previewBuildId?: string;
  readonly toc: readonly ReaderTocLink[];
}
