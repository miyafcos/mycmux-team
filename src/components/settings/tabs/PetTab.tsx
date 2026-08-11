import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PetSprite from "../../workspace/PetSprite";
import { listPets } from "../../../lib/ipc";
import { candidatesFromListedPets, resolvePet } from "../../../lib/pets";
import { usePetSettingsStore } from "../../../stores/petSettingsStore";
import { useWorkspaceListStore } from "../../../stores/workspaceListStore";
import { dialogButtonStyle, dividerStyle, sectionHeadingStyle } from "../tabStyles";
import { petSettingsStrings } from "../settingsStrings";

const hintStyle = {
  margin: "-4px 0 10px",
  color: "var(--cmux-text-dim)",
  fontSize: 11,
  lineHeight: 1.5,
};

const radioStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "5px 0",
  cursor: "pointer",
  fontSize: 12,
};

export function PetTab() {
  const displayMode = usePetSettingsStore((state) => state.petDisplayMode);
  const newWorkspaceMode = usePetSettingsStore((state) => state.petNewWorkspaceMode);
  const disabled = usePetSettingsStore((state) => state.petDisabled);
  const fixedId = usePetSettingsStore((state) => state.petFixedId);
  const pets = usePetSettingsStore((state) => state.pets);
  const setDisplayMode = usePetSettingsStore((state) => state.setPetDisplayMode);
  const setNewWorkspaceMode = usePetSettingsStore((state) => state.setPetNewWorkspaceMode);
  const setDisabled = usePetSettingsStore((state) => state.setPetDisabled);
  const setFixedId = usePetSettingsStore((state) => state.setPetFixedId);
  const setPets = usePetSettingsStore((state) => state.setPets);
  const workspaces = useWorkspaceListStore((state) => state.workspaces);
  const setWorkspacePet = useWorkspaceListStore((state) => state.setWorkspacePet);
  const [scanning, setScanning] = useState(false);
  const requestId = useRef(0);

  const enabledPets = useMemo(
    () => pets.filter((pet) => !disabled.includes(pet.id)),
    [disabled, pets],
  );

  const rescan = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setScanning(true);
    try {
      const listed = await listPets();
      if (currentRequest === requestId.current) setPets(candidatesFromListedPets(listed));
    } catch (error) {
      console.warn("[pets] Failed to rescan pets:", error);
    } finally {
      if (currentRequest === requestId.current) setScanning(false);
    }
  }, [setPets]);

  useEffect(() => {
    void rescan();
    return () => { requestId.current += 1; };
  }, [rescan]);

  const toggleCandidate = (id: string) => {
    const isDisabled = disabled.includes(id);
    if (!isDisabled && enabledPets.length <= 1) return;
    setDisabled(isDisabled ? disabled.filter((value) => value !== id) : [...disabled, id]);
    if (!isDisabled && fixedId === id) setFixedId(enabledPets.find((pet) => pet.id !== id)?.id);
  };

  const nextPet = (currentId: string | undefined, random: boolean) => {
    if (enabledPets.length === 0) return undefined;
    if (random) {
      const alternatives = enabledPets.filter((pet) => pet.id !== currentId);
      const pool = alternatives.length > 0 ? alternatives : enabledPets;
      return pool[Math.floor(Math.random() * pool.length)]?.id;
    }
    const index = enabledPets.findIndex((pet) => pet.id === currentId);
    return enabledPets[(index + 1 + enabledPets.length) % enabledPets.length]?.id;
  };

  return (
    <div>
      <section>
        <div style={sectionHeadingStyle}>{petSettingsStrings.displayTitle}</div>
        <div style={hintStyle}>{petSettingsStrings.displayHint}</div>
        {/* "both" (small pets on tab pills) is not implemented yet — do not offer it */}
        {(["ws", "none"] as const).map((mode) => (
          <label key={mode} style={radioStyle}>
            <input type="radio" name="pet-display" checked={displayMode === mode} onChange={() => setDisplayMode(mode)} />
            <span>{mode === "ws" ? petSettingsStrings.displayModeWs : petSettingsStrings.displayModeNone}</span>
          </label>
        ))}
      </section>

      <div style={dividerStyle} />
      <section>
        <div style={sectionHeadingStyle}>{petSettingsStrings.candidatesTitle}</div>
        <div style={hintStyle}>{petSettingsStrings.candidatesHint}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(132px, 100%), 1fr))", gap: 8 }}>
          {pets.map((pet) => {
            const enabled = !disabled.includes(pet.id);
            return (
              <button
                key={pet.id}
                type="button"
                aria-pressed={enabled}
                onClick={() => toggleCandidate(pet.id)}
                style={{
                  border: `1px solid ${enabled ? "var(--cmux-accent)" : "var(--cmux-border)"}`,
                  borderRadius: 7,
                  background: enabled ? "color-mix(in srgb, var(--cmux-accent) 12%, transparent)" : "transparent",
                  color: "var(--cmux-text)",
                  cursor: enabled && enabledPets.length <= 1 ? "not-allowed" : "pointer",
                  minHeight: 94,
                  padding: 8,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <span style={{ display: "flex", marginRight: -8 }}><PetSprite atlasUrl={pet.atlasUrl} state="running" height={46} /></span>
                <span style={{ fontSize: 12, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pet.name}</span>
                <span style={{ fontSize: 10, color: "var(--cmux-text-dim)" }}>{pet.source === "bundled" ? petSettingsStrings.bundledSourceLabel : petSettingsStrings.externalSourceLabel}</span>
              </button>
            );
          })}
        </div>
      </section>

      <div style={dividerStyle} />
      <section>
        <div style={sectionHeadingStyle}>{petSettingsStrings.newWsTitle}</div>
        {/* "choose" has no picker UI yet (falls back silently) — do not offer it */}
        {(["random", "fixed"] as const).map((mode) => (
          <label key={mode} style={radioStyle}>
            <input type="radio" name="pet-new-workspace" checked={newWorkspaceMode === mode} onChange={() => setNewWorkspaceMode(mode)} />
            <span>{mode === "random" ? petSettingsStrings.newWsRandom : petSettingsStrings.newWsFixed}</span>
          </label>
        ))}
        {newWorkspaceMode === "fixed" && (
          <select value={fixedId ?? ""} onChange={(event) => setFixedId(event.target.value || undefined)} style={{ marginTop: 6, maxWidth: "100%" }}>
            {enabledPets.map((pet) => <option key={pet.id} value={pet.id}>{pet.name}</option>)}
          </select>
        )}
      </section>

      <div style={dividerStyle} />
      <section>
        <div style={sectionHeadingStyle}>{petSettingsStrings.importTitle}</div>
        <div style={hintStyle}>{petSettingsStrings.importHint}</div>
        <button type="button" style={dialogButtonStyle} onClick={() => void rescan()} disabled={scanning}>
          {petSettingsStrings.rescanButton}
        </button>
      </section>

      <div style={dividerStyle} />
      <section>
        <div style={sectionHeadingStyle}>{petSettingsStrings.assignTitle}</div>
        <div style={hintStyle}>{petSettingsStrings.assignHint}</div>
        <div style={{ display: "grid", gap: 7 }}>
          {workspaces.map((workspace) => {
            const pet = workspace.pet ? resolvePet(pets, workspace.pet) : undefined;
            return (
              <div key={workspace.id} style={{ border: "1px solid var(--cmux-border)", borderRadius: 6, padding: "6px 8px", display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ display: "flex", marginRight: -8 }}><PetSprite atlasUrl={(pet ?? resolvePet(pets, undefined)).atlasUrl} state="idle" height={26} /></span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{workspace.name}</span>
                <span style={{ maxWidth: 108, fontSize: 11, color: "var(--cmux-text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pet?.name ?? "-"}</span>
                <button type="button" style={dialogButtonStyle} onClick={() => setWorkspacePet(workspace.id, nextPet(workspace.pet, true))}>{petSettingsStrings.rerollButton}</button>
                <button type="button" style={dialogButtonStyle} onClick={() => setWorkspacePet(workspace.id, nextPet(workspace.pet, false))}>{petSettingsStrings.changeButton}</button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
