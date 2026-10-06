import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * GLB Studio 构建配置。
 * 三个产物:主进程(preload 注入)、预加载桥、渲染层。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["electron"] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
        // electron 运行时提供的模块不能打进产物,否则会带着 electron 包的
        // 安装逻辑(getElectronPath)一起跑,启动时误报 "Electron failed to install"
        external: ["electron", "electron/main", /^electron\//]
      }
    },
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
        "@main": resolve(__dirname, "src/main")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["electron"] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        external: ["electron"]
      }
    }
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
        "@renderer": resolve(__dirname, "src/renderer/src")
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") }
      }
    }
  }
});
