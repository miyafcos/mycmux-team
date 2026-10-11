// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotificationsLayoutTab } from "../../src/components/settings/tabs/NotificationsLayoutTab";
import { useSettingsStore } from "../../src/stores/settingsStore";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function checkboxFor(labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label"))
    .find((item) => item.textContent?.includes(labelText));
  const input = label?.querySelector<HTMLInputElement>("input[type='checkbox']");
  if (!input) throw new Error(`Checkbox not found: ${labelText}`);
  return input;
}

beforeEach(() => {
  useSettingsStore.setState({
    notificationsEnabled: true,
    notificationSoundEnabled: true,
    toastAiActivityEnabled: true,
    toastUserActionEnabled: true,
    toastSystemEnabled: true,
    groupingApplyAnimationEnabled: true,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("notification toast settings", () => {
  it("dims and disables every child setting while the notification master is off", () => {
    useSettingsStore.setState({ notificationsEnabled: false });

    act(() => root.render(<NotificationsLayoutTab />));

    for (const label of ["通知サウンド", "AIの自動処理結果", "操作の結果", "システム・接続"]) {
      const checkbox = checkboxFor(label);
      expect(checkbox.disabled).toBe(true);
      expect(checkbox.checked).toBe(true);
      expect(checkbox.closest("label")?.style.color).toBe("var(--cmux-text-dim)");
      expect(checkbox.closest("label")?.style.cursor).toBe("not-allowed");
    }
  });

  it("updates each toast category without changing the other categories", () => {
    act(() => root.render(<NotificationsLayoutTab />));

    act(() => checkboxFor("AIの自動処理結果").click());

    expect(useSettingsStore.getState()).toMatchObject({
      toastAiActivityEnabled: false,
      toastUserActionEnabled: true,
      toastSystemEnabled: true,
    });
    expect(container.textContent).toContain("失敗・エラーは通知設定に関わらず常に表示します。");
  });

  it("shows the grouping apply animation setting enabled by default and persists its toggle", () => {
    expect(useSettingsStore.getInitialState().groupingApplyAnimationEnabled).toBe(true);
    act(() => root.render(<NotificationsLayoutTab />));

    const checkbox = checkboxFor("タブ再配置の適用時に動きを表示");
    expect(checkbox.checked).toBe(true);
    expect(container.textContent).toContain("Windows のアニメーション効果をオフにしている場合も動きません。");

    act(() => checkbox.click());
    expect(useSettingsStore.getState().groupingApplyAnimationEnabled).toBe(false);
  });
});
