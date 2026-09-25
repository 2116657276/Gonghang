import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type UserConfigExport } from '@tarojs/cli';

function pruneStaleBuildFiles(sourceDirectory: string, targetDirectory: string) {
  for (const entry of fs.readdirSync(targetDirectory, { withFileTypes: true })) {
    const source = path.join(sourceDirectory, entry.name);
    const target = path.join(targetDirectory, entry.name);
    if (!fs.existsSync(source)) {
      fs.rmSync(target, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) pruneStaleBuildFiles(source, target);
  }
}

class PublishStableWeappPlugin {
  constructor(
    private readonly sourceDirectory: string,
    private readonly targetDirectory: string,
  ) {}

  apply(compiler: {
    hooks: {
      done: {
        tap: (name: string, handler: (stats: { hasErrors: () => boolean }) => void) => void;
      };
    };
  }) {
    compiler.hooks.done.tap('PublishStableWeappPlugin', (stats) => {
      if (stats.hasErrors()) return;
      fs.mkdirSync(this.targetDirectory, { recursive: true });
      const sourceAppConfig = path.join(this.sourceDirectory, 'app.json');
      const targetAppConfig = path.join(this.targetDirectory, 'app.json');
      fs.cpSync(this.sourceDirectory, this.targetDirectory, {
        recursive: true,
        force: true,
        // Keep the previous app.json throughout the copy. Writing it last also
        // gives DevTools one final change event after every other file is ready.
        filter: (source) => path.resolve(source) !== path.resolve(sourceAppConfig),
      });
      // The stable directory survives between compilations so DevTools never
      // observes a half-written app. Remove obsolete assets only after every
      // current file has been copied, otherwise deleted source assets would
      // remain in the published mini-program indefinitely.
      pruneStaleBuildFiles(this.sourceDirectory, this.targetDirectory);
      fs.copyFileSync(sourceAppConfig, targetAppConfig);
    });
  }
}

export default defineConfig<'webpack5'>(async () => {
  const target = process.env.TARO_ENV
    ?? (process.argv.includes('--type') ? process.argv[process.argv.indexOf('--type') + 1] : 'weapp');
  const isWeapp = target === 'weapp';
  // A plain local WeChat build must remain usable in DevTools. Release builds
  // should explicitly provide TARO_APP_API_BASE with the configured HTTPS host.
  const apiBase = process.env.TARO_APP_API_BASE?.trim()
    || (isWeapp ? 'http://127.0.0.1:8877' : '');
  const weappBuildDirectory = path.resolve(__dirname, '..', 'dist/.weapp-build');
  const stableWeappDirectory = path.resolve(__dirname, '..', 'dist/weapp');
  const config: UserConfigExport<'webpack5'> = {
    projectName: 'xingzhi-miniapp',
    date: '2026-09-19',
    designWidth: 750,
    deviceRatio: { 640: 2.34 / 2, 750: 1, 828: 1.81 / 2 },
    sourceRoot: 'src',
    // H5 and WeChat use separate outputs. WeChat compiles into a private
    // directory first; only a successful, complete compilation is published
    // to dist/weapp, which is the directory watched by WeChat DevTools.
    outputRoot: target === 'h5' ? 'dist/h5' : 'dist/.weapp-build',
    env: {
      TARO_APP_API_BASE: JSON.stringify(apiBase),
    },
    alias: {
      '@': path.resolve(__dirname, '..', 'src'),
    },
    plugins: [path.resolve(__dirname, 'preserve-native-components-plugin.ts')],
    framework: 'vue3',
    compiler: { type: 'webpack5', prebundle: { enable: false } },
    cache: { enable: true },
    mini: {
      miniCssExtractPluginOption: {
        // Component styles are isolated by class names. Their extraction
        // order does not affect specificity, so suppress non-actionable
        // cross-page ordering warnings from the shared mini-program chunk.
        ignoreOrder: true,
      },
      webpackChain(chain) {
        // WeChat's main-package asset ceiling is higher than webpack's web
        // default. Keep warnings aligned with the actual target platform.
        chain.performance.maxAssetSize(2 * 1024 * 1024).maxEntrypointSize(2 * 1024 * 1024);
        if (isWeapp) {
          chain
            .plugin('publish-stable-weapp-output')
            .use(PublishStableWeappPlugin, [weappBuildDirectory, stableWeappDirectory]);
        }
      },
      postcss: {
        pxtransform: { enable: true, config: {} },
        url: { enable: true, config: { limit: 10240 } },
        cssModules: { enable: false, config: { namingPattern: 'module', generateScopedName: '[name]__[local]___[hash:base64:5]' } },
      },
    },
    h5: {
      publicPath: '/',
      staticDirectory: 'static',
      miniCssExtractPluginOption: { ignoreOrder: true },
      router: { mode: 'browser' },
      devServer: {
        host: '0.0.0.0',
        port: 5173,
        proxy: {
          '/api': {
            target: 'http://127.0.0.1:8877',
            changeOrigin: true,
            headers: { origin: 'http://localhost:5173' },
          },
        },
      },
    },
  };
  return config;
});
