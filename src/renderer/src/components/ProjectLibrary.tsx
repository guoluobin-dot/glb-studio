/**
 * 项目库
 * © 2026 郭洛斌
 *
 * 侧栏「项目库」以前是个空按钮。现在它是真正的项目列表：
 * 能打开、能重命名、能删除。
 *
 * 位置存 %APPDATA%\glb\projects,换电脑/重装系统把那个目录带走即可。
 */
import { useState } from "react";
import { LuFolderOpen, LuPencil, LuTrash2, LuX } from "react-icons/lu";
import type { ProjectSummary } from "@shared/api-types";
import { Dot, Modal, cx } from "./ui";

interface Props {
  projects: ProjectSummary[];
  activeId: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function ProjectLibrary({
  projects,
  activeId,
  onClose,
  onOpen,
  onRename,
  onDelete
}: Props): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  return (
    <>
      <Modal
        title="项目库"
        subtitle={projects.length > 0 ? `${projects.length} 个项目 · 点名称打开` : undefined}
        onClose={onClose}
        footer={
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-[12px] font-semibold text-mut hover:text-fg"
          >
            <LuX className="h-3.5 w-3.5" />
            关闭
          </button>
        }
      >
      <div className="flex flex-col gap-2">
        {projects.length === 0 && (
          <p className="py-8 text-center text-[12px] text-mut-2">
            还没有项目。导入素材并跑一次分析后会自动保存到这里。
          </p>
        )}

        {projects.map((p) => {
          const editing = editingId === p.id;
          return (
            <div
              key={p.id}
              className={cx(
                "group flex items-center gap-2.5 rounded-xl border px-3 py-2.5 transition-colors",
                p.id === activeId ? "border-ember/35 bg-ember/6" : "border-line bg-panel-2/50 hover:border-line/80"
              )}
            >
              <LuFolderOpen className="h-4 w-4 shrink-0 text-mut-2" />

              <div className="min-w-0 flex-1">
                {editing ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && draft.trim()) {
                        void onRename(p.id, draft.trim());
                        setEditingId(null);
                      } else if (e.key === "Escape") {
                        setEditingId(null);
                      }
                    }}
                    onBlur={() => {
                      if (draft.trim() && draft !== p.name) void onRename(p.id, draft.trim());
                      setEditingId(null);
                    }}
                    className="w-full rounded-md border border-line bg-panel px-2 py-1 text-[12.5px] outline-none focus:border-ember/60"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpen(p.id)}
                    className="block max-w-full truncate text-left text-[12.5px] font-semibold text-fg/90 hover:text-ember"
                    title="打开这个项目"
                  >
                    {p.name}
                  </button>
                )}
                <div className="tabular mt-0.5 flex items-center gap-1.5 font-mono text-[9.5px] text-mut-2">
                  <Dot tone={p.candidateCount > 0 ? "ok" : "bad"} />
                  {relativeTime(p.lastOpenedAt || p.updatedAt)}
                  {p.candidateCount > 0 && ` · ${p.candidateCount} 条候选`}
                </div>
              </div>

              {!editing && (
                <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(p.id);
                      setDraft(p.name);
                    }}
                    title="重命名"
                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-mut transition-colors hover:text-ember"
                  >
                    <LuPencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmId(p.id)}
                    title="删除"
                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-mut transition-colors hover:border-bad hover:text-bad"
                  >
                    <LuTrash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      </Modal>

      {/* 删除要二次确认:项目里有分析结果,删了要重跑几十分钟 */}
      {confirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-6 backdrop-blur-sm">
          <div className="pop-in w-full max-w-sm rounded-2xl border border-line bg-panel p-5">
            <h3 className="text-[14px] font-extrabold">删除这个项目？</h3>
            <p className="mt-2 text-[12px] leading-relaxed text-mut">
              「{projects.find((p) => p.id === confirmId)?.name}」的分析结果会被删除。
              素材原文件不受影响,但要重新跑一次分析才能找回候选。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmId(null)}
                className="rounded-lg border border-line px-4 py-2 text-[12.5px] font-semibold text-mut hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  void onDelete(confirmId);
                  setConfirmId(null);
                }}
                className="rounded-lg border border-bad/50 px-4 py-2 text-[12.5px] font-bold text-bad transition-colors hover:bg-bad/10"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const day = 86_400_000;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < day * 30) return `${Math.floor(diff / day)} 天前`;
  return new Date(then).toLocaleDateString("zh-CN");
}