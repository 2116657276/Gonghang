import Taro from '@tarojs/taro';

export type SystemInsetStyle = Record<
  '--app-safe-top'
  | '--app-action-top'
  | '--app-status-bar-height'
  | '--app-nav-height'
  | '--app-menu-safe-right',
  string
>;

/**
 * 微信自定义导航栏页面不能只依赖 CSS safe-area：部分真机上该值为 0。
 * 使用状态栏与胶囊按钮的真实位置，把标题和页头操作统一放到系统区域下方。
 */
export function getSystemInsetStyle(): SystemInsetStyle {
  const fallback = {
    '--app-safe-top': '42px',
    '--app-action-top': '40px',
    '--app-status-bar-height': '0px',
    '--app-nav-height': '48px',
    '--app-menu-safe-right': '16px',
  } as const;

  if (process.env.TARO_ENV !== 'weapp') return fallback;

  try {
    const windowInfo = Taro.getWindowInfo();
    const menu = Taro.getMenuButtonBoundingClientRect();
    const statusBarHeight = windowInfo.statusBarHeight ?? 20;
    const windowWidth = windowInfo.windowWidth ?? 0;
    const menuIsValid = menu.width > 0
      && menu.height > 0
      && menu.top >= statusBarHeight
      && menu.bottom > menu.top
      && menu.left > 0
      && (windowWidth === 0 || menu.right <= windowWidth);
    const menuGap = menuIsValid ? Math.max(0, menu.top - statusBarHeight) : 0;
    const navHeight = menuIsValid ? Math.max(44, menu.height + menuGap * 2) : 44;
    const menuSafeRight = menuIsValid && windowWidth > 0 ? windowWidth - menu.left + 8 : 16;
    const systemBottom = Math.max(statusBarHeight, menuIsValid ? menu.bottom : 0);
    const contentTop = systemBottom + 12;

    return {
      '--app-safe-top': `${contentTop}px`,
      '--app-action-top': `${contentTop}px`,
      '--app-status-bar-height': `${statusBarHeight}px`,
      '--app-nav-height': `${navHeight}px`,
      '--app-menu-safe-right': `${menuSafeRight}px`,
    };
  } catch {
    return fallback;
  }
}
