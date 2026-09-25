type ComponentConfig = {
  includes: Set<string>;
  includeAll: boolean;
};

type TaroPluginContext = {
  modifyComponentConfig: (
    handler: (options: { componentConfig: ComponentConfig }) => void,
  ) => void;
};

export default function preserveNativeComponents(ctx: TaroPluginContext) {
  ctx.modifyComponentConfig(({ componentConfig }) => {
    // Taro's production tree-shaking can miss native controls emitted from
    // Vue render functions. A missing template makes the control disappear on
    // a real device, so keep the native template set complete and stable.
    componentConfig.includeAll = true;
    for (const component of ['button', 'canvas', 'input', 'label', 'picker', 'textarea']) {
      componentConfig.includes.add(component);
    }
  });
}
