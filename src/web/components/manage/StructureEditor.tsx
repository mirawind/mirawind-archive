import { useAutosave, useSaveIdentity } from "./use-draft-save";
import { DraftSaveFailure, readSaveResult } from "./save-result";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FilePenLine,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  manageDialog,
  manageDialogClose,
  manageDialogHeader,
  manageField,
  manageFieldLabel,
  managePanel,
  manageQuietButton,
  manageQuietText,
  manageSecondaryButton,
} from "../ui/manage-classes";

import {
  buildStructurePreview,
  changeDisplayLevel,
  mergeAcceptedNodes,
  mergeAcceptedNumbering,
  type EditableStructureNode as StructureNode,
  type HeadingNumberingMode,
} from "./structure-editor-state";
import { RichStructureTitle } from "./RichStructureTitle";

interface HeadingContext {
  readonly block_id: string;
  readonly title: string;
}

interface ContentBoundaries {
  readonly appendix_start_block_id?: string;
  readonly backmatter_start_block_id?: string;
  readonly body_start_block_id: string;
}

function withoutCollapsedDescendants<Node extends StructureNode>(
  nodes: readonly Node[],
  collapsedIds: ReadonlySet<string>,
): readonly Node[] {
  const visible: Node[] = [];
  let hiddenBelowLevel: number | null = null;
  for (const node of nodes) {
    if (hiddenBelowLevel !== null && node.display_level > hiddenBelowLevel) {
      continue;
    }
    hiddenBelowLevel = null;
    visible.push(node);
    if (collapsedIds.has(node.block_id)) {
      hiddenBelowLevel = node.display_level;
    }
  }
  return visible;
}

export interface StructureEditorHandle {
  readonly save: () => void;
}

export interface StructureEditorState {
  readonly conflict: boolean;
  readonly dirty: boolean;
  readonly saving: boolean;
}

export const StructureEditor = forwardRef<
  StructureEditorHandle,
  {
    readonly bookId: number;
    readonly boundaries: ContentBoundaries;
    readonly focusedBlockId?: string | null;
    readonly headings: readonly HeadingContext[];
    readonly mobileHidden?: boolean;
    readonly onSaved: () => Promise<void>;
    readonly onSelectHeading?: (blockId: string) => void;
    readonly onStateChange: (state: StructureEditorState) => void;
    readonly numbering: HeadingNumberingMode;
    readonly updatedAt: number;
    readonly saveDisabled?: boolean;
    readonly structure: readonly StructureNode[];
  }
>(function StructureEditor(props, ref) {
  const saveIdentity = useSaveIdentity();
  const initialNodes = props.structure;
  const [nodes, setNodes] = useState(initialNodes);
  const [boundaries, setBoundaries] = useState(props.boundaries);
  const [numbering, setNumbering] = useState(props.numbering);
  const [query, setQuery] = useState("");
  const [treeMode, setTreeMode] = useState<"all" | "toc">("toc");
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [selectedId, setSelectedId] = useState(
    initialNodes.at(0)?.block_id ?? "",
  );
  const [status, setStatus] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const onStateChange = props.onStateChange;
  const nodesRef = useRef(nodes);
  const numberingRef = useRef(numbering);
  const acceptedSnapshot = useRef<{
    readonly boundaries: ContentBoundaries;
    readonly nodes: readonly StructureNode[];
    readonly numbering: HeadingNumberingMode;
    readonly updatedAt: number | null;
  } | null>(null);
  const serverSnapshot = useRef({
    boundaries: props.boundaries,
    nodes: props.structure,
    numbering: props.numbering,
  });
  const selectedDialog = useRef<HTMLDialogElement>(null);
  const selectedDialogTrigger = useRef<HTMLButtonElement>(null);
  const lastUpdatedAt = useRef(props.updatedAt);
  nodesRef.current = nodes;
  numberingRef.current = numbering;
  const headingById = useMemo(
    () => new Map(props.headings.map((heading) => [heading.block_id, heading])),
    [props.headings],
  );
  const previewNodes = useMemo(
    () => buildStructurePreview(nodes, boundaries, numbering),
    [boundaries, nodes, numbering],
  );
  const treeNodes = useMemo(
    () =>
      treeMode === "toc"
        ? previewNodes.filter((node) => node.include_in_toc)
        : previewNodes,
    [previewNodes, treeMode],
  );
  const filteredNodes = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return treeNodes;
    return previewNodes.filter((node) => {
      const heading = headingById.get(node.block_id);
      return [
        node.title_markdown,
        node.preview_title,
        heading?.title,
        node.block_id,
      ].some((value) => value?.toLocaleLowerCase("zh-CN").includes(normalized));
    });
  }, [headingById, previewNodes, query, treeNodes]);
  const expandableIds = useMemo(
    () =>
      new Set(
        treeNodes.flatMap((node, index) =>
          (treeNodes[index + 1]?.display_level ?? 0) > node.display_level
            ? [node.block_id]
            : [],
        ),
      ),
    [treeNodes],
  );
  const visibleNodes = useMemo(
    () =>
      query.trim()
        ? filteredNodes
        : withoutCollapsedDescendants(treeNodes, collapsedIds),
    [collapsedIds, filteredNodes, query, treeNodes],
  );
  const listParent = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visibleNodes.length,
    estimateSize: () => 36,
    getScrollElement: () => listParent.current,
    overscan: 8,
  });
  const selectedIndex = nodes.findIndex((node) => node.block_id === selectedId);
  const selected = selectedIndex >= 0 ? nodes[selectedIndex] : undefined;

  useEffect(() => {
    if (saving) return;
    if (props.updatedAt === lastUpdatedAt.current) return;
    const accepted = acceptedSnapshot.current;
    const previous = accepted ?? serverSnapshot.current;
    const externalConflict = accepted
      ? props.updatedAt !== accepted.updatedAt
      : JSON.stringify(nodesRef.current) !== JSON.stringify(previous.nodes) ||
        JSON.stringify(boundaries) !== JSON.stringify(previous.boundaries) ||
        numberingRef.current !== previous.numbering;
    setNodes((current) =>
      mergeAcceptedNodes(props.structure, previous.nodes, current),
    );
    setBoundaries((current) =>
      JSON.stringify(current) === JSON.stringify(previous.boundaries)
        ? props.boundaries
        : current,
    );
    setNumbering((current) =>
      mergeAcceptedNumbering(props.numbering, previous.numbering, current),
    );
    acceptedSnapshot.current = null;
    serverSnapshot.current = {
      boundaries: props.boundaries,
      nodes: props.structure,
      numbering: props.numbering,
    };
    lastUpdatedAt.current = props.updatedAt;
    setConflict(externalConflict);
    setStatus(externalConflict ? "草稿已更新，本地修改仍保留。" : "");
  }, [
    props.boundaries,
    props.numbering,
    props.updatedAt,
    props.structure,
    saving,
    boundaries,
  ]);

  useEffect(() => {
    if (
      props.focusedBlockId &&
      nodes.some((node) => node.block_id === props.focusedBlockId)
    ) {
      setSelectedId(props.focusedBlockId);
    }
  }, [nodes, props.focusedBlockId]);

  function updateSelected(change: Partial<StructureNode>) {
    if (selectedIndex < 0) return;
    setNodes((current) =>
      current.map((node, index) =>
        index === selectedIndex ? { ...node, ...change } : node,
      ),
    );
  }

  function updateOptionalField(key: "alias" | "source_number", value: string) {
    if (!selected) return;
    const next = { ...selected };
    if (value) next[key] = value;
    else Reflect.deleteProperty(next, key);
    updateSelected(next);
  }

  function renderSelectedNode(titleId: string) {
    return (
      <>
        <h2
          className="flex min-h-12 items-center text-base font-bold"
          id={titleId}
        >
          当前结构项
        </h2>
        {!selected ? (
          <p>没有匹配的结构项。</p>
        ) : (
          <>
            {!selected.include_in_toc && (
              <p className="mt-2 flex items-center gap-2 text-sm text-stone-600">
                <EyeOff aria-hidden="true" size={16} />
                <span>不在目录中</span>
              </p>
            )}
            <label className={manageFieldLabel}>
              标题
              <input
                className={manageField}
                maxLength={2000}
                onChange={(event) =>
                  updateSelected({ title_markdown: event.currentTarget.value })
                }
                value={selected.title_markdown}
              />
            </label>
            <div
              aria-label="标题即时试排"
              className="mb-4 rounded-md border border-stone-200 bg-stone-50 p-3 text-sm"
            >
              <RichStructureTitle markdown={selected.title_markdown} />
            </div>
            <div className="structure-fields grid grid-cols-2 gap-3">
              <label className={manageFieldLabel}>
                显示层级
                <select
                  className={manageField}
                  onChange={(event) => {
                    const displayLevel = Number(event.currentTarget.value);
                    setNodes((current) =>
                      current.map((node, index) =>
                        index === selectedIndex
                          ? changeDisplayLevel(node, displayLevel)
                          : node,
                      ),
                    );
                  }}
                  value={selected.display_level}
                >
                  {[1, 2, 3, 4].map((level) => (
                    <option key={level} value={level}>
                      H{level}
                    </option>
                  ))}
                </select>
              </label>
              <label className={manageFieldLabel}>
                原书编号
                <input
                  className={manageField}
                  maxLength={100}
                  onChange={(event) =>
                    updateOptionalField(
                      "source_number",
                      event.currentTarget.value,
                    )
                  }
                  placeholder="无编号"
                  value={selected.source_number ?? ""}
                />
              </label>
            </div>
            <div className="structure-checks grid grid-cols-2 gap-3">
              <label className="col-span-2 flex items-center gap-2">
                <input
                  className="size-4 accent-emerald-700"
                  checked={selected.exclude_from_numbering}
                  onChange={(event) =>
                    updateSelected({
                      exclude_from_numbering: event.currentTarget.checked,
                    })
                  }
                  type="checkbox"
                />
                本节及子节不编号
              </label>
              <label className="flex items-center gap-2">
                <input
                  className="size-4 accent-emerald-700"
                  checked={selected.include_in_toc}
                  onChange={(event) =>
                    updateSelected({
                      include_in_toc: event.currentTarget.checked,
                    })
                  }
                  type="checkbox"
                />
                显示在目录
              </label>
              <label className="flex items-center gap-2">
                <input
                  className="size-4 accent-emerald-700"
                  checked={selected.starts_page}
                  onChange={(event) =>
                    updateSelected({
                      starts_page: event.currentTarget.checked,
                    })
                  }
                  type="checkbox"
                />
                从此标题开始新页面
              </label>
            </div>
            <fieldset className="mt-4 border-t border-stone-200 pt-3">
              <legend className="font-semibold">内容范围起点</legend>
              <div className="mt-2 grid gap-2">
                {(
                  [
                    ["body_start_block_id", "正文"],
                    ["appendix_start_block_id", "附录"],
                    ["backmatter_start_block_id", "后置内容"],
                  ] as const
                ).map(([key, label]) => {
                  const active = boundaries[key] === selected.block_id;
                  return (
                    <div
                      className="flex min-h-11 items-center justify-between gap-3"
                      key={key}
                    >
                      <span>{label}</span>
                      <button
                        aria-pressed={active}
                        className={manageQuietButton}
                        disabled={key === "body_start_block_id" && active}
                        onClick={() =>
                          setBoundaries((current) => {
                            const next: Record<string, string> = { ...current };
                            if (active && key !== "body_start_block_id") {
                              Reflect.deleteProperty(next, key);
                            } else {
                              next[key] = selected.block_id;
                            }
                            return next as unknown as ContentBoundaries;
                          })
                        }
                        type="button"
                      >
                        {active
                          ? key === "body_start_block_id"
                            ? "当前起点"
                            : "取消起点"
                          : "设为起点"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </fieldset>
          </>
        )}
      </>
    );
  }

  const dirtyChanges = nodes.flatMap((node, index) => {
    const initial = initialNodes[index];
    if (!initial || JSON.stringify(initial) === JSON.stringify(node)) return [];
    const change: Record<string, unknown> = { block_id: node.block_id };
    for (const key of [
      "include_in_toc",
      "exclude_from_numbering",
      "starts_page",
    ] as const) {
      if (node[key] !== initial[key]) change[key] = node[key];
    }
    if (node.display_level !== initial.display_level)
      change.level = node.display_level;
    if (node.title_markdown !== initial.title_markdown)
      change.markdown = node.title_markdown;
    for (const key of ["alias", "source_number"] as const) {
      if (node[key] !== initial[key]) change[key] = node[key] ?? null;
    }
    return [change];
  });
  const boundariesDirty =
    JSON.stringify(boundaries) !== JSON.stringify(props.boundaries);
  const numberingDirty = numbering !== props.numbering;
  const dirty = dirtyChanges.length > 0 || boundariesDirty || numberingDirty;

  async function save() {
    if (!dirty || saving || conflict || props.saveDisabled) return;
    setSaving(true);
    setStatus("");
    setConflict(false);
    const submittedNodes = nodesRef.current;
    const submittedNumbering = numberingRef.current;
    try {
      const response = await fetch(`/api/manage/books/${props.bookId}/draft`, {
        body: JSON.stringify({
          expected_updated_at: props.updatedAt,
          ...(boundariesDirty ? { boundaries } : {}),
          blocks: dirtyChanges,
          ...(numberingDirty ? { numbering: submittedNumbering } : {}),
        }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": saveIdentity({
            book: props.bookId,
            expected: props.updatedAt,
            boundaries,
            blocks: dirtyChanges,
            numbering: submittedNumbering,
          }),
        },
        method: "PATCH",
      });
      if (response.status === 412) {
        setConflict(true);
        setStatus("草稿已在其他页面更新。本地修改仍保留，请重新载入后再处理。");
        return;
      }
      if (!response.ok) {
        setStatus("修改未保存，请检查标题、层级、内容范围和诊断信息。");
        return;
      }
      acceptedSnapshot.current = {
        boundaries,
        nodes: submittedNodes,
        numbering: submittedNumbering,
        updatedAt: null,
      };
      const acceptedAt = await readSaveResult(response);
      acceptedSnapshot.current = {
        boundaries,
        nodes: submittedNodes,
        numbering: submittedNumbering,
        updatedAt: acceptedAt,
      };
      if (acceptedAt === props.updatedAt) {
        setNodes((current) =>
          mergeAcceptedNodes(props.structure, submittedNodes, current),
        );
        acceptedSnapshot.current = null;
      }
      await props.onSaved();
    } catch (error) {
      acceptedSnapshot.current = null;
      if (
        error instanceof DraftSaveFailure &&
        error.code === "DRAFT_PRECONDITION_FAILED"
      )
        setConflict(true);
      setStatus(
        error instanceof DraftSaveFailure &&
          error.code === "DRAFT_PRECONDITION_FAILED"
          ? "草稿已更新，本地修改仍保留。"
          : "修改未保存，请检查内容后重试。",
      );
    } finally {
      setSaving(false);
    }
  }

  useAutosave({
    dirty,
    paused: saving || conflict || Boolean(props.saveDisabled),
    signature: JSON.stringify({ nodes, boundaries, numbering }),
    save: () => {
      void save();
    },
  });

  async function discardAndReload() {
    acceptedSnapshot.current = null;
    setNodes(props.structure);
    setBoundaries(props.boundaries);
    setNumbering(props.numbering);
    setConflict(false);
    setStatus("");
    try {
      await props.onSaved();
    } catch {
      setStatus("重新载入草稿失败，请稍后重试。");
    }
  }

  useImperativeHandle(ref, () => ({
    save() {
      void save();
    },
  }));

  useEffect(() => {
    onStateChange({ conflict, dirty, saving });
  }, [conflict, dirty, onStateChange, saving]);

  return (
    <div className="structure-editor-contents contents">
      <section
        aria-label="目录试排"
        className={`${managePanel} structure-navigator col-start-1 row-start-1 self-start overflow-hidden ${
          props.mobileHidden ? "max-[850px]:hidden" : ""
        }`}
      >
        <div className="mb-3 flex min-h-12 items-center justify-between gap-3">
          <h2 className="text-base font-bold">目录试排</h2>
          {dirty && (
            <span className="shrink-0 rounded-sm bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900">
              试排中，尚未保存
            </span>
          )}
        </div>
        <fieldset className="mb-2">
          <legend className="sr-only">标题编号</legend>
          <div
            aria-label="标题编号方式"
            className="grid grid-cols-3 gap-1"
            role="group"
          >
            {(
              [
                ["source", "原书编号"],
                ["generated", "自动编号"],
                ["none", "无编号"],
              ] as const
            ).map(([mode, label]) => (
              <button
                aria-pressed={numbering === mode}
                className={`${manageQuietButton} min-h-9 min-w-0 px-2 py-1 text-sm`}
                key={mode}
                onClick={() => setNumbering(mode)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
        <div
          aria-label="目录显示范围"
          className="mb-2 grid grid-cols-2 gap-1"
          role="group"
        >
          <button
            aria-pressed={treeMode === "toc"}
            className={`${manageQuietButton} min-h-9 min-w-0 px-2 py-1 text-sm`}
            onClick={() => setTreeMode("toc")}
            type="button"
          >
            <Eye aria-hidden="true" size={16} />
            目录预览
          </button>
          <button
            aria-pressed={treeMode === "all"}
            className={`${manageQuietButton} min-h-9 min-w-0 px-2 py-1 text-sm`}
            onClick={() => setTreeMode("all")}
            type="button"
          >
            <EyeOff aria-hidden="true" size={16} />
            全部标题
          </button>
        </div>
        <div className="structure-search grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
          <Search aria-hidden="true" size={18} />
          <label className="m-0">
            <span className="sr-only">搜索结构</span>
            <input
              className={`${manageField} min-h-9 py-1.5`}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="搜索标题"
              type="search"
              value={query}
            />
          </label>
        </div>
        <div
          className="structure-virtual-list my-3 h-[calc(100vh-25rem)] min-h-72 max-h-[38rem] overflow-auto rounded-md bg-stone-50 py-1"
          ref={listParent}
        >
          {visibleNodes.length === 0 && (
            <p className={`p-4 ${manageQuietText}`}>
              {query ? "没有匹配的标题。" : "当前目录没有可见标题。"}
            </p>
          )}
          <ol
            className="structure-tree relative m-0 list-none p-0"
            role="tree"
            style={{ height: `${virtualizer.getTotalSize() + 8}px` }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const node = visibleNodes[item.index];
              if (!node) return null;
              const expandable = expandableIds.has(node.block_id);
              const expanded = expandable && !collapsedIds.has(node.block_id);
              return (
                <li
                  aria-expanded={expandable ? expanded : undefined}
                  aria-level={node.display_level}
                  className="absolute inset-x-0 w-full px-1"
                  key={node.block_id}
                  role="treeitem"
                  style={{
                    height: `${item.size}px`,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <div className="flex h-full items-center rounded-sm">
                    {expandable ? (
                      <button
                        aria-label={expanded ? "折叠子项" : "展开子项"}
                        className="grid size-8 shrink-0 place-items-center rounded-sm text-stone-500 hover:bg-stone-200"
                        onClick={() =>
                          setCollapsedIds((current) => {
                            const next = new Set(current);
                            if (expanded) next.add(node.block_id);
                            else next.delete(node.block_id);
                            return next;
                          })
                        }
                        type="button"
                      >
                        {expanded ? (
                          <ChevronDown aria-hidden="true" size={18} />
                        ) : (
                          <ChevronRight aria-hidden="true" size={18} />
                        )}
                      </button>
                    ) : (
                      <span className="size-8 shrink-0" />
                    )}
                    <button
                      aria-current={node.block_id === selectedId}
                      aria-label={node.preview_title || node.block_id}
                      className="h-8 min-w-0 flex-1 truncate rounded-sm bg-transparent pe-2 text-start text-sm text-stone-800 hover:bg-stone-200 aria-[current=true]:bg-emerald-100 aria-[current=true]:font-semibold aria-[current=true]:text-emerald-900"
                      onClick={() => {
                        setSelectedId(node.block_id);
                        props.onSelectHeading?.(node.block_id);
                      }}
                      style={{
                        paddingInlineStart: `${Math.max(0, node.display_level - 1) * 12 + 4}px`,
                      }}
                      type="button"
                    >
                      <span className="truncate">
                        {node.number && (
                          <span className="font-medium">{node.number} </span>
                        )}
                        <RichStructureTitle markdown={node.title_markdown} />
                      </span>
                    </button>
                    {!node.include_in_toc && treeMode === "all" && (
                      <span className="flex shrink-0 items-center gap-1 px-2 text-xs text-stone-500">
                        <EyeOff aria-hidden="true" size={14} />
                        不在目录中
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="mobile-detail-actions mt-4 hidden items-center gap-2 max-[1180px]:flex">
          <button
            className={manageSecondaryButton}
            onClick={() => selectedDialog.current?.showModal()}
            ref={selectedDialogTrigger}
            type="button"
          >
            <FilePenLine aria-hidden="true" size={18} />
            当前项
          </button>
        </div>
        <div className="editor-actions mt-4 flex flex-wrap gap-2">
          {status && (
            <button
              className={manageQuietButton}
              onClick={() => void discardAndReload()}
              type="button"
            >
              <RotateCcw aria-hidden="true" size={18} />
              放弃本地修改并重新载入
            </button>
          )}
        </div>
        {status && <p role="alert">{status}</p>}
      </section>

      <aside
        aria-label="当前结构项"
        className={`${managePanel} selected-node-editor desktop-node-editor col-start-3 row-start-1 max-h-[calc(100vh-12rem)] self-start overflow-auto max-[1180px]:hidden`}
      >
        {renderSelectedNode("desktop-editor-title")}
      </aside>

      <dialog
        aria-labelledby="mobile-editor-title"
        className={`workbench-mobile-dialog ${manageDialog}`}
        onClose={() => selectedDialogTrigger.current?.focus()}
        ref={selectedDialog}
      >
        <header className={manageDialogHeader}>
          <span>结构编辑</span>
          <button
            aria-label="关闭当前项编辑"
            className={manageDialogClose}
            onClick={() => selectedDialog.current?.close()}
            title="关闭"
            type="button"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </header>
        <div className="workbench-dialog-body p-4 max-[850px]:min-h-[calc(100dvh-3.5rem)] max-[850px]:overflow-auto">
          {renderSelectedNode("mobile-editor-title")}
        </div>
      </dialog>
    </div>
  );
});
