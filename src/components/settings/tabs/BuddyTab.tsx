import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../../../stores/settingsStore";
import { BrowserDomEvents } from "../../../buddy/adapters/dom-events";
import { TauriHostBridge } from "../../../buddy/adapters/host-bridge";
import { getBuddyConfig, loadBuddyConfig, type BuddyConfig } from "../../../buddy/core/config";
import { refreshCodexPets, type CodexPetInfo } from "../../../buddy/sprite-skin";
import { checkboxLabelStyle } from "../tabStyles";

type BuddySkin = BuddyConfig["skin"];
type BuddySkinValue = "svg" | `codex-pet:${string}`;
const buddyHostBridge = new TauriHostBridge();
const buddyDomEvents = new BrowserDomEvents();

function skinToValue(skin: BuddySkin, pets?: CodexPetInfo[]): BuddySkinValue {
  if (skin.mode === "codex-pet" && skin.petName) {
    const petExists = !pets || pets.some((pet) => pet.name === skin.petName);
    if (petExists) {
      return `codex-pet:${skin.petName}`;
    }
  }
  return "svg";
}

function skinFromValue(value: BuddySkinValue): BuddySkin {
  if (value.startsWith("codex-pet:")) {
    const petName = value.slice("codex-pet:".length);
    if (petName) {
      return { mode: "codex-pet", petName };
    }
  }
  return { mode: "svg" };
}

async function loadBuddySettingsDocument(): Promise<Record<string, unknown>> {
  const raw = await invoke<string>("load_buddy_settings");
  if (!raw.trim()) {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

// Ported from SettingsMenu.tsx: Claude Buddy checkbox + skin select,
// including the disabled+dim-when-off parent/child pattern (D4 fix) and
// the codex-pet loading logic.
export function BuddyTab() {
  const buddyEnabled = useSettingsStore((s) => s.buddyEnabled);
  const setBuddyEnabled = useSettingsStore((s) => s.setBuddyEnabled);

  const [codexPets, setCodexPets] = useState<CodexPetInfo[]>([]);
  const [buddySkinValue, setBuddySkinValue] = useState<BuddySkinValue>("svg");
  const [buddySkinLoading, setBuddySkinLoading] = useState(false);
  const [buddySkinMsg, setBuddySkinMsg] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    const loadBuddySkin = async (): Promise<void> => {
      setBuddySkinLoading(true);
      setBuddySkinMsg("");
      try {
        await loadBuddyConfig(buddyHostBridge, buddyDomEvents);
        const pets = await refreshCodexPets();
        if (cancelled) {
          return;
        }
        setCodexPets(pets);
        setBuddySkinValue(skinToValue(getBuddyConfig().skin, pets));
      } catch (e) {
        console.error("Failed to load Buddy skin settings", e);
        if (!cancelled) {
          setBuddySkinMsg("Buddy skin load failed");
          setBuddySkinValue("svg");
        }
      } finally {
        if (!cancelled) {
          setBuddySkinLoading(false);
        }
      }
    };

    void loadBuddySkin();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleBuddySkinChange = async (value: BuddySkinValue): Promise<void> => {
    const nextSkin = skinFromValue(value);
    setBuddySkinValue(value);
    setBuddySkinLoading(true);
    setBuddySkinMsg("");
    try {
      const settings = await loadBuddySettingsDocument();
      await invoke("save_buddy_settings", {
        json: JSON.stringify({ ...settings, skin: nextSkin }, null, 2),
      });
      await loadBuddyConfig(buddyHostBridge, buddyDomEvents);
      setBuddySkinValue(skinToValue(getBuddyConfig().skin, codexPets));
    } catch (e) {
      console.error("Failed to save Buddy skin", e);
      setBuddySkinMsg("Buddy skin save failed");
      setBuddySkinValue(skinToValue(getBuddyConfig().skin, codexPets));
    } finally {
      setBuddySkinLoading(false);
    }
  };

  return (
    <div>
      <label style={checkboxLabelStyle}>
        <input
          type="checkbox"
          checked={buddyEnabled}
          onChange={(e) => setBuddyEnabled(e.target.checked)}
        />
        <span>Claude Buddy</span>
      </label>

      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6, maxWidth: 320 }}>
        <label
          htmlFor="buddy-skin-select"
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: buddyEnabled ? "var(--cmux-text-dim, rgba(255,255,255,0.55))" : "var(--cmux-text-dim)",
          }}
        >
          Buddy skin
        </label>
        <select
          id="buddy-skin-select"
          value={buddySkinValue}
          disabled={buddySkinLoading || !buddyEnabled}
          onChange={(e) => void handleBuddySkinChange(e.target.value as BuddySkinValue)}
          style={{
            width: "100%",
            minWidth: 0,
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid var(--cmux-border)",
            background: "var(--cmux-popover)",
            color: buddyEnabled ? "var(--cmux-text)" : "var(--cmux-text-dim)",
            fontSize: 12,
            cursor: buddyEnabled ? (buddySkinLoading ? "wait" : "pointer") : "not-allowed",
          }}
        >
          <option value="svg">Default (SVG)</option>
          {codexPets.map((pet) => (
            <option key={pet.name} value={`codex-pet:${pet.name}`}>
              {`Codex Pet: ${pet.displayName}`}
            </option>
          ))}
        </select>
        {buddySkinMsg && (
          <div style={{ fontSize: 11, color: "var(--cmux-red)" }}>
            {buddySkinMsg}
          </div>
        )}
      </div>
    </div>
  );
}
