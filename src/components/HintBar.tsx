/** @jsxImportSource @opentui/solid */
import { For } from "solid-js";
import { adaptTheme, type TuiContext } from "../opencode";

export type HintBarItem = {
  keybind: string | false;
  label: string;
};

export function HintBar(props: {
  api: TuiContext;
  items: HintBarItem[];
}) {
  const theme = adaptTheme(props.api.theme);

  return (
    <box flexDirection="row" gap={2}>
      <For each={props.items.filter((item) => item.keybind)}>
        {(item) => (
          <text fg={theme.textMuted}>
            <b>{item.keybind}</b> {item.label}
          </text>
        )}
      </For>
    </box>
  );
}
