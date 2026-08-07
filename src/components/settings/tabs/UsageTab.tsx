import { UsageAccountsPanel } from "../../layout/UsageAccountsDialog";
import { CliAccountsPanel } from "../CliAccountsPanel";

// Two distinct account concepts live on this tab. Keep the headers explicit:
// "CLI ログイン" is the machine-global login the claude / codex CLIs actually
// bill against (switchable), while "使用量モニタリング" is the read-only OAuth
// registration used by the titlebar usage meter. Deleting an entry means a
// different thing in each section.
export function UsageTab() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <section>
        <h3 style={{ margin: "0 0 8px", fontSize: 13 }}>CLI ログイン (claude / codex)</h3>
        <CliAccountsPanel />
      </section>
      <section style={{ borderTop: "1px solid var(--cmux-border)", paddingTop: 14 }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 13 }}>使用量モニタリング</h3>
        <UsageAccountsPanel />
      </section>
    </div>
  );
}
