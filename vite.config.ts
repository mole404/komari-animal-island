import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { access, copyFile, cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** animal-island-ui 打包后 CSS 中指向资源的相对路径前缀（需要改写成相对 dist 的相对路径）。 */
const UPSTREAM_FILES_PREFIX = '../../../files/';
const LOCAL_FILES_PREFIX = '../files/';
/** 上游光标资源带内容哈希（如 cursor-icon.1ea93a65.png），版本升级后名字会变，这里复制成稳定文件名。 */
const CURSOR_FILE_PATTERN = /^cursor-icon.*\.png$/i;
const CURSOR_FILE_NAME = 'cursor-icon.png';
const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** 校验产物 CSS 中的相对资源引用都能在磁盘上找到，避免资源路径静默 404。 */
async function findUnresolvedCssAssets(assetsDir: string, cssFiles: string[]) {
  const unresolved: string[] = [];
  for (const file of cssFiles) {
    const css = await readFile(resolve(assetsDir, file), 'utf8');
    for (const match of css.matchAll(CSS_URL_PATTERN)) {
      const reference = match[2].trim();
      if (!reference) continue;
      if (reference.startsWith('data:') || reference.startsWith('http:') || reference.startsWith('https:')
        || reference.startsWith('//') || reference.startsWith('#') || reference.includes('var(')) continue;
      const target = resolve(assetsDir, reference.split(/[?#]/)[0]);
      try {
        await access(target);
      } catch {
        unresolved.push(`${file} -> ${reference}`);
      }
    }
  }
  return unresolved;
}

function bundleAnimalAssets(): Plugin {
  return {
    name: 'bundle-animal-island-assets',
    async writeBundle(options) {
      const output = resolve(options.dir ?? 'dist');
      const filesDir = resolve('node_modules/animal-island-ui/dist/files');
      const outFiles = resolve(output, 'files');
      await cp(filesDir, outFiles, { recursive: true });

      // 用 glob 匹配带哈希的上游光标资源，复制成稳定文件名供 src/theme.css 引用；找不到就让构建失败。
      const cursorCandidates = (await readdir(filesDir))
        .filter((name) => CURSOR_FILE_PATTERN.test(name))
        .sort();
      if (!cursorCandidates.length) {
        throw new Error(`[bundle-animal-island-assets] 在 ${filesDir} 中找不到 cursor-icon*.png，无法生成稳定的光标资源，构建中止。`);
      }
      const cursorSource = cursorCandidates.includes(CURSOR_FILE_NAME) ? CURSOR_FILE_NAME : cursorCandidates[0];
      await copyFile(resolve(filesDir, cursorSource), resolve(outFiles, CURSOR_FILE_NAME));

      const assets = resolve(output, 'assets');
      const cssFiles = (await readdir(assets)).filter((file) => file.endsWith('.css'));
      if (!cssFiles.length) {
        throw new Error(`[bundle-animal-island-assets] ${assets} 下没有 CSS 产物，构建中止。`);
      }

      let replaced = 0;
      for (const file of cssFiles) {
        const path = resolve(assets, file);
        const css = await readFile(path, 'utf8');
        const occurrences = css.split(UPSTREAM_FILES_PREFIX).length - 1;
        if (!occurrences) continue;
        replaced += occurrences;
        await writeFile(path, css.replaceAll(UPSTREAM_FILES_PREFIX, LOCAL_FILES_PREFIX));
      }

      // 断言：重写必须生效，且 CSS 里的相对资源引用必须真实存在，任一不满足都让构建失败（不再静默失效）。
      const unresolved = await findUnresolvedCssAssets(assets, cssFiles);
      if (unresolved.length) {
        throw new Error(
          `[bundle-animal-island-assets] CSS 引用的资源在产物中不存在，说明资源路径重写失效：\n${unresolved.join('\n')}`,
        );
      }
      if (!replaced) {
        // 上游 1.6.x 的 CSS 已不再输出 '../../../files/'（图标/字体由 Vite 处理为哈希资源），
        // 此时没有可替换项，改由上面的「资源必须可解析」断言兜底，并把事实打印出来而不是静默跳过。
        console.warn(`[bundle-animal-island-assets] 上游 CSS 中未出现 "${UPSTREAM_FILES_PREFIX}"，无需重写；已通过资源存在性断言校验。`);
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), bundleAnimalAssets()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
  },
});
