import { useEffect, useMemo, useState } from "react";
import { fetchPetGallery, fetchPetPreview, installPetFromGallery, quarantinePet, type GalleryPage, type GalleryPet } from "../../../lib/ipc";
import { useToastStore } from "../../../stores/toastStore";
import { dialogButtonStyle, sectionHeadingStyle } from "../tabStyles";
import { petSettingsStrings } from "../settingsStrings";

const emptyPage: GalleryPage = { pets: [], total: 0 };

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizeGalleryResponse(value: unknown): GalleryPage {
  const page = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const pets = Array.isArray(page.pets) ? page.pets : [];
  return {
    total: numberValue(page.total),
    pets: pets.filter((pet): pet is Record<string, unknown> => Boolean(pet) && typeof pet === "object").map((pet) => ({
      id: stringValue(pet.id), displayName: stringValue(pet.displayName), description: stringValue(pet.description),
      tags: Array.isArray(pet.tags) ? pet.tags.filter((tag): tag is string => typeof tag === "string") : [],
      likeCount: numberValue(pet.likeCount), downloadCount: numberValue(pet.downloadCount), previewUrl: stringValue(pet.previewUrl),
      atlasSize: stringValue(pet.atlasSize), statesDetected: Array.isArray(pet.statesDetected) ? pet.statesDetected.filter((state): state is string => typeof state === "string") : [],
    })),
  };
}

export function atlasSizeBadge(atlasSize: string): string {
  if (atlasSize === "1536x1872") return "8×9";
  if (atlasSize === "1536x2288") return "8×11";
  return "";
}

export function isGalleryInstalled(id: string, installedIds: readonly string[]): boolean {
  return installedIds.includes(id) || installedIds.includes(`external:${id}`);
}

interface PetGallerySectionProps {
  installedIds: readonly string[];
  onInstalled: () => Promise<void>;
}

export function PetGallerySection({ installedIds, onInstalled }: PetGallerySectionProps) {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [gallery, setGallery] = useState<GalleryPage>(emptyPage);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [quarantining, setQuarantining] = useState<string | null>(null);
  const [previewFallbacks, setPreviewFallbacks] = useState<Record<string, string>>({});

  useEffect(() => {
    const timer = globalThis.setTimeout(() => { setQuery(searchInput); setPage(1); }, 300);
    return () => globalThis.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(false);
    void fetchPetGallery(query, page).then((response) => {
      if (active) setGallery(normalizeGalleryResponse(response));
    }).catch(() => {
      if (active) { setGallery(emptyPage); setError(true); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, query]);

  const pageCount = Math.max(1, Math.ceil(gallery.total / 24));
  const displayedPets = useMemo(() => gallery.pets.filter((pet) => pet.id), [gallery.pets]);

  const loadPreviewFallback = async (pet: GalleryPet) => {
    if (!pet.previewUrl || previewFallbacks[pet.id]) return;
    try {
      const dataUrl = await fetchPetPreview(pet.previewUrl);
      setPreviewFallbacks((current) => ({ ...current, [pet.id]: dataUrl }));
    } catch { /* Keep the card usable if the preview cannot be loaded. */ }
  };

  const install = async (id: string) => {
    setInstalling(id);
    try {
      await installPetFromGallery(id);
      await onInstalled();
    } catch (installError) {
      console.warn("[pets] Gallery install failed", installError);
      useToastStore.getState().pushToast(petSettingsStrings.galleryInstallError, "error");
    } finally {
      setInstalling(null);
    }
  };

  const quarantine = async (id: string) => {
    setQuarantining(id);
    try {
      await quarantinePet(id);
      await onInstalled();
    } catch (quarantineError) {
      console.warn("[pets] Gallery quarantine failed", quarantineError);
    } finally {
      setQuarantining(null);
    }
  };

  return <section>
    <div style={sectionHeadingStyle}>{petSettingsStrings.galleryTitle}</div>
    <div style={{ margin: "-4px 0 10px", color: "var(--cmux-text-dim)", fontSize: 11, lineHeight: 1.5 }}>{petSettingsStrings.galleryHint}</div>
    <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder={petSettingsStrings.gallerySearchPlaceholder} style={{ boxSizing: "border-box", width: "100%", marginBottom: 8 }} />
    {error && <div style={{ color: "var(--cmux-text)", fontSize: 11, marginBottom: 8 }}>{petSettingsStrings.galleryError}</div>}
    {!loading && !error && displayedPets.length === 0 && <div style={{ color: "var(--cmux-text-dim)", fontSize: 11 }}>{petSettingsStrings.galleryEmpty}</div>}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
      {displayedPets.map((pet) => {
        const installed = installedIds.includes(`external:${pet.id}`);
        const preview = previewFallbacks[pet.id] ?? pet.previewUrl;
        return <article key={pet.id} style={{ border: "1px solid var(--cmux-border)", borderRadius: 7, padding: 8, minWidth: 0 }}>
          {preview && <img src={preview} alt="" onError={() => void loadPreviewFallback(pet)} style={{ display: "block", width: "100%", height: 88, objectFit: "contain" }} />}
          <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 4 }}>{pet.displayName || pet.id}</div>
          <div style={{ minHeight: 16, color: "var(--cmux-text-dim)", fontSize: 10 }}>{pet.tags.slice(0, 2).join(" · ")}</div>
          <div style={{ color: "var(--cmux-text-dim)", fontSize: 10 }}>♥ {pet.likeCount}{atlasSizeBadge(pet.atlasSize) ? ` · ${atlasSizeBadge(pet.atlasSize)}` : ""}</div>
          <button type="button" style={{ ...dialogButtonStyle, marginTop: 6, width: "100%" }} disabled={installing === pet.id || quarantining === pet.id} onClick={() => void (installed ? quarantine(pet.id) : install(pet.id))}>
            {installed ? petSettingsStrings.galleryQuarantine : installing === pet.id ? petSettingsStrings.galleryInstalling : petSettingsStrings.galleryInstall}
          </button>
        </article>;
      })}
    </div>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, gap: 8 }}>
      <button type="button" style={dialogButtonStyle} disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>{petSettingsStrings.galleryPrev}</button>
      <span style={{ color: "var(--cmux-text-dim)", fontSize: 11 }}>{petSettingsStrings.galleryCount(gallery.total)}</span>
      <button type="button" style={dialogButtonStyle} disabled={page >= pageCount || loading} onClick={() => setPage((current) => current + 1)}>{petSettingsStrings.galleryNext}</button>
    </div>
  </section>;
}
