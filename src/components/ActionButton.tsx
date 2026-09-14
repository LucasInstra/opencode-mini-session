/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import { adaptTheme, type TuiContext } from "../opencode";

type ActionButtonProps = {
  api: TuiContext;
  label: string;
  keybind?: string;
  disabled?: boolean;
  onPress: () => void;
};

export function ActionButton(props: ActionButtonProps) {
  const theme = adaptTheme(props.api.theme);

  return (
    <box
      flexDirection="row"
      onMouseUp={() => {
        if (!props.disabled) props.onPress();
      }}
    >
      <text fg={props.disabled ? theme.textMuted : theme.text}>
        <b>{props.label}</b>
      </text>
      <Show when={props.keybind}>
        <text fg={theme.textMuted}> {props.keybind}</text>
      </Show>
    </box>
  );
}
