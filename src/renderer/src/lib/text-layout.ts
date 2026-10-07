/**
 * 字幕 / 标题在画面上的几何位置。
 *
 * 为什么单独一个文件：这里算的公式必须和
 * D:\GLB\Hermes\src\generator\index.js 里烧字时的公式**完全一致**。
 * 两处各写一份，界面上画的位置和成片里的位置就会对不上 ——
 * 而"预览和成片不一样"是用户最难自己查出来的一类问题，
 * 只能靠两边永不漂移来避免。
 *
 * 参照高度固定 1920：服务端把用户填的值乘 (画面高/1920)，
 * 所以这里的值也是"1920 高的画面上的值"，按比例缩到任意画面即可。
 */

/** 参照高度。服务端所有 px 值都以此为基准 */
export const REF_HEIGHT = 1920;

/** 标题预设：位置到"距画面顶部的像素"（已含微调，1920 基准） */
export function titleTopPx(position: string | undefined, offsetY: number | undefined): number {
  const off = Number.isFinite(Number(offsetY)) ? Number(offsetY) : 0;
  const pos = String(position ?? "top");
  if (pos === "bottom") return REF_HEIGHT - 140 + off;
  if (pos === "middle") return REF_HEIGHT / 2 - 40 + off;
  return 20 + off;
}

/** 字幕底边距：ASS MarginV 是"距画面底部的像素"，越大越靠上 */
export function captionBottomPx(marginV: number | undefined): number {
  return Number.isFinite(Number(marginV)) ? Number(marginV) : 60;
}

/**
 * 在给定尺寸的画面里，画出字幕和标题应该落在哪。
 *
 * @param h 画面高度（px）
 * @returns 相对画面顶部的百分比位置，渲染层直接用百分比，不用再算缩放
 */
export function layoutFor(
  h: number,
  caption?: { marginV?: number; size?: number; outline?: number; shadow?: number; bold?: boolean; color?: string; box?: boolean; boxOpacity?: number; font?: string },
  title?: { position?: "top" | "middle" | "bottom"; offsetY?: number; size?: number; shadow?: number; boxOpacity?: number; color?: string; font?: string }
): {
  scale: number;
  caption: { bottomPct: number; fontPx: number; outlinePx: number; shadowPx: number };
  title: { topPct: number; fontPx: number; shadowPx: number };
} {
  const scale = h / REF_HEIGHT;

  const capBottom = captionBottomPx(caption?.marginV) * scale;
  const capSize = (Number(caption?.size) > 0 ? Number(caption?.size) : 28) * scale;

  const ttlTop = titleTopPx(title?.position, title?.offsetY) * scale;
  const ttlSize = (Number(title?.size) > 0 ? Number(title?.size) : 36) * scale;

  return {
    scale,
    // ASS 的 MarginV 量到文字底缘，所以底边距就是文字底缘离画面底部的距离
    caption: {
      bottomPct: capBottom,
      fontPx: capSize,
      outlinePx: (Number(caption?.outline) > 0 ? Number(caption?.outline) : 3) * scale,
      shadowPx: (Number(caption?.shadow) > 0 ? Number(caption?.shadow) : 1) * scale
    },
    title: {
      topPct: ttlTop,
      fontPx: ttlSize,
      shadowPx: (Number(title?.shadow) > 0 ? Number(title?.shadow) : 0) * scale
    }
  };
}