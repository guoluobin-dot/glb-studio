/**
 * 渲染层错误边界
 * © 2026 郭洛斌
 *
 * 为什么必须有：
 * React 里任何一个 render 抛异常，整棵树会被卸载 —— 用户看到的就是**纯白屏**，
 * 没有任何提示、没有堆栈、连"出错了"三个字都没有。
 *
 * 这不是假设。今天就撞上了：WindowedList 里 ref 回调里setState 造成无限循环，
 * React 抛 #185，点一下候选段块整个界面就没了。我自动化点 4 个段块全"正常"，
 * 用户那边"点下去立刻白屏" —— 因为崩的是我的探针没覆盖到的另一个入口。
 *
 * 更糟的是没有边界时，日志里也只有一句压缩过的
 * "Minified React error #185"，具体是哪一行要看 sourcemap 猜。
 *
 * 所以这里做三件事：
 *   1. 把错误显示出来（堆栈、组件栈），用户自己能截图反馈；
 *   2. 抄一份到 console，让 DevTools 能查；
 *   3. 留一个"重试"按钮 —— 很多崩溃是数据问题，切换界面再回来就好了。
 *
 * 注意：错误边界只能兜住 render 阶段的异常。
 * 事件回调、异步、setTimeout 里抛的它抓不到（那类会在 console 里留痕，
 * 不至于白屏），所以别指望它包住一切。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { LuCircleAlert, LuRotateCcw } from "react-icons/lu";

interface Props {
  children: ReactNode;
  /** 给这个边界起个名字，出错时显示出来，便于定位是哪块界面 */
  label?: string;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info });
    // 也抄到 console：DevTools 里能看完整堆栈和组件栈
    console.error(`[${this.props.label ?? "渲染层"}] 崩溃：`, error, info.componentStack);
  }

  private readonly retry = (): void => {
    this.setState({ error: null, info: null });
  };

  override render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-2xl">
          <div className="mb-3 flex items-center gap-2 text-bad">
            <LuCircleAlert className="h-5 w-5 shrink-0" />
            <span className="text-[14px] font-extrabold">
              {this.props.label ?? "界面"}出错了
            </span>
          </div>
          <p className="mb-3 text-[12.5px] leading-relaxed text-mut">
            这是程序自己的问题，不是你操作错了。下面是详细信息，可以截图反馈。
          </p>

          {/* 错误信息要给用户看。压缩过的 React 报错对用户毫无意义，
              但"哪个组件、哪一行"是我们自己排查的唯一线索。 */}
          <pre className="scroll-thin mb-3 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-bad/40 bg-bad/8 p-3 font-mono text-[11px] leading-relaxed text-fg">
            {error.message}
            {"\n\n"}
            {error.stack ?? "（无堆栈）"}
            {info?.componentStack ? `\n\n组件栈:${info.componentStack}` : ""}
          </pre>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={this.retry}
              className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] font-bold text-mut transition-colors hover:border-ember/60 hover:text-ember"
            >
              <LuRotateCcw className="h-3.5 w-3.5" />
              重试
            </button>
            <button
              type="button"
              onClick={() => location.reload()}
              className="rounded-lg border border-line px-3 py-1.5 text-[12px] font-bold text-mut transition-colors hover:border-ember/60 hover:text-ember"
            >
              重启应用
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;