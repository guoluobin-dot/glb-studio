/**
 * 快捷键说明
 * © 2026 郭洛斌
 *
 * 选片是重复动作,快捷键能大幅提速。但用户不一定记得住,
 * 所以要在界面上明确列出并随时能打开 —— 藏在文档里的快捷键等于不存在。
 */
import { LuKeyboard } from "react-icons/lu";
import { Modal } from "./ui";
import { SHORTCUT_LIST } from "../hooks/useShortcuts";

export function ShortcutHelp({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <Modal title="快捷键" subtitle="手不离键盘,选片更快" onClose={onClose} width="max-w-md">
      <div className="flex flex-col gap-1">
        {SHORTCUT_LIST.map((s) => (
          <div
            key={s.keys}
            className="flex items-center gap-3 rounded-lg border border-line/70 bg-panel-2/40 px-3 py-2"
          >
            <kbd className="shrink-0 rounded-md border border-line bg-panel-3 px-2 py-1 font-mono text-[11px] font-bold text-fg">
              {s.keys}
            </kbd>
            <span className="text-[12px] text-mut">{s.desc}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-mut-2">
        <LuKeyboard className="mt-px h-3 w-3 shrink-0" />
        在搜索框里打字时快捷键会自动让位,空格就是空格。
      </p>
    </Modal>
  );
}
