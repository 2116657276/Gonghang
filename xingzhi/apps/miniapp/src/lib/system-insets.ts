import Taro from '@tarojs/taro';

export type SystemInsetStyle = Record<'--app-safe-top' | '--app-action-top', string>;

/**
 * 微信自定义导航栏页面不能只依赖 CSS safe-area：部分真机上该值为 0。
 * 使用状态栏与胶囊按钮的真实位置，把标题和页头操作统一放到系统区域下方。
 */
export function getSystemInsetStyle(): SystemInsetStyle {
  const fallback = {
    '--app-safe-top': '42px',
    '--app-action-top': '40px',
  } as const;

  if (process.env.TARO_ENV !== 'weapp') return fallback;

  try {
    const windowInfo = Taro.getWindowInfo();
    const menu = Taro.getMenuButtonBoundingClientRect();
    const statusBarHeight = windowInfo.statusBarHeight ?? 20;
    const systemBottom = Math.max(statusBarHeight, menu.bottom || 0);
    const contentTop = systemBottom + 12;

    return {
      '--app-safe-top': `${contentTop}px`,
      '--app-action-top': `${contentTop}px`,
    };
  } catch {
    return fallback;
  }
}
